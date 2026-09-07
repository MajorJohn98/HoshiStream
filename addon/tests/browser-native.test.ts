import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir, endianness } from "node:os";
import { randomUUID } from "node:crypto";
import { Readable, Writable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NativeClient } from "../src/browser/client.ts";
import {
  allowedOrigin,
  nativeFrame,
  runNativeHost,
} from "../src/browser/host.ts";
import {
  nativeRequestSchema,
  MAX_NATIVE_INPUT,
} from "../src/browser/protocol.ts";

const extensionId = "haijooeeommbnonlnkmcihmcgjmbfjgo";
const token = "a-private-native-test-token";
const entryId = "hoshi:" + randomUUID();
const draftId = randomUUID();
let root: string;
let fetcher: ReturnType<typeof vi.fn<typeof fetch>>;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "hoshi-native-"));
  await writeFile(
    join(root, ".env"),
    `ADDON_PORT=7001\nACCESS_TOKEN=${token}\n`,
    { mode: 0o600 },
  );
  fetcher = vi.fn<typeof fetch>().mockImplementation(async (url) => {
    const path = new URL(String(url)).pathname;
    const value = path.endsWith("/capabilities")
      ? { version: 1, maxTorrentBytes: 1_000_000 }
      : path.endsWith("/commit")
        ? {
            outcome: "created",
            entry: {
              id: entryId,
              name: "Native fixture",
              type: "movie",
              magnetUri: "magnet:?xt=private",
              torrentFilePath: "/private/source.torrent",
            },
          }
        : path.includes("/library/")
          ? { id: entryId, name: "Native fixture", type: "movie" }
          : { status: "ok" };
    return new Response(JSON.stringify(value), {
      headers: { "content-type": "application/json" },
    });
  });
});

afterEach(async () => {
  await rm(root, { recursive: true });
  vi.restoreAllMocks();
});

function message(command: string, payload = {}) {
  return { version: 1, id: randomUUID(), command, payload };
}
function config() {
  return { version: 1 as const, extensionId, projectRoot: root };
}
function inputFrame(value: unknown) {
  const data = Buffer.from(JSON.stringify(value));
  const header = Buffer.alloc(4);
  if (endianness() === "LE") header.writeUInt32LE(data.length);
  else header.writeUInt32BE(data.length);
  return Buffer.concat([header, data]);
}
function responses(data: Buffer) {
  const messages = [];
  while (data.length) {
    const size =
      endianness() === "LE" ? data.readUInt32LE(0) : data.readUInt32BE(0);
    messages.push(JSON.parse(data.subarray(4, size + 4).toString("utf8")));
    data = data.subarray(size + 4);
  }
  return messages;
}
async function host(
  chunks: Buffer[],
  origin = `chrome-extension://${extensionId}/`,
) {
  const output: Buffer[] = [];
  await runNativeHost(
    config(),
    origin,
    Readable.from(chunks),
    new Writable({
      write(chunk, _encoding, callback) {
        output.push(Buffer.from(chunk));
        callback();
      },
    }),
    { fetch: fetcher },
  );
  return responses(Buffer.concat(output));
}

describe("native command boundary", () => {
  it("permits only the exact extension origin", () => {
    expect(
      allowedOrigin(`chrome-extension://${extensionId}/`, extensionId),
    ).toBe(true);
    expect(allowedOrigin(`https://${extensionId}/`, extensionId)).toBe(false);
    expect(
      allowedOrigin(`chrome-extension://${extensionId}.evil/`, extensionId),
    ).toBe(false);
    expect(
      allowedOrigin(`chrome-extension://${"a".repeat(32)}/`, extensionId),
    ).toBe(false);
  });

  it("rejects arbitrary commands, paths, URLs and extra fields", () => {
    for (const input of [
      message("fetch", { url: "http://127.0.0.1/admin" }),
      message("startApp", { appPath: "/private/other.app" }),
      message("prepareTorrent", {
        bytesBase64: "YQ==",
        fileName: "../../file.torrent",
      }),
      { ...message("status"), accessToken: "forged" },
    ])
      expect(nativeRequestSchema.safeParse(input).success).toBe(false);
  });

  it("rejects an unauthorized origin before reading local credentials", async () => {
    await expect(
      host([inputFrame(message("status"))], "https://example.org/"),
    ).rejects.toMatchObject({ code: "unauthorized_origin" });
    expect(fetcher).not.toHaveBeenCalled();
  });
});

describe("native framing", () => {
  it("handles split headers/payloads and multiple messages without stray stdout", async () => {
    const one = message("status");
    const two = message("status");
    const data = Buffer.concat([inputFrame(one), inputFrame(two)]);
    const report = await host([
      data.subarray(0, 2),
      data.subarray(2, 17),
      data.subarray(17),
    ]);
    expect(report).toHaveLength(2);
    expect(report.map((value) => value.id)).toEqual([one.id, two.id]);
    expect(report[0]).toMatchObject({
      version: 1,
      ok: true,
      data: { connected: true, engineReady: true },
    });
    expect(JSON.stringify(report)).not.toContain(token);
  });

  it("rejects oversized and truncated input", async () => {
    const header = Buffer.alloc(4);
    if (endianness() === "LE") header.writeUInt32LE(MAX_NATIVE_INPUT + 1);
    else header.writeUInt32BE(MAX_NATIVE_INPUT + 1);
    await expect(host([header])).rejects.toMatchObject({
      code: "invalid_frame",
    });
    await expect(
      host([inputFrame(message("status")).subarray(0, 8)]),
    ).rejects.toMatchObject({ code: "invalid_frame" });
    expect(() => nativeFrame({ data: "x".repeat(1_000_001) })).toThrow();
  });

  it("returns a correlated error for an invalid command instead of executing it", async () => {
    const request = message("execute", { command: "ignored" });
    expect(await host([inputFrame(request)])).toMatchObject([
      { id: request.id, ok: false, error: { code: "invalid_request" } },
    ]);
    expect(fetcher).not.toHaveBeenCalled();
  });
});

describe("native management relay", () => {
  it("redacts both literal and URL-encoded local tokens", async () => {
    const specialToken = "private/token+with-reserved-characters";
    await writeFile(join(root, ".env"), `ACCESS_TOKEN=${specialToken}\n`);
    const client = new NativeClient(config(), { fetch: fetcher });
    await client.status();
    expect(
      client.redact(
        `${specialToken} http://127.0.0.1:7001/manage/${encodeURIComponent(specialToken)} magnet:?xt=private`,
      ),
    ).toBe(
      "[redacted] http://127.0.0.1:7001/manage/[redacted] [redacted source]",
    );
  });

  it("uses only locally read authentication and strips private entry fields", async () => {
    const request = nativeRequestSchema.parse(
      message("createEntry", {
        draftId,
        name: "Native fixture",
        type: "movie",
        idempotencyKey: randomUUID(),
        checkAfterSave: false,
      }),
    );
    const report = await new NativeClient(config(), { fetch: fetcher }).handle(
      request,
    );
    expect(report).toMatchObject({
      outcome: "created",
      entry: { id: entryId, name: "Native fixture" },
    });
    expect(JSON.stringify(report)).not.toMatch(
      /magnet:|\/private\/|accessToken/,
    );
    const [url, options] = fetcher.mock.calls[0];
    expect(url).toBe("http://127.0.0.1:7001/api/imports/commit");
    expect(new Headers(options?.headers).get("authorization")).toBe(
      "Bearer " + token,
    );
    expect(JSON.parse(String(options?.body))).not.toHaveProperty(
      "checkAfterSave",
    );
  });

  it("keeps successful saves successful if the follow-up check cannot start", async () => {
    fetcher.mockImplementation(async (url) =>
      new URL(String(url)).pathname.endsWith("/check")
        ? new Response(
            JSON.stringify({
              error: "Check unavailable",
              code: "check_unavailable",
            }),
            { status: 503 },
          )
        : new Response(
            JSON.stringify({
              outcome: "created",
              entry: { id: entryId, name: "Fixture", type: "movie" },
            }),
          ),
    );
    const report = await new NativeClient(config(), { fetch: fetcher }).handle(
      nativeRequestSchema.parse(
        message("createEntry", {
          draftId,
          name: "Fixture",
          type: "movie",
          idempotencyKey: randomUUID(),
          checkAfterSave: true,
        }),
      ),
    );
    expect(report).toMatchObject({
      outcome: "created",
      checkError: { code: "check_unavailable" },
    });
  });

  it("uploads only explicitly supplied torrent bytes, never a browser filesystem path", async () => {
    fetcher.mockResolvedValue(
      new Response(
        JSON.stringify({
          draftId,
          expiresAt: new Date().toISOString(),
          hash: "a".repeat(40),
          existingEntries: [],
        }),
      ),
    );
    const request = nativeRequestSchema.parse(
      message("prepareTorrent", {
        bytesBase64: "YQ==",
        fileName: "fixture.torrent",
      }),
    );
    await new NativeClient(config(), { fetch: fetcher }).handle(request);
    expect(fetcher.mock.calls[0][0]).toBe(
      "http://127.0.0.1:7001/api/imports/prepare-torrent",
    );
    expect(
      Buffer.from(fetcher.mock.calls[0][1]?.body as Uint8Array).toString(),
    ).toBe("a");
  });

  it("opens only the locally constructed entry link and returns no token", async () => {
    const open = vi.fn().mockResolvedValue(undefined);
    const request = nativeRequestSchema.parse(
      message("openEntry", { entryId }),
    );
    const report = await new NativeClient(config(), {
      fetch: fetcher,
      open,
    }).handle(request);
    expect(report).toEqual({});
    expect(open.mock.calls[0][0]).toContain(
      "#/entry/" + encodeURIComponent(entryId),
    );
    expect(open.mock.calls[0][0]).toContain("/manage/" + token);
  });

  it("cannot launch arbitrary applications from messages", async () => {
    const open = vi.fn();
    await expect(
      new NativeClient(config(), { fetch: fetcher, open }).handle(
        nativeRequestSchema.parse(message("startApp")),
      ),
    ).rejects.toMatchObject({ code: "manual_start_required" });
    expect(open).not.toHaveBeenCalled();
  });
});
