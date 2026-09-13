import { markInspectActivity } from "./activity.ts";
import {
  entrySourceDefinitionRevision,
  entrySourceRevision,
} from "./imports/source-identity.ts";
import type { LibraryEntry, SearchImport, SeriesSource } from "./types.ts";
import type { Library } from "./library.ts";
import { inspectLocalEntry } from "./local-media.ts";
import {
  applyEpisodeOverrides,
  compositeFileId,
  fileSourceIndex,
  rawFileId,
  mergeSelectedFiles,
  MediaSelectionError,
  selectMediaFiles,
  type SelectedFile,
  type TorrentFile,
} from "./media-file-selection.ts";
import { TorrServerError, type TorrServerClient } from "./torrserver-client.ts";

// The primary source is index 0; extraSources follow in order. Composite file
// ids encode this index (see media-file-selection.ts).
export function torrentSources(entry: LibraryEntry): SeriesSource[] {
  return [
    {
      magnetUri: entry.magnetUri,
      torrentFilePath: entry.torrentFilePath,
      sourceHash: entry.sourceHash,
      fileOverrides: entry.fileOverrides,
      searchImport: entry.searchImport,
    },
    ...(entry.extraSources ?? []),
  ];
}

export function registerSource(
  source: SeriesSource,
  torrServer: TorrServerClient,
  title: string,
  signal?: AbortSignal,
) {
  return source.magnetUri
    ? signal
      ? torrServer.addMagnet(source.magnetUri, title, signal)
      : torrServer.addMagnet(source.magnetUri, title)
    : signal
      ? torrServer.addTorrentFile(source.torrentFilePath!, title, signal)
      : torrServer.addTorrentFile(source.torrentFilePath!, title);
}

export function selectReviewedMediaFiles(
  type: LibraryEntry["type"],
  hash: string,
  files: TorrentFile[],
  source: SeriesSource,
  preferredFileIndex?: number,
  reviewed: SearchImport | undefined = source.searchImport,
): SelectedFile[] {
  let selectable = files;
  if (
    reviewed?.filmPath &&
    preferredFileIndex === undefined &&
    !source.fileOverrides?.length
  ) {
    selectable = files.filter((file) => {
      const path = file.path.replaceAll("\\", "/");
      return (
        file.length === reviewed.filmSizeBytes &&
        (path === reviewed.filmPath || path.endsWith(`/${reviewed.filmPath}`))
      );
    });
    if (hash.toLowerCase() !== reviewed.hash || selectable.length !== 1)
      throw new MediaSelectionError(
        "The reviewed film file was not found uniquely. Review the source and select files explicitly.",
      );
  }
  return selectMediaFiles(
    type,
    selectable,
    preferredFileIndex,
    source.fileOverrides,
    source.seasonHint,
  );
}

export async function inspectEntry(
  entry: LibraryEntry,
  torrServer: TorrServerClient,
  library?: Library,
  options: { signal?: AbortSignal; timeoutMs?: number; fileId?: number } = {},
) {
  options.signal?.throwIfAborted();
  if (entry.localFilePath || entry.localFolderPath) {
    const local = await inspectLocalEntry(entry);
    options.signal?.throwIfAborted();
    return {
      hash: "",
      name: entry.name,
      files: local?.files ?? [],
      selectedFiles: applyEpisodeOverrides(
        local?.selectedFiles ?? [],
        entry.episodeOverrides,
      ),
    };
  }
  const sources = torrentSources(entry);
  if (options.fileId !== undefined) {
    const index = fileSourceIndex(options.fileId);
    const source = sources[index];
    if (!source)
      throw new MediaSelectionError("The requested source no longer exists");
    const cached = entry.inspectionCache?.selectedFiles;
    if (cached && !cached.some((file) => file.id === options.fileId))
      throw new MediaSelectionError("The requested file is no longer selected");
    markInspectActivity(entry.id);
    const registered = await registerSource(
      source,
      torrServer,
      entry.name,
      options.signal,
    );
    options.signal?.throwIfAborted();
    const status = await torrServer.waitForFiles(
      registered.hash,
      options.timeoutMs ?? 30_000,
      options.signal,
    );
    options.signal?.throwIfAborted();
    const selected = selectReviewedMediaFiles(
      entry.type,
      status.hash,
      status.file_stats,
      source,
      index === 0 ? entry.preferredFileIndex : undefined,
    );
    const requested = selected.find(
      (file) => file.id === rawFileId(options.fileId!),
    );
    if (!requested)
      throw new MediaSelectionError("The requested file is no longer selected");
    // Cached selections and explicit later-source mappings can supersede an
    // episode without making unrelated torrents a network prerequisite.
    const known = sources.map((_, sourceIndex) => ({
      hash: sourceIndex === index ? status.hash : "",
      selectedFiles:
        sourceIndex === index
          ? selected
          : (cached ?? [])
              .filter((file) => fileSourceIndex(file.id) === sourceIndex)
              .map((file) => ({ ...file, id: rawFileId(file.id) })),
    }));
    const merged = mergeSelectedFiles(known, entry.episodeOverrides);
    // A manual repair pins the file to its slot regardless of later sources.
    const repaired = entry.episodeOverrides?.some(
      (override) => override.id === options.fileId,
    );
    const shadowed =
      !repaired &&
      sources
        .slice(index + 1)
        .some((later) =>
          later.fileOverrides?.some(
            (override) =>
              override.included &&
              override.season !== undefined &&
              override.episode !== undefined &&
              override.season === requested.season &&
              override.episode === requested.episode,
          ),
        );
    if (shadowed || !merged.some((file) => file.id === options.fileId))
      throw new MediaSelectionError(
        "A later source replaces the requested episode",
      );
    const selectedFiles = merged.filter(
      (file) => fileSourceIndex(file.id) === index,
    );
    return {
      hash: status.hash,
      name: status.name ?? status.title,
      files: status.file_stats.map((file) => ({
        ...file,
        id: compositeFileId(index, file.id),
      })),
      selectedFiles,
      partial: sources.length > 1,
      totalSelectedFiles:
        cached || sources.length === 1 ? merged.length : undefined,
    };
  }
  const inspected: {
    hash: string;
    name: string;
    files: TorrentFile[];
    selectedFiles: SelectedFile[];
  }[] = [];
  // Sequential on purpose: adds are rare and TorrServer handles them better
  // one at a time.
  for (const [index, source] of sources.entries()) {
    options.signal?.throwIfAborted();
    markInspectActivity(entry.id);
    const registered = await registerSource(
      source,
      torrServer,
      entry.name,
      options.signal,
    );
    options.signal?.throwIfAborted();
    const status =
      options.signal || options.timeoutMs
        ? await torrServer.waitForFiles(
            registered.hash,
            options.timeoutMs ?? 30_000,
            options.signal,
          )
        : await torrServer.waitForFiles(registered.hash);
    markInspectActivity(entry.id);
    inspected.push({
      hash: status.hash,
      name: status.name ?? status.title,
      files: status.file_stats,
      selectedFiles: selectReviewedMediaFiles(
        entry.type,
        status.hash,
        status.file_stats,
        source,
        index === 0 ? entry.preferredFileIndex : undefined,
      ),
    });
  }
  const primary = inspected[0]!;
  const selectedFiles = mergeSelectedFiles(inspected, entry.episodeOverrides);
  options.signal?.throwIfAborted();
  if (library && selectedFiles.length) {
    await library
      .setInspectionCache(
        entry.id,
        {
          hash: primary.hash,
          selectedFiles,
          inspectedAt: new Date().toISOString(),
        },
        entrySourceRevision(entry),
      )
      .catch(() =>
        console.error(
          JSON.stringify({
            level: "warn",
            event: "inspection_cache_write_failed",
            entryId: entry.id,
          }),
        ),
      );
  }
  console.log(
    JSON.stringify({
      level: "info",
      event: "torrent_inspected",
      entryId: entry.id,
      hash: primary.hash,
      sources: inspected.length,
      selectedFileIds: selectedFiles.map((file) => file.id),
    }),
  );
  return {
    hash: primary.hash,
    name: primary.name,
    // Raw file listings with composite ids, so the management UI can match
    // selected files back to their source listing.
    files: inspected.flatMap((source, index) =>
      source.files.map((file) => ({
        ...file,
        id: compositeFileId(index, file.id),
      })),
    ),
    selectedFiles,
  };
}

// One full inspection per entry and source definition at a time: Stremio
// fires meta and stream requests together, and the management UI may click
// Inspect while a post-edit warm-up is still polling for metadata. Keyed by
// revision so an edit made mid-inspection starts its own run rather than
// joining one whose result the cache guard will reject.
const inflight = new Map<string, ReturnType<typeof inspectEntry>>();

export function sharedInspection(
  entry: LibraryEntry,
  torrServer: TorrServerClient,
  library: Library,
): ReturnType<typeof inspectEntry> {
  const key = `${entry.id}\u0000${entrySourceDefinitionRevision(entry)}`;
  let pending = inflight.get(key);
  if (!pending) {
    pending = inspectEntry(entry, torrServer, library).finally(() =>
      inflight.delete(key),
    );
    inflight.set(key, pending);
  }
  return pending;
}

export async function resolveStreamSource(
  entry: LibraryEntry,
  torrServer: TorrServerClient,
  library: Library,
): Promise<{ hash: string; selectedFiles: SelectedFile[] }> {
  if (entry.localFilePath || entry.localFolderPath) {
    const local = await inspectLocalEntry(entry);
    return {
      hash: "",
      selectedFiles: applyEpisodeOverrides(
        local?.selectedFiles ?? [],
        entry.episodeOverrides,
      ),
    };
  }
  if (entry.inspectionCache) {
    const { hash, selectedFiles } = entry.inspectionCache;
    // TorrServer already knows the torrents unless it restarted or dropped
    // them, so only pay for re-registration when a lookup actually misses.
    const sources = torrentSources(entry);
    const needed = new Map<string, SeriesSource>();
    for (const file of selectedFiles) {
      const source = sources[fileSourceIndex(file.id)];
      if (source) needed.set(file.hash ?? hash, source);
    }
    if (!needed.size) needed.set(hash, sources[0]!);
    for (const [sourceHash, source] of needed) {
      const known = await torrServer.get(sourceHash).catch((error: unknown) => {
        if (error instanceof TorrServerError && error.code === "not_found")
          return undefined;
        throw error;
      });
      if (!known) await registerSource(source, torrServer, entry.name);
    }
    return { hash, selectedFiles };
  }
  return sharedInspection(entry, torrServer, library);
}

// Registers the torrent ahead of the play click so the swarm is already
// connected when the stream request arrives, and — after a source edit
// dropped the cache — inspects in the background so Stremio's next meta
// request answers from the cache instead of polling every source. Failures
// are non-fatal because the stream request resolves the source again anyway.
const warming = new Set<string>();

export function warmStreamSource(
  entry: LibraryEntry,
  torrServer: TorrServerClient,
  library: Library,
): void {
  if (entry.localFilePath || entry.localFolderPath) return;
  const key = `${entry.id}\u0000${entrySourceDefinitionRevision(entry)}`;
  if (warming.has(key)) return;
  warming.add(key);
  void resolveStreamSource(entry, torrServer, library)
    .catch((error: unknown) =>
      console.error(
        JSON.stringify({
          level: "warn",
          event: "stream_prewarm_failed",
          entryId: entry.id,
          code:
            error instanceof TorrServerError
              ? error.code
              : "source_unavailable",
        }),
      ),
    )
    .finally(() => warming.delete(key));
}
