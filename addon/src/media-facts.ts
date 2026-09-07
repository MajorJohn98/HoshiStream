import { assessDirectPlay } from "./direct-play.ts";
import { entrySourceDefinitionRevision } from "./imports/source-identity.ts";
import type { SelectedFile } from "./media-file-selection.ts";
import type { LibraryEntry } from "./types.ts";

export function mediaFactForFile(
  entry: LibraryEntry,
  file: SelectedFile,
  resolvedHash?: string,
) {
  const revision = entrySourceDefinitionRevision(entry);
  const hash = file.hash ?? resolvedHash ?? entry.inspectionCache?.hash;
  return entry.mediaFacts?.find(
    (fact) =>
      fact.revision === revision &&
      fact.fileId === file.id &&
      fact.filePath === file.path &&
      fact.fileLength === file.length &&
      (entry.localFilePath || entry.localFolderPath
        ? fact.sourceHash === undefined || fact.sourceHash === ""
        : fact.sourceHash === hash),
  );
}

export function directPlayForFile(
  entry: LibraryEntry,
  file: SelectedFile,
  resolvedHash?: string,
) {
  const fact = mediaFactForFile(entry, file, resolvedHash);
  if (!fact) return undefined;
  return {
    ...assessDirectPlay(fact.technical),
    probedAt: fact.observedAt,
  };
}
