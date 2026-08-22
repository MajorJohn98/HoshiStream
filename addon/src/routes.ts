import type { IncomingMessage, ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { z, ZodError } from "zod";
import { markStreamActivity, recentStreamActivity } from "./activity.js";
import { assessDirectPlay } from "./direct-play.js";
import { inspectEntry, resolveStreamSource } from "./inspection.js";
import type { Library } from "./library.js";
import { managementHtml } from "./management.js";
import { Playback } from "./playback.js";
import { PlayerError } from "./player.js";
import { probeMedia } from "./media-probe.js";
import {
  listLocalMedia,
  inspectLocalEntry,
  isManagedMediaPath,
  removeManagedMedia,
  saveTorrentUpload,
  saveUpload,
  serveLocalMedia,
  validateBrowserLocalPath,
} from "./local-media.js";
import {
  NativePicker,
  PickerCancelledError,
  PickerUnavailableError,
} from "./native-picker.js";
import { bearerToken, validToken } from "./security.js";
import type { AddonInterface } from "./server-types.js";
import {
  getStreams,
  resolveClientAwareUrls,
  resolvePublicUrls,
  type PublicUrls,
} from "./streams.js";
import { ownPublicIp } from "./public-ip.js";
import {
  repairTier,
  TranscodeBusyError,
  type TranscodeManager,
} from "./transcode.js";
import type { TorrServerClient } from "./torrserver-client.js";
import { createEntrySchema, patchEntrySchema } from "./types.js";

const JSON_HEADERS = {
  "access-control-allow-origin": "*",
  "content-type": "application/json; charset=utf-8",
};
const catalogResponseSchema = z.object({ metas: z.array(z.unknown()) });
const playRequestSchema = z.object({
  entryId: z.string().min(1),
  fileId: z.number().int().nonnegative().optional(),
});
const playerControlSchema = z.object({
  action: z.enum(["pause", "resume", "stop", "seek"]),
  value: z.number().nonnegative().optional(),
});

export function technicalProbeRequested(url: URL): boolean {
  return url.searchParams.get("probe") === "true";
}

export function noStoreProtocolResource(resource: string): boolean {
  return ["catalog", "meta", "stream"].includes(resource);
}

function reply(response: ServerResponse, status: number, value: unknown): void {
  response.writeHead(status, JSON_HEADERS);
  response.end(status === 204 ? undefined : JSON.stringify(value));
}

function noStoreReply(
  response: ServerResponse,
  status: number,
  value: unknown,
): void {
  response.writeHead(status, {
    ...JSON_HEADERS,
    "cache-control": "no-store, max-age=0",
  });
  response.end(JSON.stringify(value));
}

function html(response: ServerResponse, value: string): void {
  response.writeHead(200, {
    "content-security-policy":
      "default-src 'self'; img-src 'self' https: data:; script-src 'self'; style-src 'self'",
    "content-type": "text/html; charset=utf-8",
    "referrer-policy": "no-referrer",
    "x-content-type-options": "nosniff",
  });
  response.end(value);
}

const MANAGE_ASSET_TYPES: Record<string, string> = {
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
};

export function manageAssetPath(pathname: string): string | undefined {
  const match =
    /^\/manage-assets\/((?:(?:views|vendor|components)\/)?[a-z0-9-]+\.(?:js|css))$/.exec(
      pathname,
    );
  return match?.[1];
}

async function serveManageAsset(
  response: ServerResponse,
  asset: string,
): Promise<void> {
  const extension = asset.slice(asset.lastIndexOf("."));
  let content: Buffer;
  try {
    content = await readFile(
      new URL(`../assets/manage/${asset}`, import.meta.url),
    );
  } catch {
    response.writeHead(404, JSON_HEADERS);
    response.end(JSON.stringify({ error: "Not found" }));
    return;
  }
  response.writeHead(200, {
    "cache-control": "public, max-age=300",
    "content-type": MANAGE_ASSET_TYPES[extension],
    "x-content-type-options": "nosniff",
  });
  response.end(content);
}

async function body(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 1_000_000) throw new SyntaxError("Request body exceeds 1 MB");
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function protocolPath(pathname: string, token: string): string | undefined {
  const prefix = `/addon/${encodeURIComponent(token)}`;
  return pathname.startsWith(`${prefix}/`)
    ? pathname.slice(prefix.length)
    : undefined;
}

export function createHandler(
  library: Library,
  addon: AddonInterface,
  torrServer: TorrServerClient,
  accessToken: string,
  homeSpeedMbps: number,
  nativePicker: NativePicker,
  publicUrls: PublicUrls,
  lanRedirect: "auto" | "off" = "auto",
  playback = new Playback(library, torrServer),
  transcode?: TranscodeManager,
) {
  return async (request: IncomingMessage, response: ServerResponse) => {
    try {
      const url = new URL(request.url ?? "/", "http://localhost");
      if (url.pathname === "/health")
        return reply(response, 200, { status: "ok" });
      if (
        url.pathname === "/assets/hoshistream-logo.png" &&
        request.method === "GET"
      ) {
        response.writeHead(200, {
          "cache-control": "public, max-age=86400",
          "content-type": "image/png",
        });
        return response.end(
          await readFile(
            new URL(
              "../assets/hoshistream-logo-transparent.png",
              import.meta.url,
            ),
          ),
        );
      }
      const manageAsset = manageAssetPath(url.pathname);
      if (manageAsset && request.method === "GET") {
        return serveManageAsset(response, manageAsset);
      }
      if (url.pathname === "/ready") {
        await Promise.all([library.list(), torrServer.health()]);
        return reply(response, 200, { status: "ready" });
      }

      const addonPath = protocolPath(url.pathname, accessToken);
      if (addonPath === "/manifest.json" && request.method === "GET") {
        return noStoreReply(response, 200, addon.manifest);
      }
      const protocolMatch =
        /^\/(catalog|meta|stream)\/(movie|series)\/([^/]+)(?:\/([^/]+))?\.json$/.exec(
          addonPath ?? "",
        );
      if (protocolMatch && request.method === "GET") {
        const [, resource, type, rawId, rawExtra] = protocolMatch;
        if (resource === "stream") {
          const clientIp = request.headers["cf-connecting-ip"];
          const resolved =
            lanRedirect === "auto" && typeof clientIp === "string"
              ? resolveClientAwareUrls(
                  request.headers,
                  publicUrls,
                  await ownPublicIp(),
                )
              : resolvePublicUrls(request.headers.host, publicUrls);
          const result = await getStreams(
            library,
            torrServer,
            resolved.torrServerUrl,
            resolved.addonUrl,
            accessToken,
            type,
            decodeURIComponent(rawId),
            Boolean(transcode),
          );
          return noStoreReply(response, 200, result);
        }
        const result = await addon.get(
          resource,
          type,
          decodeURIComponent(rawId),
          Object.fromEntries(new URLSearchParams(rawExtra ?? "")),
        );
        return noStoreProtocolResource(resource)
          ? noStoreReply(response, 200, result)
          : reply(response, 200, result);
      }

      if (url.pathname === "/manifest.json") {
        return reply(response, 401, { error: "Use the tokenized add-on URL" });
      }

      // Repaired-stream HLS sessions (ADR 0010). The session starts lazily on
      // the first playlist request and is reaped when segment requests stop.
      const hlsMatch =
        /^\/hls\/([^/]+)\/([^/]+)\/(\d+)\/(index\.m3u8|init\.mp4|seg-\d+\.m4s)$/.exec(
          url.pathname,
        );
      if (
        hlsMatch &&
        ["GET", "HEAD"].includes(request.method ?? "") &&
        transcode &&
        validToken(decodeURIComponent(hlsMatch[1]), accessToken)
      ) {
        const entry = await library.get(decodeURIComponent(hlsMatch[2]));
        const fileId = Number(hlsMatch[3]);
        const asset = hlsMatch[4];
        if (!entry) return reply(response, 404, { error: "Unknown entry" });
        let session = transcode.get(entry.id, fileId);
        if (!session || session.failed) {
          // Entries without a probe verdict default to a remux, which never
          // re-encodes anything.
          const tier = repairTier(entry.directPlay) ?? "remux";
          let input: string | undefined;
          if (entry.localFilePath || entry.localFolderPath) {
            const inspection = await inspectLocalEntry(entry);
            input = inspection?.files.find(
              (file) => file.id === fileId,
            )?.localPath;
          } else {
            const source = await resolveStreamSource(
              entry,
              torrServer,
              library,
            );
            const file = source.selectedFiles.find(
              (candidate) => candidate.id === fileId,
            );
            if (file) input = torrServer.streamUrl(source.hash, file);
          }
          if (!input) return reply(response, 404, { error: "Unknown file" });
          try {
            session = await transcode.ensure({
              entryId: entry.id,
              fileId,
              tier,
              input,
            });
          } catch (error) {
            if (error instanceof TranscodeBusyError)
              return reply(response, 503, { error: error.message });
            throw error;
          }
        }
        transcode.touch(session);
        markStreamActivity();
        if (asset === "index.m3u8") {
          try {
            await transcode.waitForPlaylist(session);
          } catch (error) {
            return reply(response, 502, {
              error: error instanceof Error ? error.message : "Repair failed",
            });
          }
        }
        const content = await transcode.readAsset(session, asset);
        if (!content) return reply(response, 404, { error: "Not found" });
        response.writeHead(200, {
          "content-type":
            asset === "index.m3u8"
              ? "application/vnd.apple.mpegurl"
              : asset === "init.mp4"
                ? "video/mp4"
                : "video/iso.segment",
          "content-length": content.length,
          "cache-control": asset === "index.m3u8" ? "no-store" : "max-age=60",
          "access-control-allow-origin": "*",
        });
        return response.end(request.method === "HEAD" ? undefined : content);
      }

      const localMatch = /^\/local\/([^/]+)\/([^/]+)(?:\/(\d+))?$/.exec(
        url.pathname,
      );
      if (
        localMatch &&
        ["GET", "HEAD"].includes(request.method ?? "") &&
        validToken(decodeURIComponent(localMatch[1]), accessToken)
      ) {
        const entry = await library.get(decodeURIComponent(localMatch[2]));
        if (entry) {
          markStreamActivity();
          return serveLocalMedia(
            request,
            response,
            entry,
            localMatch[3] === undefined ? undefined : Number(localMatch[3]),
          );
        }
      }

      const managementMatch = /^\/manage\/([^/]+)\/?$/.exec(url.pathname);
      if (
        managementMatch &&
        request.method === "GET" &&
        validToken(decodeURIComponent(managementMatch[1]), accessToken)
      ) {
        return html(response, managementHtml);
      }

      if (url.pathname.startsWith("/api/")) {
        if (
          !validToken(bearerToken(request.headers.authorization), accessToken)
        ) {
          return reply(response, 401, { error: "Unauthorized" });
        }
        const itemMatch = /^\/api\/library\/([^/]+)$/.exec(url.pathname);
        const inspectMatch = /^\/api\/library\/([^/]+)\/inspect$/.exec(
          url.pathname,
        );
        const relinkMatch = /^\/api\/library\/([^/]+)\/relink$/.exec(
          url.pathname,
        );
        const pickerMatch = /^\/api\/native-picker\/(file|folder)$/.exec(
          url.pathname,
        );
        if (url.pathname === "/api/library" && request.method === "GET") {
          return reply(response, 200, await library.list());
        }
        if (
          url.pathname === "/api/stremio-refresh" &&
          request.method === "POST"
        ) {
          const [movieCatalog, seriesCatalog, entries] = await Promise.all([
            addon.get("catalog", "movie", "private-movies", {}),
            addon.get("catalog", "series", "private-series", {}),
            library.list(),
          ]);
          const movies = catalogResponseSchema.parse(movieCatalog).metas.length;
          const series =
            catalogResponseSchema.parse(seriesCatalog).metas.length;
          return noStoreReply(response, 200, {
            movies,
            series,
            total: movies + series,
            updatedAt:
              entries
                .map((entry) => entry.updatedAt)
                .sort()
                .at(-1) ?? null,
          });
        }
        if (url.pathname === "/api/player/play" && request.method === "POST") {
          const value = await body(request);
          const input = playRequestSchema.parse(value);
          const result = await playback.play(input.entryId, input.fileId);
          console.log(
            JSON.stringify({
              level: "info",
              event: "player_started",
              entryId: input.entryId,
              mode: result.mode,
            }),
          );
          return reply(response, 200, result);
        }
        if (
          url.pathname === "/api/player/control" &&
          request.method === "POST"
        ) {
          const value = await body(request);
          const input = playerControlSchema.parse(value);
          await playback.control(input.action, input.value);
          return reply(response, 200, { ok: true });
        }
        if (url.pathname === "/api/player/status" && request.method === "GET") {
          return reply(response, 200, {
            ...(await playback.status()),
            available: await playback.available(),
            preference: playback.preference,
          });
        }
        if (url.pathname === "/api/status" && request.method === "GET") {
          const [entries, torrServerStatus, activeTorrents, pickerAvailable] =
            await Promise.all([
              library.list(),
              torrServer
                .health()
                .then((version) => ({ online: true, version }))
                .catch(() => ({ online: false })),
              torrServer
                .list()
                .then((torrents) => torrents.length)
                .catch(() => 0),
              nativePicker.available(),
            ]);
          return reply(response, 200, {
            status: "online",
            torrServer: torrServerStatus,
            libraryCount: entries.length,
            homeSpeedMbps,
            nativePicker: pickerAvailable,
            streamingActive: recentStreamActivity() || activeTorrents > 0,
            uptimeSeconds: Math.floor(process.uptime()),
          });
        }
        if (url.pathname === "/api/media-files" && request.method === "GET") {
          return reply(response, 200, await listLocalMedia());
        }
        if (url.pathname === "/api/upload" && request.method === "POST") {
          await saveUpload(
            request,
            url.searchParams.get("batch") ?? "",
            url.searchParams.get("path") ?? "",
          );
          return reply(response, 204, null);
        }
        if (
          url.pathname === "/api/torrent-upload" &&
          request.method === "POST"
        ) {
          return reply(response, 201, {
            path: await saveTorrentUpload(
              request,
              url.searchParams.get("batch") ?? "",
              url.searchParams.get("name") ?? "",
            ),
          });
        }
        if (pickerMatch && request.method === "POST") {
          return reply(
            response,
            200,
            await nativePicker.issue(pickerMatch[1] as "file" | "folder"),
          );
        }
        if (url.pathname === "/api/library" && request.method === "POST") {
          const value = await body(request);
          if (!value || typeof value !== "object" || Array.isArray(value))
            throw new SyntaxError("Invalid request");
          const input = { ...(value as Record<string, unknown>) };
          delete input.managedMedia;
          if (typeof input.nativePathGrant === "string") {
            const selected = nativePicker.redeem(input.nativePathGrant);
            delete input.nativePathGrant;
            delete input.localFilePath;
            delete input.localFolderPath;
            input[
              selected.kind === "file" ? "localFilePath" : "localFolderPath"
            ] = selected.path;
          } else {
            if (typeof input.localFilePath === "string") {
              const path = await validateBrowserLocalPath(
                input.localFilePath,
                "file",
              );
              input.localFilePath = path;
              input.managedMedia = await isManagedMediaPath(path);
            }
            if (typeof input.localFolderPath === "string") {
              const path = await validateBrowserLocalPath(
                input.localFolderPath,
                "folder",
              );
              input.localFolderPath = path;
              input.managedMedia = await isManagedMediaPath(path);
            }
            if (typeof input.torrentFilePath === "string") {
              input.managedMedia = await isManagedMediaPath(
                input.torrentFilePath,
              );
            }
          }
          const entry = await library.create(createEntrySchema.parse(input));
          console.log(
            JSON.stringify({
              level: "info",
              event: "library_created",
              entryId: entry.id,
            }),
          );
          return reply(response, 201, entry);
        }
        if (relinkMatch && request.method === "POST") {
          const id = decodeURIComponent(relinkMatch[1]);
          const current = await library.get(id);
          if (!current) return reply(response, 404, { error: "Not found" });
          const kind = current.localFolderPath
            ? "folder"
            : current.localFilePath
              ? "file"
              : undefined;
          if (!kind)
            throw new SyntaxError("Only local entries can be relinked");
          const selected = await nativePicker.select(kind);
          const entry = await library.patch(id, {
            [kind === "file" ? "localFilePath" : "localFolderPath"]: selected,
            managedMedia: false,
          });
          console.log(
            JSON.stringify({
              level: "info",
              event: "library_relinked",
              entryId: id,
            }),
          );
          return reply(response, 200, entry);
        }
        if (inspectMatch && request.method === "POST") {
          const entry = await library.get(decodeURIComponent(inspectMatch[1]));
          if (!entry) return reply(response, 404, { error: "Not found" });
          const inspection = await inspectEntry(entry, torrServer, library);
          const selected = inspection.selectedFiles[0];
          const source = inspection.files.find(
            (file) => file.id === selected?.id,
          ) as { id: number; length: number; localPath?: string } | undefined;
          let technical;
          if (technicalProbeRequested(url) && selected && source) {
            try {
              const input =
                source.localPath ??
                torrServer.streamUrl(inspection.hash, selected);
              technical = await probeMedia(input, source);
              const directPlay = assessDirectPlay(technical, homeSpeedMbps);
              await library.setDirectPlay(entry.id, directPlay).catch(() => {
                console.error(
                  JSON.stringify({
                    level: "warn",
                    event: "direct_play_write_failed",
                    entryId: entry.id,
                  }),
                );
              });
              return reply(response, 200, {
                ...inspection,
                technical,
                directPlay,
                homeSpeedMbps,
              });
            } catch {
              technical = { error: "Media details could not be read" };
            }
          }
          return reply(response, 200, {
            ...inspection,
            technical,
            homeSpeedMbps,
          });
        }
        if (itemMatch && request.method === "GET") {
          const entry = await library.get(decodeURIComponent(itemMatch[1]));
          return reply(
            response,
            entry ? 200 : 404,
            entry ?? { error: "Not found" },
          );
        }
        if (itemMatch && request.method === "PATCH") {
          const value = await body(request);
          if (!value || typeof value !== "object" || Array.isArray(value))
            throw new SyntaxError("Invalid request");
          const patch = { ...(value as Record<string, unknown>) };
          delete patch.managedMedia;
          const input = patchEntrySchema.parse(patch);
          if (input.localFilePath)
            input.localFilePath = await validateBrowserLocalPath(
              input.localFilePath,
              "file",
            );
          if (input.localFolderPath)
            input.localFolderPath = await validateBrowserLocalPath(
              input.localFolderPath,
              "folder",
            );
          const entry = await library.patch(
            decodeURIComponent(itemMatch[1]),
            input,
          );
          if (entry) {
            console.log(
              JSON.stringify({
                level: "info",
                event: "library_updated",
                entryId: entry.id,
              }),
            );
          }
          return reply(
            response,
            entry ? 200 : 404,
            entry ?? { error: "Not found" },
          );
        }
        if (itemMatch && request.method === "DELETE") {
          const id = decodeURIComponent(itemMatch[1]);
          const entry = await library.get(id);
          const removed = await library.remove(id);
          if (removed && entry) await removeManagedMedia(entry);
          if (removed) {
            console.log(
              JSON.stringify({
                level: "info",
                event: "library_deleted",
                entryId: id,
              }),
            );
          }
          return reply(response, removed ? 204 : 404, { error: "Not found" });
        }
      }

      reply(response, 404, { error: "Not found" });
    } catch (error) {
      const clientError =
        error instanceof ZodError ||
        error instanceof SyntaxError ||
        error instanceof PickerCancelledError ||
        error instanceof PlayerError;
      const unavailable = error instanceof PickerUnavailableError;
      console.error(
        JSON.stringify({
          level: "error",
          event: "request_failed",
          method: request.method,
          error: error instanceof Error ? error.message : String(error),
        }),
      );
      reply(response, unavailable ? 503 : clientError ? 400 : 500, {
        error:
          error instanceof PickerCancelledError ||
          error instanceof PickerUnavailableError ||
          error instanceof PlayerError
            ? error.message
            : clientError
              ? "Invalid request"
              : "Internal server error",
      });
    }
  };
}
