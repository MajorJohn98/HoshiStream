import { markInspectActivity } from "./activity.ts";
import { entrySourceRevision } from "./imports/source-identity.ts";
import type { LibraryEntry, SearchImport, SeriesSource } from "./types.ts";
import type { Library } from "./library.ts";
import { inspectLocalEntry } from "./local-media.ts";
import {
  compositeFileId,
  fileSourceIndex,
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
  options: { signal?: AbortSignal; timeoutMs?: number } = {},
) {
  if (entry.localFilePath || entry.localFolderPath) {
    const local = await inspectLocalEntry(entry);
    options.signal?.throwIfAborted();
    return {
      hash: "",
      name: entry.name,
      files: local?.files ?? [],
      selectedFiles: local?.selectedFiles ?? [],
    };
  }
  const sources = torrentSources(entry);
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
  const selectedFiles = mergeSelectedFiles(inspected);
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

export async function resolveStreamSource(
  entry: LibraryEntry,
  torrServer: TorrServerClient,
  library: Library,
): Promise<{ hash: string; selectedFiles: SelectedFile[] }> {
  if (entry.localFilePath || entry.localFolderPath) {
    const local = await inspectLocalEntry(entry);
    return { hash: "", selectedFiles: local?.selectedFiles ?? [] };
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
  return inspectEntry(entry, torrServer, library);
}

// Registers the torrent ahead of the play click so the swarm is already
// connected when the stream request arrives. Failures are non-fatal because
// the stream request resolves the source again anyway.
const warming = new Set<string>();

export function warmStreamSource(
  entry: LibraryEntry,
  torrServer: TorrServerClient,
  library: Library,
): void {
  if (entry.localFilePath || entry.localFolderPath) return;
  if (warming.has(entry.id)) return;
  warming.add(entry.id);
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
    .finally(() => warming.delete(entry.id));
}
