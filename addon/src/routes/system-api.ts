import { z, ZodError } from "zod";
import { recentEntryActivity, recentStreamActivity } from "../activity.ts";
import { listClients } from "../clients.ts";
import { manifestWithGenres } from "../manifest.ts";
import { lookupHostname } from "../hostname.ts";
import { resourceReport } from "../resources.ts";
import { currentSpeed, homeSpeedMbps, runSpeedTest } from "../speedtest.ts";
import { PointerError, pointerSetupSchema } from "../pointer.ts";
import { releaseInfo } from "../release.ts";
import {
  body,
  logInfo,
  noStoreReply,
  reply,
  type RouteHandler,
} from "./context.ts";

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
const analysisRequestSchema = z.object({ force: z.boolean().optional() });

export const handleAnalysis: RouteHandler = async (
  { analysis },
  { request, response, url, method },
) => {
  if (url.pathname !== "/api/analysis") return false;
  if (!analysis) return reply(response, 409, { error: "Analysis unavailable" });
  if (method === "POST") {
    const input = analysisRequestSchema.parse(
      (await body(request).catch(() => ({}))) ?? {},
    );
    const started = await analysis.start(Boolean(input.force));
    if (!started)
      return reply(response, 409, { error: "Analysis already running" });
    logInfo("library_analysis_started", { force: Boolean(input.force) });
  } else if (method === "DELETE") {
    await analysis.cancel();
  } else if (method !== "GET") {
    return reply(response, 405, { error: "Method not allowed" });
  }
  return reply(response, 200, analysis.status());
};

export const handlePlayer: RouteHandler = async (
  { playback },
  { request, response, url, method },
) => {
  if (url.pathname === "/api/player/play" && method === "POST") {
    const input = playRequestSchema.parse(await body(request));
    const result = await playback.play(input.entryId, input.fileId);
    logInfo("player_started", { entryId: input.entryId, mode: result.mode });
    return reply(response, 200, result);
  }
  if (url.pathname === "/api/player/control" && method === "POST") {
    const input = playerControlSchema.parse(await body(request));
    await playback.control(input.action, input.value);
    return reply(response, 200, { ok: true });
  }
  if (url.pathname === "/api/player/status" && method === "GET") {
    return reply(response, 200, {
      ...(await playback.status()),
      available: await playback.available(),
      preference: playback.preference,
    });
  }
  return false;
};

export const handleClients: RouteHandler = async (
  { deviceNames },
  { request, response, url, method },
) => {
  if (url.pathname === "/api/clients" && method === "GET") {
    const tracked = listClients();
    const names = (await deviceNames?.all()) ?? {};
    // Hostname lookups are cached with a short negative TTL, so this stays
    // fast after the first poll.
    const clients = await Promise.all(
      tracked.map(async (client) => ({
        ...client,
        name: names[client.ip],
        hostname: await lookupHostname(client.ip),
      })),
    );
    return reply(response, 200, { clients });
  }
  if (url.pathname === "/api/clients/name" && method === "POST") {
    if (!deviceNames)
      return reply(response, 409, { error: "Naming unavailable" });
    const input = clientNameSchema.parse(await body(request));
    await deviceNames.set(input.ip, input.name);
    return reply(response, 200, { ok: true });
  }
  return false;
};

// Why a torrent is busy: a client streaming it, the archiver copying it to
// disk, an inspection reading its metadata — or nothing we know of.
export type SessionActivity =
  "streaming" | "downloading" | "inspecting" | "idle";

export const handlePlaybackSessions: RouteHandler = async (
  { torrServer, library, archiver },
  { response, url, method },
) => {
  if (url.pathname !== "/api/playback" || method !== "GET") return false;
  const torrents = await torrServer.list().catch(() => []);
  // Torrent hash → library entry, via the primary and extra source hashes.
  const owners = new Map<string, string>();
  for (const entry of await library.list()) {
    const cache = entry.inspectionCache;
    if (!cache) continue;
    owners.set(cache.hash.toLowerCase(), entry.id);
    for (const file of cache.selectedFiles)
      if (file.hash) owners.set(file.hash.toLowerCase(), entry.id);
  }
  const copying = archiver?.activeEntryId();
  const classify = (hash: string): SessionActivity => {
    const entryId = owners.get(hash.toLowerCase());
    if (!entryId) return "idle";
    if (copying === entryId) return "downloading";
    return recentEntryActivity(entryId) ?? "idle";
  };
  return reply(response, 200, {
    // stat 3 = TorrentWorking (MatriX state.go): actively serving.
    sessions: torrents.map((torrent) => ({
      hash: torrent.hash,
      entryId: owners.get(torrent.hash.toLowerCase()),
      title: torrent.title || torrent.name || "Unknown torrent",
      statString: torrent.stat_string,
      active: torrent.stat === 3,
      activity: classify(torrent.hash),
      downloadSpeedBps: torrent.download_speed ?? 0,
      uploadSpeedBps: torrent.upload_speed ?? 0,
      activePeers: torrent.active_peers ?? 0,
      connectedSeeders: torrent.connected_seeders ?? 0,
      loadedSize: torrent.loaded_size ?? 0,
      torrentSize: torrent.torrent_size ?? 0,
    })),
  });
};

export const handlePointer: RouteHandler = async (
  { pointer, addon, tags },
  { request, response, url, method },
) => {
  const action = /^\/api\/pointer\/(status|settings|push|remote|remove)$/.exec(
    url.pathname,
  )?.[1];
  if (!action) return false;
  if (method !== (["status", "remote"].includes(action) ? "GET" : "POST"))
    return noStoreReply(response, 405, { error: "Method not allowed" });
  if (!pointer && action === "status")
    return noStoreReply(response, 200, { configured: false });
  if (!pointer)
    return noStoreReply(response, 409, { error: "Pointer setup unavailable" });
  try {
    if (action === "status")
      return noStoreReply(response, 200, await pointer.status());
    if (action === "settings")
      return noStoreReply(
        response,
        200,
        await pointer.configure(pointerSetupSchema.parse(await body(request))),
      );
    if (action === "remote")
      return noStoreReply(response, 200, await pointer.remoteStatus());
    if (action === "push") {
      return noStoreReply(
        response,
        200,
        await pointer.push(
          manifestWithGenres(addon.manifest, (await tags?.list()) ?? []),
        ),
      );
    }
    await pointer.remove();
    return noStoreReply(response, 200, { ok: true });
  } catch (error) {
    if (error instanceof ZodError || error instanceof SyntaxError)
      return noStoreReply(response, 400, {
        error:
          "Enter an HTTPS service origin without credentials, a path, query, or fragment.",
      });
    if (error instanceof PointerError)
      return noStoreReply(response, error.statusCode, {
        error: error.message,
        code: error.code,
        state: error.state,
      });
    console.error(
      JSON.stringify({
        level: "error",
        event: "pointer_action_failed",
        action,
      }),
    );
    return noStoreReply(response, 503, {
      error:
        "Pointer setup could not be loaded or saved. Check private state permissions or restore your backup, then retry.",
      state: "storage-error",
    });
  }
};

export const handleStatus: RouteHandler = async (
  { library, torrServer, nativePicker, transcode, pointer, onboarding },
  { response, url, method },
) => {
  if (url.pathname !== "/api/status" || method !== "GET") return false;
  const [entries, torrServerStatus, pickerAvailable] = await Promise.all([
    library.list(),
    torrServer
      .health()
      .then((version) => ({ online: true, version }))
      .catch(() => ({ online: false })),
    nativePicker.available(),
  ]);
  const pointerStatus = pointer
    ? await pointer.status().catch(() => {
        console.error(
          JSON.stringify({
            level: "error",
            event: "pointer_status_unavailable",
          }),
        );
        return {
          configured: false,
          state: "storage-error",
          message:
            "Pointer setup could not be read. Open Activity to retry or restore its private backup.",
        };
      })
    : { configured: false };
  return noStoreReply(response, 200, {
    status: "online",
    release: releaseInfo,
    torrServer: torrServerStatus,
    libraryCount: entries.length,
    onboarding: onboarding
      ? {
          available: true,
          welcomePending: (await onboarding.read()).welcomePending,
        }
      : { available: false, welcomePending: false },
    homeSpeedMbps: homeSpeedMbps(),
    speed: currentSpeed(),
    nativePicker: pickerAvailable,
    // Real client streams only; the archiver and inspections also keep
    // TorrServer busy, and those are reported elsewhere.
    streamingActive: recentStreamActivity(),
    uptimeSeconds: Math.floor(process.uptime()),
    transcode: {
      enabled: Boolean(transcode),
      activeSessions: transcode?.list().length ?? 0,
      videoEncoder: transcode?.videoEncoder ?? null,
    },
    pointer: pointerStatus,
  });
};

export const handleResources: RouteHandler = async (
  { resourceDirs },
  { response, url, method },
) => {
  if (url.pathname !== "/api/resources" || method !== "GET") return false;
  return reply(
    response,
    200,
    await resourceReport(
      resourceDirs ?? { torrentCache: "", transcode: "", uploads: "" },
    ),
  );
};

export const handleSpeedTest: RouteHandler = async (
  _context,
  { response, url, method },
) => {
  if (url.pathname !== "/api/speedtest" || method !== "POST") return false;
  try {
    const result = await runSpeedTest();
    return reply(response, 200, { ...result, source: "measured" });
  } catch (error) {
    return reply(response, 502, {
      error: error instanceof Error ? error.message : "Speed test failed",
    });
  }
};

export const handleTranscodeSessions: RouteHandler = async (
  { transcode },
  { response, url, method },
) => {
  if (url.pathname === "/api/transcode/sessions" && method === "GET") {
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
  const sessionMatch = /^\/api\/transcode\/sessions\/([^/]+)\/(\d+)$/.exec(
    url.pathname,
  );
  if (sessionMatch && method === "DELETE") {
    const removed = await transcode?.removeAll(
      decodeURIComponent(sessionMatch[1]),
      Number(sessionMatch[2]),
    );
    if (!removed) return reply(response, 404, { error: "No session" });
    return reply(response, 204, null);
  }
  return false;
};
