import { createHash } from "node:crypto";
import { z } from "zod";
import { assessDirectPlay } from "../direct-play.ts";
import { removeDiskCopyDirectory } from "../disk-copy.ts";
import { inspectEntry } from "../inspection.ts";
import {
  isManagedMediaPath,
  listLocalMedia,
  removeManagedMedia,
  saveTorrentUpload,
  saveUpload,
  validateBrowserLocalPath,
} from "../local-media.ts";
import { entrySourceDefinitionRevision } from "../imports/source-identity.ts";
import { homeSpeedMbps } from "../speedtest.ts";
import { entryTagsSchema, type Tags } from "../tags.ts";
import {
  createEntrySchema,
  patchEntrySchema,
  type LibraryEntry,
} from "../types.ts";
import {
  body,
  jsonObjectBody,
  logInfo,
  noStoreReply,
  reply,
  type RouteHandler,
} from "./context.ts";

const catalogResponseSchema = z.object({ metas: z.array(z.unknown()) });
const optionalIdempotencyKeySchema = z.string().uuid().optional();
const SOURCE_DEFINITION_FIELDS = [
  "type",
  "magnetUri",
  "torrentFilePath",
  "localFilePath",
  "localFolderPath",
  "preferredFileIndex",
  "fileOverrides",
  "extraSources",
] as const;

function rejectServerOwnedFields(input: Record<string, unknown>): void {
  if (
    "sourceHash" in input ||
    "searchImport" in input ||
    "searchReceipts" in input ||
    "sourceCheck" in input ||
    "mediaFacts" in input ||
    "watchStates" in input
  )
    throw new SyntaxError(
      "Source identity, search metadata, source checks, and watch state are server-owned",
    );
}

function rejectNestedOwnership(input: Record<string, unknown>): void {
  if (!Array.isArray(input.extraSources)) return;
  for (const source of input.extraSources) {
    if (
      source &&
      typeof source === "object" &&
      ("managedMedia" in source ||
        "sourceHash" in source ||
        "searchImport" in source ||
        "searchReceipts" in source ||
        "sourceCheck" in source ||
        "mediaFacts" in source)
    )
      throw new SyntaxError(
        "Extra-source ownership, source identity, search metadata, and source checks are server-owned",
      );
  }
}

function manualCreateReceipt(input: Record<string, unknown>) {
  const key = optionalIdempotencyKeySchema.parse(input.idempotencyKey);
  if (!key) return;
  const fingerprintInput = { ...input };
  delete fingerprintInput.idempotencyKey;
  return {
    key,
    fingerprint: createHash("sha256")
      .update(
        JSON.stringify({
          operation: "manual-create",
          input: fingerprintInput,
        }),
      )
      .digest("hex"),
  };
}

async function cleanupManagedSources(
  entry: LibraryEntry,
  remaining: LibraryEntry[],
): Promise<void> {
  try {
    await removeManagedMedia(entry, remaining);
  } catch (error) {
    console.error(
      JSON.stringify({
        level: "warn",
        event: "managed_media_cleanup_failed",
        entryId: entry.id,
      }),
    );
    throw error;
  }
}

export function technicalProbeRequested(url: URL): boolean {
  return url.searchParams.get("probe") === "true";
}

// Entry tags are stored with the registry's spelling; unknown names are
// registered on the fly so the entry sheet can create tags inline.
async function normalizeTags(
  input: Record<string, unknown>,
  tags: Tags | undefined,
): Promise<void> {
  if (!("tags" in input)) return;
  const parsed = entryTagsSchema.parse(input.tags ?? []);
  const resolved = tags ? await tags.ensure(parsed) : parsed;
  if (resolved.length) input.tags = resolved;
  else input.tags = null;
}

export const handleLibraryCollection: RouteHandler = async (
  { library, nativePicker, tags },
  { request, response, url, method },
) => {
  if (url.pathname !== "/api/library") return false;
  if (method === "GET") return reply(response, 200, await library.list());
  if (method !== "POST") return false;
  const input = jsonObjectBody(await body(request));
  rejectServerOwnedFields(input);
  rejectNestedOwnership(input);
  const receipt = manualCreateReceipt(input);
  if (receipt) {
    const replay = await library.searchReceipt(receipt);
    if (replay) return reply(response, 200, replay);
  }
  delete input.idempotencyKey;
  delete input.managedMedia;
  await normalizeTags(input, tags);
  if (input.tags === null) delete input.tags;
  if (typeof input.nativePathGrant === "string") {
    const selected = nativePicker.redeem(input.nativePathGrant);
    delete input.nativePathGrant;
    delete input.localFilePath;
    delete input.localFolderPath;
    input[selected.kind === "file" ? "localFilePath" : "localFolderPath"] =
      selected.path;
  } else {
    if (typeof input.localFilePath === "string") {
      const path = await validateBrowserLocalPath(input.localFilePath, "file");
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
      input.managedMedia = await isManagedMediaPath(input.torrentFilePath);
    }
  }
  if (receipt) {
    const result = await library.createWithReceipt(
      createEntrySchema.parse(input),
      receipt,
    );
    if (result.created)
      logInfo("library_created", { entryId: result.entry.id });
    return reply(response, result.created ? 201 : 200, result.entry);
  }
  const entry = await library.create(createEntrySchema.parse(input));
  logInfo("library_created", { entryId: entry.id });
  return reply(response, 201, entry);
};

const playbackBodySchema = z.object({
  positionSeconds: z.number().nonnegative(),
  fileId: z.number().int().nonnegative().optional(),
});

// Resume position written by the in-browser player (host mpv playback writes
// it directly). PUT records where the viewer is; DELETE clears it when a
// movie finishes; a series that finishes an episode PUTs the next one at 0.
export const handlePlaybackPosition: RouteHandler = async (
  { library },
  { request, response, url, method },
) => {
  const match = /^\/api\/library\/([^/]+)\/playback$/.exec(url.pathname);
  if (!match) return false;
  const id = decodeURIComponent(match[1]);
  const entry = await library.get(id);
  if (!entry) return reply(response, 404, { error: "Not found" });
  if (method === "PUT") {
    const input = playbackBodySchema.parse(await body(request));
    await library.setPlayback(id, {
      positionSeconds: Math.floor(input.positionSeconds),
      ...(input.fileId === undefined ? {} : { fileId: input.fileId }),
      source: "browser",
      updatedAt: new Date().toISOString(),
    });
    return reply(response, 200, (await library.get(id))?.playback ?? null);
  }
  if (method === "DELETE") {
    await library.clearPlayback(id);
    return reply(response, 204, null);
  }
  return false;
};

const watchBodySchema = z.object({
  fileId: z.number().int().nonnegative(),
  state: z.enum(["started", "watched"]),
});

// Manual watched marks from the management UI, and the browser player's
// started/finished signals. PUT sets a state; DELETE /:fileId clears it.
export const handleWatchState: RouteHandler = async (
  { library, watch },
  { request, response, url, method },
) => {
  const match = /^\/api\/library\/([^/]+)\/watch(?:\/(\d+))?$/.exec(
    url.pathname,
  );
  if (!match) return false;
  const id = decodeURIComponent(match[1]);
  const entry = await library.get(id);
  if (!entry) return reply(response, 404, { error: "Not found" });
  if (method === "PUT" && match[2] === undefined) {
    const input = watchBodySchema.parse(await body(request));
    if (input.state === "watched") await watch.watched(id, input.fileId);
    else await watch.started(id, input.fileId);
    return reply(response, 200, (await library.get(id))?.watchStates ?? []);
  }
  if (method === "DELETE" && match[2] !== undefined) {
    await watch.clear(id, Number(match[2]));
    return reply(response, 204, null);
  }
  return false;
};

export const handleLibraryItem: RouteHandler = async (
  { library, volumes, diskCleanup, archiver, tags, sourceChecks },
  { request, response, url, method },
) => {
  const itemMatch = /^\/api\/library\/([^/]+)$/.exec(url.pathname);
  if (!itemMatch) return false;
  const id = decodeURIComponent(itemMatch[1]);
  if (method === "GET") {
    const entry = await library.get(id);
    return reply(response, entry ? 200 : 404, entry ?? { error: "Not found" });
  }
  if (method === "PATCH") {
    const patch = jsonObjectBody(await body(request));
    rejectServerOwnedFields(patch);
    rejectNestedOwnership(patch);
    delete patch.managedMedia;
    await normalizeTags(patch, tags);
    const input = patchEntrySchema.parse(patch);
    const current = await library.get(id);
    const previousRevision =
      current && SOURCE_DEFINITION_FIELDS.some((field) => field in input)
        ? entrySourceDefinitionRevision(current)
        : undefined;
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
    const entry = await library.patch(id, input, cleanupManagedSources);
    if (
      entry &&
      previousRevision &&
      entrySourceDefinitionRevision(entry) !== previousRevision
    )
      await sourceChecks?.cancel(id, previousRevision);
    if (entry) logInfo("library_updated", { entryId: entry.id });
    return reply(response, entry ? 200 : 404, entry ?? { error: "Not found" });
  }
  if (method === "DELETE") {
    const current = await library.get(id);
    if (current)
      await sourceChecks?.cancel(id, entrySourceDefinitionRevision(current));
    let entry: LibraryEntry | undefined;
    let cleanupError: unknown;
    const removed = await library.remove(id, async (previous, remaining) => {
      entry = previous;
      try {
        await cleanupManagedSources(previous, remaining);
      } catch (error) {
        cleanupError = error;
      }
    });
    // Disk copies mirror managed media: deleting the entry cleans up its
    // files, deferred via tombstone when the drive is offline.
    if (removed && entry?.diskCopy && volumes) {
      archiver?.cancel(id);
      const { volumeId, relativeDir } = entry.diskCopy;
      const resolution = await volumes.resolve(volumeId);
      if (resolution.state === "online") {
        await removeDiskCopyDirectory(resolution.root, relativeDir).catch(() =>
          diskCleanup?.add({ volumeId, relativeDir }),
        );
      } else {
        await diskCleanup?.add({ volumeId, relativeDir });
      }
    }
    if (cleanupError) throw cleanupError;
    if (removed) logInfo("library_deleted", { entryId: id });
    return reply(response, removed ? 204 : 404, { error: "Not found" });
  }
  return false;
};

export const handleInspect: RouteHandler = async (
  { library, torrServer, sourceChecks },
  { response, url, method },
) => {
  const inspectMatch = /^\/api\/library\/([^/]+)\/inspect$/.exec(url.pathname);
  if (!inspectMatch || method !== "POST") return false;
  const entry = await library.get(decodeURIComponent(inspectMatch[1]));
  if (!entry) return reply(response, 404, { error: "Not found" });
  if (technicalProbeRequested(url)) {
    if (!sourceChecks)
      return noStoreReply(response, 409, {
        code: "check_unavailable",
        error: "Source checks are unavailable on this host.",
      });
    const { check, inspection } = await sourceChecks.check(entry.id, {
      probe: true,
    });
    if (!inspection) {
      const status =
        check.outcome === "invalid"
          ? 422
          : check.code === "not_found"
            ? 404
            : ["timeout", "metadata_timeout", "check_timeout"].includes(
                  check.code ?? "",
                )
              ? 504
              : check.phase === "cancelled" || check.phase === "interrupted"
                ? 409
                : 503;
      return noStoreReply(response, status, {
        error: check.message,
        code: check.code ?? "check_unavailable",
        sourceCheck: check,
      });
    }
    const observed =
      check.phase === "complete" &&
      check.outcome === "observed" &&
      check.checkedFiles;
    return reply(response, 200, {
      ...inspection,
      technical:
        observed && check.technical
          ? check.technical
          : { error: check.message },
      ...(observed && check.technical
        ? { directPlay: assessDirectPlay(check.technical) }
        : {}),
      sourceCheck: check,
      homeSpeedMbps: homeSpeedMbps(),
    });
  }
  const inspection = await inspectEntry(entry, torrServer, library);
  return reply(response, 200, {
    ...inspection,
    homeSpeedMbps: homeSpeedMbps(),
  });
};

export const handleRelink: RouteHandler = async (
  { library, nativePicker },
  { response, url, method },
) => {
  const relinkMatch = /^\/api\/library\/([^/]+)\/relink$/.exec(url.pathname);
  if (!relinkMatch || method !== "POST") return false;
  const id = decodeURIComponent(relinkMatch[1]);
  const current = await library.get(id);
  if (!current) return reply(response, 404, { error: "Not found" });
  const kind = current.localFolderPath
    ? "folder"
    : current.localFilePath
      ? "file"
      : undefined;
  if (!kind) throw new SyntaxError("Only local entries can be relinked");
  const selected = await nativePicker.select(kind);
  const entry = await library.patch(id, {
    [kind === "file" ? "localFilePath" : "localFolderPath"]: selected,
    managedMedia: false,
  });
  logInfo("library_relinked", { entryId: id });
  return reply(response, 200, entry);
};

export const handleStremioRefresh: RouteHandler = async (
  { addon, library },
  { response, url, method },
) => {
  if (url.pathname !== "/api/stremio-refresh" || method !== "POST")
    return false;
  const [movieCatalog, seriesCatalog, entries] = await Promise.all([
    addon.get("catalog", "movie", "private-movies", {}),
    addon.get("catalog", "series", "private-series", {}),
    library.list(),
  ]);
  const movies = catalogResponseSchema.parse(movieCatalog).metas.length;
  const series = catalogResponseSchema.parse(seriesCatalog).metas.length;
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
};

// Managed media: uploaded files, .torrent uploads, and native picker grants.
export const handleMediaFiles: RouteHandler = async (
  { nativePicker },
  { request, response, url, method },
) => {
  if (url.pathname === "/api/media-files" && method === "GET") {
    return reply(response, 200, await listLocalMedia());
  }
  if (url.pathname === "/api/upload" && method === "POST") {
    return reply(
      response,
      201,
      await saveUpload(
        request,
        url.searchParams.get("batch") ?? "",
        url.searchParams.get("path") ?? "",
      ),
    );
  }
  if (url.pathname === "/api/torrent-upload" && method === "POST") {
    return reply(response, 201, {
      path: await saveTorrentUpload(
        request,
        url.searchParams.get("batch") ?? "",
        url.searchParams.get("name") ?? "",
      ),
    });
  }
  const pickerMatch = /^\/api\/native-picker\/(file|folder)$/.exec(
    url.pathname,
  );
  if (pickerMatch && method === "POST") {
    return reply(
      response,
      200,
      await nativePicker.issue(pickerMatch[1] as "file" | "folder"),
    );
  }
  return false;
};
