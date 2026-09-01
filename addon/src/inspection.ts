import type { LibraryEntry, SeriesSource } from "./types.js";
import type { Library } from "./library.js";
import { inspectLocalEntry } from "./local-media.js";
import {
  compositeFileId,
  fileSourceIndex,
  mergeSelectedFiles,
  selectMediaFiles,
  type SelectedFile,
  type TorrentFile,
} from "./media-file-selection.js";
import type { TorrServerClient } from "./torrserver-client.js";

// The primary source is index 0; extraSources follow in order. Composite file
// ids encode this index (see media-file-selection.ts).
export function torrentSources(entry: LibraryEntry): SeriesSource[] {
  return [
    {
      magnetUri: entry.magnetUri,
      torrentFilePath: entry.torrentFilePath,
      fileOverrides: entry.fileOverrides,
    },
    ...(entry.extraSources ?? []),
  ];
}

function registerSource(
  source: SeriesSource,
  torrServer: TorrServerClient,
  title: string,
) {
  return source.magnetUri
    ? torrServer.addMagnet(source.magnetUri, title)
    : torrServer.addTorrentFile(source.torrentFilePath!, title);
}

export async function inspectEntry(
  entry: LibraryEntry,
  torrServer: TorrServerClient,
  library?: Library,
) {
  if (entry.localFilePath || entry.localFolderPath) {
    const local = await inspectLocalEntry(entry);
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
    const registered = await registerSource(source, torrServer, entry.name);
    const status = await torrServer.waitForFiles(registered.hash);
    inspected.push({
      hash: status.hash,
      name: status.name ?? status.title,
      files: status.file_stats,
      selectedFiles: selectMediaFiles(
        entry.type,
        status.file_stats,
        index === 0 ? entry.preferredFileIndex : undefined,
        source.fileOverrides,
        source.seasonHint,
      ),
    });
  }
  const primary = inspected[0]!;
  const selectedFiles = mergeSelectedFiles(inspected);
  if (library && selectedFiles.length) {
    await library
      .setInspectionCache(entry.id, {
        hash: primary.hash,
        selectedFiles,
        inspectedAt: new Date().toISOString(),
      })
      .catch((error: unknown) =>
        console.error(
          JSON.stringify({
            level: "warn",
            event: "inspection_cache_write_failed",
            entryId: entry.id,
            error: error instanceof Error ? error.message : String(error),
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
      const known = await torrServer.get(sourceHash).catch(() => undefined);
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
          error: error instanceof Error ? error.message : String(error),
        }),
      ),
    )
    .finally(() => warming.delete(entry.id));
}
