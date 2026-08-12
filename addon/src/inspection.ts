import type { LibraryEntry } from "./types.js";
import type { Library } from "./library.js";
import { inspectLocalEntry } from "./local-media.js";
import { selectMediaFiles, type SelectedFile } from "./media-file-selection.js";
import type { TorrServerClient } from "./torrserver-client.js";

function registerTorrent(entry: LibraryEntry, torrServer: TorrServerClient) {
  return entry.magnetUri
    ? torrServer.addMagnet(entry.magnetUri, entry.name)
    : torrServer.addTorrentFile(entry.torrentFilePath!, entry.name);
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
  const registered = await registerTorrent(entry, torrServer);
  const status = await torrServer.waitForFiles(registered.hash);
  const selectedFiles = selectMediaFiles(
    entry.type,
    status.file_stats,
    entry.preferredFileIndex,
    entry.fileOverrides,
  );
  if (library && selectedFiles.length) {
    await library
      .setInspectionCache(entry.id, {
        hash: status.hash,
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
      hash: status.hash,
      selectedFileIds: selectedFiles.map((file) => file.id),
    }),
  );
  return {
    hash: status.hash,
    name: status.name ?? status.title,
    files: status.file_stats,
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
    await registerTorrent(entry, torrServer);
    return {
      hash: entry.inspectionCache.hash,
      selectedFiles: entry.inspectionCache.selectedFiles,
    };
  }
  return inspectEntry(entry, torrServer, library);
}
