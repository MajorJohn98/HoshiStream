import { registerSource, selectReviewedMediaFiles } from "../inspection.ts";
import type { Library } from "../library.ts";
import {
  compositeFileId,
  fileSourceIndex,
  MediaSelectionError,
  SOURCE_STRIDE,
  type SelectedFile,
} from "../media-file-selection.ts";
import type { TorrServerClient } from "../torrserver-client.ts";
import {
  seriesSourceSchema,
  type InspectionCache,
  type LibraryEntry,
  type SearchReceipt,
  type SeriesSource,
} from "../types.ts";
import { ImportError } from "./errors.ts";
import {
  entryHasHash,
  entrySourceRevision,
  magnetHash,
} from "./source-identity.ts";

export type SeriesPreviewPlan = {
  entryId: string;
  entryName: string;
  sourceRevision: string;
  source: SeriesSource;
  hash: string;
  addedEpisodes: Array<{ season: number; episode: number; path: string }>;
  replacements: Array<{
    season: number;
    episode: number;
    previousPath: string;
    incomingPath: string;
  }>;
  inspectionCache: InspectionCache;
};

export function isTorrentSeriesEntry(entry: LibraryEntry): boolean {
  return (
    entry.type === "series" &&
    !entry.localFilePath &&
    !entry.localFolderPath &&
    Boolean(entry.magnetUri || entry.torrentFilePath)
  );
}

export function hasSeriesInspection(entry: LibraryEntry): boolean {
  return Boolean(
    entry.inspectionCache &&
    !entry.inspectionCache.selectedFiles.some(
      (file) =>
        file.season === undefined ||
        file.episode === undefined ||
        fileSourceIndex(file.id) > (entry.extraSources?.length ?? 0) ||
        (fileSourceIndex(file.id) > 0 && !file.hash),
    ),
  );
}

export class ImportSeries {
  private readonly library: Library;
  private readonly torrServer: TorrServerClient;

  constructor(library: Library, torrServer: TorrServerClient) {
    this.library = library;
    this.torrServer = torrServer;
  }

  async preview(
    source: SeriesSource,
    entryId: string,
    signal?: AbortSignal,
  ): Promise<SeriesPreviewPlan> {
    signal?.throwIfAborted();
    const entry = await this.library.get(entryId);
    if (!entry || !isTorrentSeriesEntry(entry))
      throw new ImportError(
        "invalid_target",
        "Choose an existing torrent-backed series.",
        400,
      );
    source = seriesSourceSchema.parse(source);
    if (Boolean(source.magnetUri) === Boolean(source.torrentFilePath))
      throw new ImportError("invalid_source", "Choose one torrent source.");
    const expectedHash =
      source.sourceHash ??
      source.searchImport?.hash ??
      magnetHash(source.magnetUri);
    if (expectedHash && entryHasHash(entry, expectedHash))
      throw new ImportError(
        "already_attached",
        "This torrent is already attached to the series.",
        409,
      );
    const cache = entry.inspectionCache;
    if (!cache || !hasSeriesInspection(entry))
      throw new ImportError(
        "inspect_required",
        "Inspect this series and its episode selection before adding a source.",
        409,
      );
    const registered = await registerSource(
      source,
      this.torrServer,
      entry.name,
      signal,
    );
    const status = signal
      ? await this.torrServer.waitForFiles(registered.hash, 30_000, signal)
      : await this.torrServer.waitForFiles(registered.hash);
    signal?.throwIfAborted();
    const hash = status.hash.toLowerCase();
    if (
      !/^[0-9a-f]{40}$/.test(hash) ||
      registered.hash.toLowerCase() !== hash ||
      (expectedHash && expectedHash !== hash) ||
      (source.magnetUri && magnetHash(source.magnetUri) !== hash)
    )
      throw new ImportError(
        "source_mismatch",
        "The inspected torrent does not match the selected source.",
      );
    if (entryHasHash(entry, hash))
      throw new ImportError(
        "already_attached",
        "This torrent is already attached to the series.",
        409,
      );
    let incoming: SelectedFile[];
    try {
      incoming = selectReviewedMediaFiles(
        "series",
        hash,
        status.file_stats,
        source,
      );
    } catch (error) {
      if (!(error instanceof MediaSelectionError)) throw error;
      throw new ImportError(
        "no_episodes",
        "No usable episodes were found. Review this torrent's file selection.",
      );
    }
    if (
      incoming.some(
        (file) =>
          file.id >= SOURCE_STRIDE ||
          file.season === undefined ||
          file.episode === undefined,
      )
    )
      throw new ImportError(
        "invalid_source",
        "The torrent's episode indexes are unsupported.",
      );
    const sourceIndex = (entry.extraSources?.length ?? 0) + 1;
    const selected = new Map(
      cache.selectedFiles.map((file) => [
        `${file.season}:${file.episode}`,
        file,
      ]),
    );
    const incomingEpisodes = new Map(
      incoming.map((file) => [`${file.season}:${file.episode}`, file]),
    );
    const addedEpisodes: SeriesPreviewPlan["addedEpisodes"] = [];
    const replacements: SeriesPreviewPlan["replacements"] = [];
    for (const [key, file] of incomingEpisodes) {
      const episode = { season: file.season!, episode: file.episode! };
      const previous = selected.get(key);
      if (previous)
        replacements.push({
          ...episode,
          previousPath: previous.path,
          incomingPath: file.path,
        });
      else addedEpisodes.push({ ...episode, path: file.path });
      selected.set(key, {
        ...file,
        id: compositeFileId(sourceIndex, file.id),
        hash,
      });
    }
    return {
      entryId,
      entryName: entry.name,
      sourceRevision: entrySourceRevision(entry),
      source: {
        ...source,
        sourceHash: hash,
      },
      hash,
      addedEpisodes,
      replacements,
      inspectionCache: {
        hash: cache.hash,
        selectedFiles: [...selected.values()].sort(
          (a, b) =>
            a.season! - b.season! ||
            a.episode! - b.episode! ||
            a.path.localeCompare(b.path),
        ),
        inspectedAt: new Date().toISOString(),
      },
    };
  }

  commit(
    plan: SeriesPreviewPlan,
    receipt: SearchReceipt,
    allowReplace: boolean,
  ) {
    return this.library.appendImportedSeries(plan, receipt, allowReplace);
  }
}
