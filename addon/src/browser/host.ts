import { readFile } from "node:fs/promises";
import { endianness } from "node:os";
import { pathToFileURL } from "node:url";
import type { Readable, Writable } from "node:stream";
import { z } from "zod";
import {
  NativeClient,
  hostConfigSchema,
  type HostConfig,
  type NativeActions,
} from "./client.ts";
import {
  MAX_NATIVE_INPUT,
  MAX_NATIVE_OUTPUT,
  NativeBridgeError,
  nativeRequestSchema,
  type NativeResponse,
} from "./protocol.ts";

const littleEndian = endianness() === "LE";
const utf8 = new TextDecoder("utf-8", { fatal: true });

export function allowedOrigin(origin: string, extensionId: string): boolean {
  return (
    /^chrome-extension:\/\/([a-p]{32})\/?$/.exec(origin)?.[1] === extensionId
  );
}

export function nativeFrame(value: unknown): Buffer {
  const body = Buffer.from(JSON.stringify(value), "utf8");
  if (body.length > MAX_NATIVE_OUTPUT)
    throw new NativeBridgeError(
      "response_too_large",
      "This response is too large. Continue in HoshiStream.",
    );
  const header = Buffer.alloc(4);
  if (littleEndian) header.writeUInt32LE(body.length);
  else header.writeUInt32BE(body.length);
  return Buffer.concat([header, body]);
}

function redact(value: unknown, client: NativeClient): unknown {
  if (typeof value === "string") return client.redact(value);
  if (Array.isArray(value)) return value.map((item) => redact(item, client));
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, redact(item, client)]),
    );
  return value;
}

async function write(output: Writable, response: NativeResponse) {
  let frame: Buffer;
  try {
    frame = nativeFrame(response);
  } catch {
    frame = nativeFrame({
      version: 1,
      id: response.id,
      ok: false,
      error: {
        code: "response_too_large",
        message: "This response is too large. Continue in HoshiStream.",
      },
    });
  }
  await new Promise<void>((resolve, reject) => {
    const failed = (error: Error) => reject(error);
    output.once("error", failed);
    output.write(frame, (error) => {
      if (error) {
        reject(error);
        return;
      }
      output.off("error", failed);
      resolve();
    });
  });
}

export async function runNativeHost(
  config: HostConfig,
  origin: string,
  input: Readable,
  output: Writable,
  actions: NativeActions = {},
): Promise<void> {
  if (!allowedOrigin(origin, config.extensionId))
    throw new NativeBridgeError(
      "unauthorized_origin",
      "This extension is not allowed to use the HoshiStream helper.",
    );
  const client = new NativeClient(config, actions);
  let buffered = Buffer.alloc(0);
  for await (const chunk of input) {
    if (buffered.length + chunk.length > 2 * MAX_NATIVE_INPUT + 8)
      throw new NativeBridgeError(
        "invalid_frame",
        "Native message buffer limit exceeded.",
      );
    buffered = Buffer.concat([buffered, Buffer.from(chunk)]);
    while (buffered.length >= 4) {
      const length = littleEndian
        ? buffered.readUInt32LE(0)
        : buffered.readUInt32BE(0);
      if (length < 2 || length > MAX_NATIVE_INPUT)
        throw new NativeBridgeError(
          "invalid_frame",
          "Native message length is invalid.",
        );
      if (buffered.length < length + 4) break;
      const bytes = buffered.subarray(4, length + 4);
      buffered = buffered.subarray(length + 4);
      let raw: unknown;
      try {
        raw = JSON.parse(utf8.decode(bytes));
      } catch {
        throw new NativeBridgeError(
          "invalid_frame",
          "Native message encoding is invalid.",
        );
      }
      const parsed = nativeRequestSchema.safeParse(raw);
      if (!parsed.success) {
        const id = z.object({ id: z.string().uuid() }).safeParse(raw);
        if (!id.success)
          throw new NativeBridgeError(
            "invalid_frame",
            "Native message identifier is invalid.",
          );
        await write(output, {
          version: 1,
          id: id.data.id,
          ok: false,
          error: {
            code: "invalid_request",
            message:
              "The companion request is invalid. Update the extension and retry.",
          },
        });
        continue;
      }
      let response: NativeResponse;
      try {
        response = {
          version: 1,
          id: parsed.data.id,
          ok: true,
          data: redact(await client.handle(parsed.data), client),
        };
      } catch (error) {
        const uncertain =
          !(error instanceof NativeBridgeError) ||
          (error.status !== undefined && error.status >= 500) ||
          ["app_unavailable", "invalid_app_response"].includes(error.code);
        response = {
          version: 1,
          id: parsed.data.id,
          ok: false,
          error: {
            code:
              error instanceof NativeBridgeError
                ? error.code
                : "invalid_app_response",
            message:
              error instanceof NativeBridgeError
                ? client.redact(error.message)
                : "HoshiStream could not confirm the outcome. Retry the same request.",
            retryable: uncertain,
            uncertain,
          },
        };
      }
      await write(output, response);
    }
  }
  if (buffered.length)
    throw new NativeBridgeError(
      "invalid_frame",
      "Native message ended before its declared length.",
    );
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const [path, origin, ...extra] = process.argv.slice(2);
  void (async () => {
    if (!path || !origin || extra.length)
      throw new Error("Invalid native launch");
    const bytes = await readFile(path);
    if (bytes.length > 64_000) throw new Error("Invalid native configuration");
    const config = hostConfigSchema.parse(JSON.parse(bytes.toString("utf8")));
    await runNativeHost(config, origin, process.stdin, process.stdout);
  })().catch(() => {
    process.stderr.write(
      '{"level":"error","event":"browser_native_host_failed"}\n',
    );
    process.exitCode = 1;
  });
}
