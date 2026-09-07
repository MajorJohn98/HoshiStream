import { readFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify, parseEnv } from "node:util";
import { isAbsolute, join, posix, win32 } from "node:path";
import { z } from "zod";
import { sourceCheckSchema } from "../source-check-types.ts";
import {
  MAX_TORRENT_BYTES,
  NativeBridgeError,
  type NativeRequest,
} from "./protocol.ts";

const execFileAsync = promisify(execFile);
const label = z
  .string()
  .max(10_000)
  .transform((value) => value.slice(0, 200));
const id = z.string().min(1).max(200);
const entryReference = z.object({
  id,
  name: label,
  type: z.enum(["movie", "series"]),
});
const draftSchema = z.object({
  draftId: z.string().uuid(),
  expiresAt: z.string().datetime(),
  hash: z.string().regex(/^[a-f0-9]{40}$/),
  suggestedName: label.optional(),
  existingEntries: z.array(entryReference).max(2000),
});
const seriesSchema = z.object({
  entries: z
    .array(
      z.object({
        id,
        name: label,
        inspected: z.boolean(),
        sourceCount: z.number().int().nonnegative(),
      }),
    )
    .max(2000),
});
const tagsSchema = z.object({
  tags: z
    .array(
      z.object({
        name: z.string().max(40),
        count: z.number().int().nonnegative(),
      }),
    )
    .max(2000),
});
const checkSchema = z.union([
  sourceCheckSchema.extend({ entryId: id }),
  z.object({
    entryId: id,
    phase: z.literal("unchecked"),
    message: z.string().max(500),
  }),
]);
const episode = {
  season: z.number().int().nonnegative(),
  episode: z.number().int().positive(),
};
const previewSchema = z.object({
  previewId: z.string().uuid(),
  expiresAt: z.string().datetime(),
  entryId: id,
  entryName: label,
  addedEpisodes: z
    .array(z.object({ ...episode, path: z.string().max(16_384) }))
    .max(10_000),
  replacements: z
    .array(
      z.object({
        ...episode,
        previousPath: z.string().max(16_384),
        incomingPath: z.string().max(16_384),
      }),
    )
    .max(10_000),
});
const configIdentity = {
  extensionId: z.string().regex(/^[a-p]{32}$/),
};
const localWindowsPath = z
  .string()
  .max(32_000)
  .refine(
    (path) =>
      /^[a-z]:[\\/]/i.test(path) &&
      !/["<>|?*]/.test(path) &&
      ![...path].some((character) => character.charCodeAt(0) < 32) &&
      !path.slice(2).includes(":"),
  );
const macApp = z
  .string()
  .refine(
    (path) =>
      posix.isAbsolute(path) && !path.includes("\0") && path.endsWith(".app"),
  );
export const hostConfigSchema = z.union([
  z
    .object({
      ...configIdentity,
      version: z.literal(1),
      projectRoot: z.string().refine(isAbsolute),
      appPath: macApp.optional(),
    })
    .strict(),
  z
    .object({
      ...configIdentity,
      version: z.literal(2),
      platform: z.literal("darwin"),
      projectRoot: z.string().refine(posix.isAbsolute),
      appPath: macApp.optional(),
    })
    .strict(),
  z
    .object({
      ...configIdentity,
      version: z.literal(2),
      platform: z.literal("win32"),
      projectRoot: localWindowsPath,
      appPath: localWindowsPath.refine(
        (path) => win32.basename(path).toLowerCase() === "hoshistream.exe",
      ),
    })
    .strict(),
]);
export type HostConfig = z.infer<typeof hostConfigSchema>;

export function isManagementEntryUrl(target: string): boolean {
  if (
    target.length > 4096 ||
    /["\\]/.test(target) ||
    [...target].some((character) => character.charCodeAt(0) <= 32)
  )
    return false;
  try {
    const url = new URL(target);
    const origin = /^http:\/\/127\.0\.0\.1(?::[1-9]\d{0,4})?(?=\/)/.exec(
      target,
    )?.[0];
    return (
      url.protocol === "http:" &&
      url.hostname === "127.0.0.1" &&
      !url.username &&
      !url.password &&
      !url.search &&
      /^\/manage\/[^/]+$/.test(url.pathname) &&
      /^#\/entry\/[^/]+$/.test(url.hash) &&
      origin !== undefined &&
      origin + url.pathname + url.hash === target
    );
  } catch {
    return false;
  }
}

type Activation =
  | { version: 1; command: "openLibrary" }
  | { version: 1; command: "openUrl"; url: string };
export type NativeLauncher = (
  file: string,
  args: string[],
  input: string,
) => Promise<void>;

const launchNative: NativeLauncher = (file, args, input) =>
  new Promise((resolve, reject) => {
    const child = execFile(
      file,
      args,
      {
        windowsHide: true,
        timeout: 15_000,
        maxBuffer: 1024,
      },
      (error) => {
        if (error)
          reject(
            new NativeBridgeError(
              "app_start_failed",
              "HoshiStream could not be opened. Open the desktop app manually, then retry.",
            ),
          );
        else resolve();
      },
    );
    child.stdin?.on("error", () =>
      reject(
        new NativeBridgeError(
          "app_start_failed",
          "The desktop activation helper closed before accepting the request.",
        ),
      ),
    );
    child.stdin?.end(input);
  });

export function nativeOpener(
  config: HostConfig,
  platform: NodeJS.Platform = process.platform,
  launch: NativeLauncher = launchNative,
): (target: string) => Promise<void> {
  if (config.version !== 2 || config.platform === "darwin") {
    return async (target) => {
      if (platform !== "darwin")
        throw new NativeBridgeError(
          "manual_start_required",
          "Register the Chrome helper from the installed HoshiStream desktop app.",
        );
      await execFileAsync("/usr/bin/open", [target]);
    };
  }
  return async (target) => {
    if (platform !== "win32")
      throw new NativeBridgeError(
        "manual_start_required",
        "This Chrome helper belongs to a Windows installation.",
      );
    let activation: Activation;
    if (target === config.appPath)
      activation = { version: 1, command: "openLibrary" };
    else if (isManagementEntryUrl(target))
      activation = { version: 1, command: "openUrl", url: target };
    else
      throw new NativeBridgeError(
        "invalid_open_target",
        "Only a local HoshiStream entry can be opened.",
      );
    // The helper sends navigation over the verified current-user tray pipe. Cold
    // starts use Explorer with nonsecret arguments to escape Chrome's Windows job.
    await launch(
      win32.join(
        win32.dirname(config.appPath),
        "native-host",
        "HoshiStream.NativeHost.exe",
      ),
      ["--activate"],
      JSON.stringify(activation),
    );
  };
}
const entrySchema = z
  .object({
    id: z.string().min(1).max(200),
    name: z.string().max(10_000),
    type: z.enum(["movie", "series"]),
    tags: z.array(z.string()).optional(),
    sourceCheck: sourceCheckSchema.optional(),
    searchImport: z.object({ hash: z.string() }).passthrough().optional(),
    sourceHash: z.string().optional(),
    extraSources: z
      .array(
        z
          .object({
            sourceHash: z.string().optional(),
            searchImport: z
              .object({ hash: z.string() })
              .passthrough()
              .optional(),
          })
          .passthrough(),
      )
      .optional(),
    inspectionCache: z
      .object({
        selectedFiles: z.array(
          z
            .object({
              id: z.number().int().nonnegative(),
              hash: z.string().optional(),
            })
            .passthrough(),
        ),
      })
      .passthrough()
      .optional(),
  })
  .passthrough();

function summary(value: unknown) {
  const entry = entrySchema.parse(value);
  const hash =
    entry.extraSources?.at(-1)?.sourceHash ??
    entry.extraSources?.at(-1)?.searchImport?.hash;
  const fileId =
    (hash
      ? entry.inspectionCache?.selectedFiles.find((file) => file.hash === hash)
          ?.id
      : undefined) ??
    entry.sourceCheck?.fileId ??
    entry.inspectionCache?.selectedFiles[0]?.id;
  return {
    id: entry.id,
    name: entry.name.slice(0, 200),
    type: entry.type,
    tags: entry.tags,
    sourceCheck: entry.sourceCheck,
    checkFileId: fileId,
  };
}

export type NativeActions = {
  open?: (target: string) => Promise<void>;
  fetch?: typeof fetch;
  platform?: NodeJS.Platform;
  launch?: NativeLauncher;
};

export class NativeClient {
  private readonly config: HostConfig;
  private readonly request: typeof fetch;
  private readonly open: (target: string) => Promise<void>;
  private token = "";
  private base = "";

  constructor(config: HostConfig, actions: NativeActions = {}) {
    this.config = hostConfigSchema.parse(config);
    this.request = actions.fetch ?? fetch;
    this.open =
      actions.open ??
      nativeOpener(this.config, actions.platform, actions.launch);
  }

  private async settings() {
    let environment: NodeJS.ProcessEnv;
    try {
      environment = parseEnv(
        await readFile(join(this.config.projectRoot, ".env"), "utf8"),
      );
    } catch {
      throw new NativeBridgeError(
        "app_not_initialized",
        "Open HoshiStream once to finish its setup.",
      );
    }
    const port = Number(environment.ADDON_PORT ?? 7001);
    const token = environment.ACCESS_TOKEN;
    if (
      !Number.isInteger(port) ||
      port < 1 ||
      port > 65535 ||
      !token ||
      token.length < 20 ||
      token.startsWith("replace-with")
    )
      throw new NativeBridgeError(
        "app_not_initialized",
        "Open HoshiStream once to finish its setup.",
      );
    this.token = token;
    this.base = `http://127.0.0.1:${port}`;
  }

  private async api(
    path: string,
    method = "GET",
    body?: unknown,
    bytes?: Buffer,
  ): Promise<unknown> {
    let response: Response;
    try {
      response = await this.request(this.base + "/api/" + path, {
        method,
        headers: {
          authorization: "Bearer " + this.token,
          ...(bytes
            ? { "content-type": "application/x-bittorrent" }
            : body !== undefined
              ? { "content-type": "application/json" }
              : {}),
        },
        body: bytes
          ? new Uint8Array(bytes)
          : body === undefined
            ? undefined
            : JSON.stringify(body),
        redirect: "error",
        signal: AbortSignal.timeout(
          path === "imports/series-preview" ? 60_000 : 15_000,
        ),
      });
    } catch {
      throw new NativeBridgeError(
        "app_unavailable",
        "HoshiStream could not be reached. Open the app and retry the same request.",
      );
    }
    if (response.status === 204) return {};
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      const reader = response.body?.getReader();
      if (!reader) throw new Error("Empty response");
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.length;
        if (size > 1_000_000) {
          await reader.cancel();
          throw new Error("Oversized response");
        }
        chunks.push(value);
      }
      const result: unknown = JSON.parse(
        Buffer.concat(chunks).toString("utf8"),
      );
      if (!response.ok) {
        const error = z
          .object({
            error: z.string().max(1000),
            code: z.string().max(100).optional(),
          })
          .safeParse(result);
        throw new NativeBridgeError(
          error.success
            ? (error.data.code ?? "app_request_failed")
            : "app_request_failed",
          error.success
            ? this.redact(error.data.error)
            : "HoshiStream could not complete this request.",
          response.status,
        );
      }
      return result;
    } catch (error) {
      if (error instanceof NativeBridgeError) throw error;
      throw new NativeBridgeError(
        "invalid_app_response",
        "HoshiStream returned an unreadable response. Retry the same request.",
      );
    }
  }

  redact(value: string): string {
    return (
      this.token
        ? value
            .split(this.token)
            .join("[redacted]")
            .split(encodeURIComponent(this.token))
            .join("[redacted]")
        : value
    )
      .replace(/magnet:\?\S+/gi, "[redacted source]")
      .replace(/Bearer\s+\S+/gi, "Bearer [redacted]");
  }

  async status() {
    try {
      await this.settings();
      const caps = z
        .object({
          version: z.literal(1),
          maxTorrentBytes: z.number().int().positive(),
        })
        .safeParse(await this.api("imports/capabilities"));
      if (!caps.success)
        throw new NativeBridgeError(
          "app_update_required",
          "Update HoshiStream to use this companion.",
        );
      let engineReady = false;
      try {
        engineReady = (
          await this.request(this.base + "/ready", {
            signal: AbortSignal.timeout(2000),
            redirect: "error",
          })
        ).ok;
      } catch {
        /* Status below remains explicit; saving does not require the engine. */
      }
      return {
        connected: true,
        appRunning: true,
        engineReady,
        canStartApp: Boolean(this.config.appPath),
      };
    } catch (error) {
      if (
        error instanceof NativeBridgeError &&
        (error.status === 404 || error.code === "app_update_required")
      )
        return {
          connected: false,
          appRunning: true,
          engineReady: false,
          canStartApp: Boolean(this.config.appPath),
          message:
            "Update HoshiStream to a version that supports this Chrome companion.",
        };
      return {
        connected: false,
        appRunning: false,
        engineReady: false,
        canStartApp: Boolean(this.config.appPath),
        message:
          error instanceof NativeBridgeError
            ? error.message
            : "Open or update HoshiStream, then retry.",
      };
    }
  }

  private async commitResult(value: unknown, checkAfterSave: boolean) {
    const result = z
      .object({
        entry: z.unknown(),
        outcome: z.enum(["created", "existing", "appended"]),
      })
      .parse(value);
    const entry = summary(result.entry);
    let check;
    let checkError;
    if (
      checkAfterSave &&
      (result.outcome !== "existing" || !entry.sourceCheck)
    ) {
      try {
        check = checkSchema.parse(
          await this.api(
            `library/${encodeURIComponent(entry.id)}/check`,
            "POST",
            {
              probe: true,
              ...(entry.checkFileId === undefined
                ? {}
                : { fileId: entry.checkFileId }),
            },
          ),
        );
      } catch (error) {
        checkError = {
          code:
            error instanceof NativeBridgeError
              ? error.code
              : "check_unavailable",
          message:
            error instanceof NativeBridgeError
              ? error.message
              : "Saved, but the check could not start. Retry the check from the app.",
        };
      }
    }
    return {
      entry,
      outcome: result.outcome,
      ...(check ? { check } : {}),
      ...(checkError ? { checkError } : {}),
    };
  }

  async handle(message: NativeRequest): Promise<unknown> {
    if (message.command === "status") return this.status();
    if (message.command === "startApp") {
      if (!this.config.appPath)
        throw new NativeBridgeError(
          "manual_start_required",
          "Start the local development server, then retry.",
        );
      try {
        await this.open(this.config.appPath);
      } catch {
        throw new NativeBridgeError(
          "app_start_failed",
          "HoshiStream could not be opened. Open it manually, then retry.",
        );
      }
      const deadline = Date.now() + 20_000;
      let status = await this.status();
      while (!status.connected && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 500));
        status = await this.status();
      }
      return status;
    }
    await this.settings();
    switch (message.command) {
      case "tags":
        return tagsSchema.parse(await this.api("tags"));
      case "series":
        return seriesSchema.parse(await this.api("imports/series"));
      case "prepareMagnet":
        return draftSchema.parse(
          await this.api("imports/prepare", "POST", message.payload),
        );
      case "prepareTorrent": {
        const encoded = message.payload.bytesBase64;
        const bytes = Buffer.from(encoded, "base64");
        if (
          !bytes.length ||
          bytes.length > MAX_TORRENT_BYTES ||
          bytes.toString("base64") !== encoded
        )
          throw new NativeBridgeError(
            "invalid_torrent",
            "Choose a valid .torrent file no larger than 1 MB.",
          );
        return draftSchema.parse(
          await this.api("imports/prepare-torrent", "POST", undefined, bytes),
        );
      }
      case "discardDraft":
        return this.api(
          "imports/drafts/" + encodeURIComponent(message.payload.draftId),
          "DELETE",
        );
      case "createEntry": {
        const { checkAfterSave, ...input } = message.payload;
        return this.commitResult(
          await this.api("imports/commit", "POST", input),
          checkAfterSave,
        );
      }
      case "previewSeries":
        return previewSchema.parse(
          await this.api("imports/series-preview", "POST", message.payload),
        );
      case "commitSeries": {
        const { checkAfterSave, ...input } = message.payload;
        return this.commitResult(
          await this.api("imports/series-commit", "POST", input),
          checkAfterSave,
        );
      }
      case "discardPreview":
        return this.api(
          "imports/previews/" + encodeURIComponent(message.payload.previewId),
          "DELETE",
        );
      case "getCheck":
        return checkSchema.parse(
          await this.api(
            "library/" + encodeURIComponent(message.payload.entryId) + "/check",
          ),
        );
      case "cancelCheck":
        return checkSchema.parse(
          await this.api(
            "library/" + encodeURIComponent(message.payload.entryId) + "/check",
            "DELETE",
          ),
        );
      case "startCheck":
        return checkSchema.parse(
          await this.api(
            "library/" + encodeURIComponent(message.payload.entryId) + "/check",
            "POST",
            {
              probe: true,
              ...(message.payload.mode === undefined
                ? {}
                : { mode: message.payload.mode }),
              ...(message.payload.fileId === undefined
                ? {}
                : { fileId: message.payload.fileId }),
            },
          ),
        );
      case "openEntry": {
        const entry = summary(
          await this.api(
            "library/" + encodeURIComponent(message.payload.entryId),
          ),
        );
        await this.open(
          this.base +
            "/manage/" +
            encodeURIComponent(this.token) +
            "#/entry/" +
            encodeURIComponent(entry.id),
        );
        return {};
      }
    }
  }
}
