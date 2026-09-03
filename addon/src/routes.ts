import type { IncomingMessage, ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { z, ZodError } from "zod";
import { markStreamActivity, recentStreamActivity } from "./activity.js";
import { listClients, recordClient } from "./clients.js";
import { DeviceNames } from "./device-names.js";
import { lookupHostname } from "./hostname.js";
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
import type { PointerClient } from "./pointer.js";
import { bearerToken, validToken } from "./security.js";
import type { AddonInterface } from "./server-types.js";
import {
  getStreams,
  resolveClientAwareUrls,
  resolvePublicUrls,
  type PublicUrls,
} from "./streams.js";
import { ownPublicIp } from "./public-ip.js";
import { resourceReport, type ResourceDirs } from "./resources.js";
import {
  currentSpeed,
  homeSpeedMbps,
  runSpeedTest,
  setConfiguredSpeed,
} from "./speedtest.js";
import {
  repairTier,
  TranscodeBusyError,
  type TranscodeManager,
} from "./transcode.js";
import type { TorrServerClient } from "./torrserver-client.js";
import { createEntrySchema, patchEntrySchema } from "./types.js";
import {
  buildManifest,
  defaultRelativeDir,
  DiskCleanup,
  DiskCopyError,
  computeSourceRevision,
  reconcileFiles,
  removeDiskCopyDirectory,
} from "./disk-copy.js";
import type { Archiver } from "./archiver.js";
import {
  describeWindow,
  formatTime,
  parseTime,
  TIME_PATTERN,
  withinWindow,
  type ArchiveSchedule,
} from "./archive-schedule.js";
import { serveMediaSource } from "./media-source.js";
import { VolumeError, type VolumeRegistry } from "./volumes.js";

const JSON_HEADERS = {
  "access-control-allow-origin": "*",
  "content-type": "application/json; charset=utf-8",
};
const catalogResponseSchema = z.object({ metas: z.array(z.unknown()) });
const clientNameSchema = z.object({
  ip: z.string().min(1).max(64),
  name: z.string().max(60),
});
const playRequestSchema = z.object({
  entryId: z.string().min(1),
  fileId: z.number().int().nonnegative().optional(),
});
const playerControlSchema = z.object({
  action: z.enum(["pause", "resume", "stop", "seek"]),
  value: z.number().nonnegative().optional(),
});
const diskCopyRequestSchema = z.object({
  enabled: z.boolean(),
  volumeId: z.string().min(1).optional(),
  scope: z.enum(["all", "selected"]).optional(),
  includedSourceKeys: z.array(z.string().min(1)).max(10_000).optional(),
  deleteFiles: z.boolean().optional(),
});
const diskScheduleRequestSchema = z
  .object({
    enabled: z.boolean(),
    start: z.string().regex(TIME_PATTERN).optional(),
    end: z.string().regex(TIME_PATTERN).optional(),
  })
  .refine((input) => !input.enabled || (input.start && input.end), {
    message: "start and end are required to enable the window",
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
      // media-src covers direct play from TorrServer's origin; blob: and
      // worker-src blob: cover hls.js's MediaSource playback of repaired
      // streams in the in-browser player.
      "default-src 'self'; img-src 'self' https: data:; script-src 'self'; style-src 'self'; media-src 'self' http: https: blob:; worker-src 'self' blob:",
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

function observeClient(
  request: IncomingMessage,
  resource: Parameters<typeof recordClient>[2],
): void {
  const tunnelIp = request.headers["cf-connecting-ip"];
  const ip =
    (typeof tunnelIp === "string" ? tunnelIp : undefined) ??
    request.socket.remoteAddress ??
    undefined;
  const userAgent = request.headers["user-agent"];
  recordClient(ip, userAgent, resource);
}

export function createHandler(
  library: Library,
  addon: AddonInterface,
  torrServer: TorrServerClient,
  accessToken: string,
  configuredHomeSpeedMbps: number,
  nativePicker: NativePicker,
  publicUrls: PublicUrls,
  lanRedirect: "auto" | "off" = "auto",
  playback = new Playback(library, torrServer),
  transcode?: TranscodeManager,
  resourceDirs?: ResourceDirs,
  pointer?: PointerClient,
  deviceNames?: DeviceNames,
  volumes?: VolumeRegistry,
  diskCleanup?: DiskCleanup,
  archiver?: Archiver,
  archiveSchedule?: ArchiveSchedule,
) {
  setConfiguredSpeed(configuredHomeSpeedMbps);
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
        observeClient(request, "manifest");
        return noStoreReply(response, 200, addon.manifest);
      }
      const protocolMatch =
        /^\/(catalog|meta|stream)\/(movie|series)\/([^/]+)(?:\/([^/]+))?\.json$/.exec(
          addonPath ?? "",
        );
      if (protocolMatch && request.method === "GET") {
        const [, resource, type, rawId, rawExtra] = protocolMatch;
        observeClient(request, resource as "catalog" | "meta" | "stream");
        if (resource === "stream") {
          const clientIp = request.headers["cf-connecting-ip"];
          const ownIp =
            lanRedirect === "auto" && typeof clientIp === "string"
              ? await ownPublicIp()
              : null;
          const resolved = ownIp
            ? resolveClientAwareUrls(request.headers, publicUrls, ownIp)
            : resolvePublicUrls(request.headers.host, publicUrls);
          const result = await getStreams(
            library,
            torrServer,
            resolved.torrServerUrl,
            resolved.addonUrl,
            accessToken,
            type,
            decodeURIComponent(rawId),
            transcode
              ? {
                  videoEncoder: transcode.videoEncoder,
                  videoBitrateMbps: transcode.videoBitrateMbps,
                  // Tunnel requests carry cf-connecting-ip; a mismatch with
                  // this server's public IP means the client is remote.
                  remoteClient: Boolean(
                    typeof clientIp === "string" && ownIp && clientIp !== ownIp,
                  ),
                }
              : undefined,
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
        /^\/hls\/([^/]+)\/([^/]+)\/(\d+)\/(auto|video)\/(index\.m3u8|init\.mp4|seg-\d+\.m4s)$/.exec(
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
        const variant = hlsMatch[4] as "auto" | "video";
        const asset = hlsMatch[5];
        if (!entry) return reply(response, 404, { error: "Unknown entry" });
        let session = transcode.get(entry.id, fileId, variant);
        if (!session || session.failed) {
          // The video variant is the remote lower-bitrate rendition; "auto"
          // follows the probe verdict, defaulting to a copy-only remux.
          const tier =
            variant === "video"
              ? "video"
              : (repairTier(entry.directPlay) ?? "remux");
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
              variant,
              tier,
              input,
            });
          } catch (error) {
            if (error instanceof TranscodeBusyError)
              return reply(response, 503, { error: error.message });
            if (
              error instanceof Error &&
              error.message.includes("video encoder")
            )
              return reply(response, 503, { error: error.message });
            throw error;
          }
        }
        transcode.touch(session);
        markStreamActivity();
        observeClient(request, "playback");
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
          observeClient(request, "playback");
          return serveLocalMedia(
            request,
            response,
            entry,
            localMatch[3] === undefined ? undefined : Number(localMatch[3]),
          );
        }
      }

      // Stable playback URL for disk-copy entries: every range request
      // independently resolves disk vs torrent, so plugging or unplugging a
      // drive changes the source on the client's next request.
      const mediaMatch = /^\/media\/([^/]+)\/([^/]+)\/([0-9a-fA-F]+:\d+)$/.exec(
        url.pathname,
      );
      if (
        mediaMatch &&
        ["GET", "HEAD"].includes(request.method ?? "") &&
        volumes &&
        validToken(decodeURIComponent(mediaMatch[1]), accessToken)
      ) {
        const entry = await library.get(decodeURIComponent(mediaMatch[2]));
        if (entry) {
          markStreamActivity();
          observeClient(request, "playback");
          return serveMediaSource(
            request,
            response,
            entry,
            mediaMatch[3],
            volumes,
            torrServer,
            library,
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
        const volumeMatch = /^\/api\/volumes\/([^/]+)$/.exec(url.pathname);
        const diskCopyMatch = /^\/api\/library\/([^/]+)\/disk-copy$/.exec(
          url.pathname,
        );
        const diskCopyRetryMatch =
          /^\/api\/library\/([^/]+)\/disk-copy\/retry$/.exec(url.pathname);
        if (url.pathname === "/api/volumes" && request.method === "GET") {
          if (!volumes)
            return reply(response, 409, { error: "Volumes unavailable" });
          // Volume polls are the lazy trigger for deferred cleanup: a drive
          // that just came back gets its pending deletions applied here.
          if (diskCleanup) {
            await diskCleanup.sweep(volumes).catch(() => undefined);
          }
          return reply(response, 200, { volumes: await volumes.statusAll() });
        }
        if (url.pathname === "/api/volumes" && request.method === "POST") {
          if (!volumes)
            return reply(response, 409, { error: "Volumes unavailable" });
          const selected = await nativePicker.selectStorage();
          const volume = await volumes.register(selected);
          console.log(
            JSON.stringify({
              level: "info",
              event: "volume_registered",
              volumeId: volume.id,
              label: volume.label,
            }),
          );
          const statuses = await volumes.statusAll();
          return reply(
            response,
            201,
            statuses.find((status) => status.id === volume.id) ?? volume,
          );
        }
        if (volumeMatch && request.method === "DELETE") {
          if (!volumes)
            return reply(response, 409, { error: "Volumes unavailable" });
          const removed = await volumes.forget(
            decodeURIComponent(volumeMatch[1]),
          );
          if (removed) {
            console.log(
              JSON.stringify({
                level: "info",
                event: "volume_forgotten",
                volumeId: decodeURIComponent(volumeMatch[1]),
              }),
            );
          }
          return reply(response, removed ? 204 : 404, { error: "Not found" });
        }
        if (diskCopyMatch && request.method === "PUT") {
          if (!volumes)
            return reply(response, 409, { error: "Volumes unavailable" });
          const id = decodeURIComponent(diskCopyMatch[1]);
          let entry = await library.get(id);
          if (!entry) return reply(response, 404, { error: "Not found" });
          const input = diskCopyRequestSchema.parse(await body(request));
          const current = entry.diskCopy;
          const cleanup = async (volumeId: string, relativeDir: string) => {
            const resolution = await volumes.resolve(volumeId);
            if (resolution.state === "online") {
              await removeDiskCopyDirectory(resolution.root, relativeDir);
            } else if (diskCleanup) {
              // Deferred: applied by the sweep when the drive returns.
              await diskCleanup.add({ volumeId, relativeDir, entryId: id });
            }
          };
          if (!input.enabled) {
            archiver?.cancel(id);
            if (current && input.deleteFiles) {
              await cleanup(current.volumeId, current.relativeDir);
            }
            await library.setDiskCopy(id, undefined);
            console.log(
              JSON.stringify({
                level: "info",
                event: "disk_copy_disabled",
                entryId: id,
                deleteFiles: Boolean(input.deleteFiles),
              }),
            );
            return reply(response, 200, await library.get(id));
          }
          if (
            entry.localFilePath ||
            entry.localFolderPath ||
            !(entry.magnetUri || entry.torrentFilePath)
          ) {
            throw new DiskCopyError(
              "Disk copies require a torrent-backed entry",
            );
          }
          const volumeId = input.volumeId ?? current?.volumeId;
          if (!volumeId) throw new DiskCopyError("Choose a storage volume");
          if (!(await volumes.get(volumeId)))
            throw new DiskCopyError("Unknown storage volume");
          if (current && current.volumeId !== volumeId && input.deleteFiles) {
            await cleanup(current.volumeId, current.relativeDir);
          }
          if (!entry.inspectionCache) {
            await inspectEntry(entry, torrServer, library);
            entry = await library.get(id);
            if (!entry?.inspectionCache)
              throw new DiskCopyError("Torrent inspection failed");
          }
          const previous = current?.volumeId === volumeId ? current : undefined;
          const scope = input.scope ?? previous?.scope ?? "all";
          let files = buildManifest(entry, {
            scope,
            includedSourceKeys: input.includedSourceKeys,
            previous: previous?.files,
          });
          const relativeDir =
            previous?.relativeDir ?? defaultRelativeDir(entry);
          const resolution = await volumes.resolve(volumeId);
          if (resolution.state === "online") {
            // Adopt files that already exist on the drive (idempotent
            // re-enable) before persisting the manifest.
            files = (await reconcileFiles(resolution.root, relativeDir, files))
              .files;
          }
          await library.setDiskCopy(id, {
            desired: "keep",
            volumeId,
            relativeDir,
            sourceRevision: computeSourceRevision(files),
            scope,
            files,
            updatedAt: new Date().toISOString(),
          });
          console.log(
            JSON.stringify({
              level: "info",
              event: "disk_copy_enabled",
              entryId: id,
              volumeId,
              scope,
              files: files.length,
              included: files.filter((file) => file.included).length,
            }),
          );
          archiver?.enqueue(id);
          return reply(response, 200, await library.get(id));
        }
        if (diskCopyRetryMatch && request.method === "POST") {
          if (!volumes)
            return reply(response, 409, { error: "Volumes unavailable" });
          const id = decodeURIComponent(diskCopyRetryMatch[1]);
          const entry = await library.get(id);
          if (!entry) return reply(response, 404, { error: "Not found" });
          const current = entry.diskCopy;
          if (!current)
            return reply(response, 409, { error: "Disk copy is not enabled" });
          let files = buildManifest(entry, {
            scope: current.scope,
            previous: current.files,
          });
          const resolution = await volumes.resolve(current.volumeId);
          if (resolution.state === "online") {
            files = (
              await reconcileFiles(
                resolution.root,
                current.relativeDir,
                files,
                { retry: true },
              )
            ).files;
          } else {
            // Drive offline: the explicit retry still clears sticky invalid
            // states so work resumes when it returns.
            files = files.map((file) =>
              file.state === "invalid"
                ? { ...file, state: "missing" as const }
                : file,
            );
          }
          await library.setDiskCopy(id, {
            ...current,
            files,
            sourceRevision: computeSourceRevision(files),
            updatedAt: new Date().toISOString(),
          });
          archiver?.enqueue(id);
          return reply(response, 200, await library.get(id));
        }
        if (url.pathname === "/api/disk-jobs" && request.method === "GET") {
          if (!archiver)
            return reply(response, 409, { error: "Archiver unavailable" });
          return reply(response, 200, { jobs: archiver.jobs() });
        }
        if (url.pathname === "/api/disk-schedule") {
          if (!archiveSchedule)
            return reply(response, 409, { error: "Schedule unavailable" });
          if (request.method === "PUT") {
            const input = diskScheduleRequestSchema.parse(await body(request));
            await archiveSchedule.set(
              input.enabled
                ? {
                    startMinute: parseTime(input.start!),
                    endMinute: parseTime(input.end!),
                  }
                : undefined,
            );
            // Re-check waiting entries: the window may have just opened.
            archiver?.wake();
            console.log(
              JSON.stringify({
                level: "info",
                event: "disk_schedule_updated",
                window: input.enabled
                  ? `${input.start}-${input.end}`
                  : "always",
              }),
            );
          } else if (request.method !== "GET") {
            return reply(response, 405, { error: "Method not allowed" });
          }
          const window = await archiveSchedule.window();
          return reply(response, 200, {
            window: window
              ? {
                  start: formatTime(window.startMinute),
                  end: formatTime(window.endMinute),
                  label: describeWindow(window),
                }
              : null,
            active: withinWindow(window),
          });
        }
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
        if (url.pathname === "/api/clients" && request.method === "GET") {
          const tracked = listClients();
          const names = (await deviceNames?.all()) ?? {};
          // Hostname lookups are cached with a short negative TTL, so this
          // stays fast after the first poll.
          const clients = await Promise.all(
            tracked.map(async (client) => ({
              ...client,
              name: names[client.ip],
              hostname: await lookupHostname(client.ip),
            })),
          );
          return reply(response, 200, { clients });
        }
        if (url.pathname === "/api/clients/name" && request.method === "POST") {
          if (!deviceNames) {
            return reply(response, 409, { error: "Naming unavailable" });
          }
          const input = clientNameSchema.parse(await body(request));
          await deviceNames.set(input.ip, input.name);
          return reply(response, 200, { ok: true });
        }
        if (url.pathname === "/api/playback" && request.method === "GET") {
          const torrents = await torrServer.list().catch(() => []);
          return reply(response, 200, {
            // stat 3 = TorrentWorking (MatriX state.go): actively serving.
            sessions: torrents.map((torrent) => ({
              hash: torrent.hash,
              title: torrent.title || torrent.name || "Unknown torrent",
              statString: torrent.stat_string,
              active: torrent.stat === 3,
              downloadSpeedBps: torrent.download_speed ?? 0,
              uploadSpeedBps: torrent.upload_speed ?? 0,
              activePeers: torrent.active_peers ?? 0,
              connectedSeeders: torrent.connected_seeders ?? 0,
              loadedSize: torrent.loaded_size ?? 0,
              torrentSize: torrent.torrent_size ?? 0,
            })),
          });
        }
        if (
          url.pathname === "/api/pointer/status" &&
          request.method === "GET"
        ) {
          return reply(
            response,
            200,
            pointer ? await pointer.status() : { configured: false },
          );
        }
        if (url.pathname === "/api/pointer/push" && request.method === "POST") {
          if (!pointer) {
            return reply(response, 409, { error: "Pointer not configured" });
          }
          try {
            return reply(response, 200, await pointer.push(addon.manifest));
          } catch (error) {
            return reply(response, 502, {
              error:
                error instanceof Error ? error.message : "Pointer push failed",
            });
          }
        }
        if (
          url.pathname === "/api/pointer/remote" &&
          request.method === "GET"
        ) {
          if (!pointer) {
            return reply(response, 409, { error: "Pointer not configured" });
          }
          return reply(response, 200, await pointer.remoteStatus());
        }
        if (
          url.pathname === "/api/pointer/remove" &&
          request.method === "POST"
        ) {
          if (!pointer) {
            return reply(response, 409, { error: "Pointer not configured" });
          }
          try {
            await pointer.remove();
            return reply(response, 200, { ok: true });
          } catch (error) {
            return reply(response, 502, {
              error:
                error instanceof Error
                  ? error.message
                  : "Pointer removal failed",
            });
          }
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
            homeSpeedMbps: homeSpeedMbps(),
            speed: currentSpeed(),
            nativePicker: pickerAvailable,
            streamingActive: recentStreamActivity() || activeTorrents > 0,
            uptimeSeconds: Math.floor(process.uptime()),
            transcode: {
              enabled: Boolean(transcode),
              activeSessions: transcode?.list().length ?? 0,
              videoEncoder: transcode?.videoEncoder ?? null,
            },
            pointer: pointer
              ? {
                  configured: true,
                  stale: (await pointer.status()).stale ?? true,
                }
              : { configured: false },
          });
        }
        if (url.pathname === "/api/resources" && request.method === "GET") {
          return reply(
            response,
            200,
            await resourceReport(
              resourceDirs ?? { torrentCache: "", transcode: "", uploads: "" },
            ),
          );
        }
        if (url.pathname === "/api/speedtest" && request.method === "POST") {
          try {
            const result = await runSpeedTest();
            return reply(response, 200, { ...result, source: "measured" });
          } catch (error) {
            return reply(response, 502, {
              error:
                error instanceof Error ? error.message : "Speed test failed",
            });
          }
        }
        if (
          url.pathname === "/api/transcode/sessions" &&
          request.method === "GET"
        ) {
          return reply(
            response,
            200,
            (transcode?.list() ?? []).map((session) => ({
              entryId: session.entryId,
              fileId: session.fileId,
              variant: session.variant,
              tier: session.tier,
              startedAt: new Date(session.startedAt).toISOString(),
              lastAccess: new Date(session.lastAccess).toISOString(),
              state: session.failed
                ? "failed"
                : session.exited
                  ? "finished"
                  : "running",
            })),
          );
        }
        const sessionMatch =
          /^\/api\/transcode\/sessions\/([^/]+)\/(\d+)$/.exec(url.pathname);
        if (sessionMatch && request.method === "DELETE") {
          const removed = await transcode?.removeAll(
            decodeURIComponent(sessionMatch[1]),
            Number(sessionMatch[2]),
          );
          if (!removed) return reply(response, 404, { error: "No session" });
          return reply(response, 204, null);
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
              const directPlay = assessDirectPlay(technical, homeSpeedMbps());
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
                homeSpeedMbps: homeSpeedMbps(),
              });
            } catch {
              technical = { error: "Media details could not be read" };
            }
          }
          return reply(response, 200, {
            ...inspection,
            technical,
            homeSpeedMbps: homeSpeedMbps(),
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
          // Disk copies mirror managed media: deleting the entry cleans up
          // its files, deferred via tombstone when the drive is offline.
          if (removed && entry?.diskCopy && volumes) {
            archiver?.cancel(id);
            const { volumeId, relativeDir } = entry.diskCopy;
            const resolution = await volumes.resolve(volumeId);
            if (resolution.state === "online") {
              await removeDiskCopyDirectory(resolution.root, relativeDir).catch(
                () => diskCleanup?.add({ volumeId, relativeDir }),
              );
            } else {
              await diskCleanup?.add({ volumeId, relativeDir });
            }
          }
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
        error instanceof PlayerError ||
        error instanceof VolumeError ||
        error instanceof DiskCopyError;
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
          error instanceof PlayerError ||
          error instanceof VolumeError ||
          error instanceof DiskCopyError
            ? error.message
            : clientError
              ? "Invalid request"
              : "Internal server error",
      });
    }
  };
}
