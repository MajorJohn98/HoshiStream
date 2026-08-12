import type { LibraryEntry } from "./types.js";
import { inspectLocalEntry } from "./local-media.js";
import { selectMediaFiles } from "./media-file-selection.js";
import type { TorrServerClient } from "./torrserver-client.js";

export async function inspectEntry(
  entry: LibraryEntry,
  torrServer: TorrServerClient,
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
  const registered = entry.magnetUri
    ? await torrServer.addMagnet(entry.magnetUri, entry.name)
    : await torrServer.addTorrentFile(entry.torrentFilePath!, entry.name);
  const status = await torrServer.waitForFiles(registered.hash);
  const selectedFiles = selectMediaFiles(
    entry.type,
    status.file_stats,
    entry.preferredFileIndex,
    entry.fileOverrides,
  );
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
