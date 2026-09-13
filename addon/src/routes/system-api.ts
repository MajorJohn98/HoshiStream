import { z, ZodError } from "zod";
import { recentEntryActivity, recentStreamActivity } from "../activity.ts";
import { entryHashes, magnetHash } from "../imports/source-identity.ts";
import { fileSourceIndex } from "../media-file-selection.ts";
import { activeStreamTargets } from "../playback-telemetry.ts";
import { listClients } from "../clients.ts";
import { manifestForLibrary } from "../manifest.ts";
import { lookupHostname } from "../hostname.ts";
import { resourceReport } from "../resources.ts";
import { currentSpeed, homeSpeedMbps, runSpeedTest } from "../speedtest.ts";
import { lineFit } from "../line-fit.ts";
import { PointerError, pointerSetupSchema } from "../pointer.ts";
import { releaseInfo } from "../release.ts";
import { buildDiagnostics } from "../diagnostics.ts";
import { TorrServerError } from "../torrserver-client.ts";
import { identitySchema } from "../identity.ts";
import {
  loadShippedSettings,
  pickTunableSettings,
  suggestUploadRateLimit,
  tunablePatchSchema,
} from "../torrserver-settings.ts";
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
  // Torrent hash → library entries, via every hash the entry is known by.
  // Several entries can share one torrent (a re-added series, say), so the
  // session reports whichever owner is actually busy rather than the last
  // one indexed.
  const owners = new Map<string, string[]>();
  // Which of an entry's torrents this is, when it has more than one (extra
  // season sources), so same-named rows can be told apart.
  const sourceLabels = new Map<string, string>();
  for (const entry of await library.list()) {
    for (const hash of entryHashes(entry)) {
      const list = owners.get(hash) ?? [];
      list.push(entry.id);
      owners.set(hash, list);
    }
    entry.extraSources?.forEach((source, index) => {
      const label =
        source.seasonHint !== undefined
          ? `Season ${source.seasonHint}`
          : `Extra source ${index + 1}`;
      for (const hash of [source.sourceHash, magnetHash(source.magnetUri)])
        if (hash) sourceLabels.set(`${entry.id}:${hash.toLowerCase()}`, label);
      for (const file of entry.inspectionCache?.selectedFiles ?? [])
        if (file.hash && fileSourceIndex(file.id) === index + 1)
          sourceLabels.set(`${entry.id}:${file.hash.toLowerCase()}`, label);
    });
  }
  const copying = archiver?.activeEntryId();
  // An entry with several torrents streams from one of them at a time; the
  // sampler knows which. The others are merely loaded.
  const streamingHashes = new Map(
    activeStreamTargets().map((target) => [
      target.entryId,
      target.hash.toLowerCase(),
    ]),
  );
  const classify = (
    hash: string,
  ): { entryId?: string; activity: SessionActivity } => {
    hash = hash.toLowerCase();
    const candidates = owners.get(hash) ?? [];
    let chosen: { entryId?: string; activity: SessionActivity } = {
      entryId: candidates[0],
      activity: "idle",
    };
    for (const entryId of candidates) {
      if (copying === entryId) return { entryId, activity: "downloading" };
      const activity = recentEntryActivity(entryId);
      if (activity === "streaming") {
        const streamed = streamingHashes.get(entryId);
        if (streamed === undefined || streamed === hash)
          return { entryId, activity };
        chosen = { entryId, activity: "idle" };
        continue;
      }
      if (activity && chosen.activity === "idle")
        chosen = { entryId, activity };
    }
    return chosen;
  };
  return reply(response, 200, {
    // stat 3 = TorrentWorking (MatriX state.go): actively serving.
    sessions: torrents.map((torrent) => {
      const session = classify(torrent.hash);
      return {
        hash: torrent.hash,
        ...session,
        sourceLabel: session.entryId
          ? sourceLabels.get(`${session.entryId}:${torrent.hash.toLowerCase()}`)
          : undefined,
        title: torrent.title || torrent.name || "Unknown torrent",
        statString: torrent.stat_string,
        active: torrent.stat === 3,
        downloadSpeedBps: torrent.download_speed ?? 0,
        uploadSpeedBps: torrent.upload_speed ?? 0,
        activePeers: torrent.active_peers ?? 0,
        connectedSeeders: torrent.connected_seeders ?? 0,
        loadedSize: torrent.loaded_size ?? 0,
        torrentSize: torrent.torrent_size ?? 0,
      };
    }),
  });
};

export const handlePlaybackTelemetry: RouteHandler = async (
  { telemetry },
  { response, url, method },
) => {
  if (url.pathname !== "/api/playback/telemetry" || method !== "GET")
    return false;
  return noStoreReply(response, 200, { streams: telemetry?.report() ?? [] });
};

export const handlePointer: RouteHandler = async (
  { pointer, addon, tags, identity, publicUrls },
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
          manifestForLibrary(
            addon.manifest,
            (await tags?.list()) ?? [],
            (await tags?.pinned()) ?? [],
            {
              addonUrl: publicUrls.addonUrl,
              contactEmail: (await identity?.read())?.contactEmail,
            },
          ),
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
    // Same rule the stream list applies, so the UI verdict never disagrees.
    lineFit: lineFit(homeSpeedMbps()),
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

// Redacted support bundle (Phase 9). Never cached: it carries live logs.
export const handleDiagnostics: RouteHandler = async (
  context,
  { response, url, method },
) => {
  if (url.pathname !== "/api/diagnostics" || method !== "GET") return false;
  const bundle = await buildDiagnostics({
    library: context.library,
    torrServer: context.torrServer,
    telemetry: context.telemetry,
    pointer: context.pointer,
    volumes: context.volumes,
    archiver: context.archiver,
    archiveSchedule: context.archiveSchedule,
    logs: context.diagnostics?.logs,
    secrets: {
      accessToken: context.accessToken,
      pushSecret: context.diagnostics?.pushSecret,
    },
  });
  logInfo("diagnostics_exported", { logLines: bundle.logs.length });
  return noStoreReply(response, 200, bundle);
};

// Add-on identity advertised in the manifest (Phase 15): the contact address
// is viewer-set and empty by default.
export const handleIdentity: RouteHandler = async (
  { identity },
  { request, response, url, method },
) => {
  if (url.pathname !== "/api/identity") return false;
  if (method !== "GET" && method !== "PUT") return false;
  if (!identity)
    return noStoreReply(response, 409, { error: "Identity unavailable" });
  if (method === "GET")
    return noStoreReply(response, 200, await identity.read());
  try {
    const patch = identitySchema.partial().parse(await body(request));
    const next = await identity.update(patch);
    logInfo("identity_updated", {
      contactEmailSet: Boolean(next.contactEmail),
    });
    return noStoreReply(response, 200, next);
  } catch (error) {
    if (error instanceof ZodError || error instanceof SyntaxError)
      return noStoreReply(response, 400, {
        error: "Enter a valid e-mail address or leave the field empty.",
        code: "invalid_body",
      });
    throw error;
  }
};

const SETTINGS_PATH = "/api/torrserver/settings";
const SETTINGS_RESET_PATH = "/api/torrserver/settings/reset";

// TorrServer tuning (Phase 10). Reads come from `/settings get`; writes go
// through `TorrServerClient.updateSettings`, which TorrServer answers by
// dropping every torrent and reconnecting — so writes are refused while a
// stream is active. Shipped defaults are read from the bundle, never from
// TorrServer's own `def` action.
export const handleTorrServerSettings: RouteHandler = async (
  context,
  { request, response, url, method },
) => {
  const isReset = url.pathname === SETTINGS_RESET_PATH;
  if (url.pathname !== SETTINGS_PATH && !isReset) return false;
  if (isReset ? method !== "POST" : method !== "GET" && method !== "PUT")
    return false;
  let shipped;
  try {
    shipped = loadShippedSettings(context.shippedSettingsUrl);
  } catch {
    console.error(
      JSON.stringify({
        level: "error",
        event: "torrserver_shipped_settings_unreadable",
      }),
    );
    return noStoreReply(response, 500, {
      error: "Shipped TorrServer defaults could not be read from the bundle.",
      code: "shipped_settings_unreadable",
    });
  }
  try {
    if (method === "GET") {
      const current = pickTunableSettings(await context.torrServer.settings());
      return noStoreReply(response, 200, {
        current,
        shipped,
        suggestion:
          suggestUploadRateLimit(current, shipped, currentSpeed()) ?? null,
      });
    }
    const patch = isReset
      ? shipped
      : tunablePatchSchema.parse(await body(request));
    if (recentStreamActivity())
      return noStoreReply(response, 409, {
        error:
          "Someone is streaming right now. Applying settings would drop their playback; try again when the library is idle.",
        code: "streaming_active",
      });
    const current = await context.torrServer.updateSettings(patch);
    logInfo("torrserver_settings_updated", {
      keys: Object.keys(patch).sort(),
      reset: isReset,
    });
    return noStoreReply(response, 200, { current, shipped });
  } catch (error) {
    if (error instanceof ZodError || error instanceof SyntaxError)
      return noStoreReply(response, 400, {
        error:
          "Settings must be whole numbers: rate limits ≥ 0 KiB/s, connections ≥ 1, cache ≥ 32 MiB, read-ahead 5–100 %, disconnect timeout ≥ 1 s.",
        code: "invalid_body",
      });
    if (error instanceof TorrServerError)
      return noStoreReply(response, 503, {
        error:
          "TorrServer did not answer. Check System → Status and retry once it is healthy.",
        code: "torrserver_unavailable",
      });
    throw error;
  }
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
    return reply(response, 200, {
      ...result,
      source: "measured",
      effective: currentSpeed(),
    });
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
