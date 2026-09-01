import { extname } from "node:path";
import type { ContentType } from "./types.js";

export const VIDEO_EXTENSIONS = new Set([
  ".mp4",
  ".mkv",
  ".webm",
  ".avi",
  ".mov",
  ".m4v",
]);
const SAMPLE = /(?:^|[._\s-])(sample|trailer)(?:[._\s-]|$)/i;
// Bonus-content folders in season packs contain files whose names still match
// the episode pattern ("Deleted Scenes/S02E05 The Mole.mkv") and would
// otherwise shadow the real episode.
const EXTRAS_DIR =
  /(?:^|\/)(?:featurettes?|extras?|deleted[ ._-]scenes?|behind[ ._-]the[ ._-]scenes|bonus(?:es)?|interviews?|specials?|shorts?)\//i;

export type TorrentFile = { id: number; path: string; length: number };
export type SelectedFile = TorrentFile & {
  season?: number;
  episode?: number;
  // Owning torrent's hash when the entry has multiple sources.
  hash?: string;
};
export type FileOverride = {
  id: number;
  included: boolean;
  season?: number;
  episode?: number;
};

// Multi-torrent series: TorrServer file ids are per-torrent indexes, so files
// from source k get `k * SOURCE_STRIDE + id` to stay unique per entry. Source
// 0 (the primary) keeps its raw ids, which keeps existing caches, playback
// state, and URLs valid.
export const SOURCE_STRIDE = 100_000;

export function compositeFileId(sourceIndex: number, rawId: number): number {
  return sourceIndex * SOURCE_STRIDE + rawId;
}

export function rawFileId(id: number): number {
  return id % SOURCE_STRIDE;
}

export function fileSourceIndex(id: number): number {
  return Math.floor(id / SOURCE_STRIDE);
}

export class MediaSelectionError extends Error {}

export function isPlayablePath(path: string): boolean {
  return VIDEO_EXTENSIONS.has(extname(path).toLowerCase());
}

function playable(file: TorrentFile): boolean {
  return isPlayablePath(file.path);
}

function episodeNumbers(
  path: string,
): { season: number; episode: number } | undefined {
  const match =
    /s(\d{1,2})e(\d{1,3})(?!\d)|(?<!\d)(\d{1,2})x(\d{1,3})(?!\d)/i.exec(path);
  if (!match) return undefined;
  return {
    season: Number(match[1] ?? match[3]),
    episode: Number(match[2] ?? match[4]),
  };
}

export function selectMediaFiles(
  type: ContentType,
  files: TorrentFile[],
  preferredFileIndex?: number,
  overrides: FileOverride[] = [],
  seasonHint?: number,
): SelectedFile[] {
  if (preferredFileIndex !== undefined) {
    const preferred = files.find((file) => file.id === preferredFileIndex);
    if (!preferred || !playable(preferred)) {
      throw new MediaSelectionError(
        `Preferred file index ${preferredFileIndex} is not playable`,
      );
    }
    return [preferred];
  }

  const configured = new Map(
    overrides.map((override) => [override.id, override]),
  );
  const videos = files.filter(
    (file) => playable(file) && configured.get(file.id)?.included !== false,
  );
  const withoutSamples = videos.filter((file) => !SAMPLE.test(file.path));
  const mainCandidates = withoutSamples.filter(
    (file) => !EXTRAS_DIR.test(file.path),
  );
  const candidates = mainCandidates.length
    ? mainCandidates
    : withoutSamples.length
      ? withoutSamples
      : videos;
  if (!candidates.length)
    throw new MediaSelectionError("Torrent contains no playable video files");

  if (type === "movie") {
    return [
      candidates.reduce((largest, file) =>
        file.length > largest.length ? file : largest,
      ),
    ];
  }

  return candidates
    .sort((a, b) => a.path.localeCompare(b.path))
    .map((file, index) => {
      const override = configured.get(file.id);
      return {
        ...file,
        ...(override?.season !== undefined && override.episode !== undefined
          ? { season: override.season, episode: override.episode }
          : (episodeNumbers(file.path) ?? {
              season: seasonHint ?? 1,
              episode: index + 1,
            })),
      };
    })
    .sort(
      (a, b) =>
        a.season! - b.season! ||
        a.episode! - b.episode! ||
        a.path.localeCompare(b.path),
    );
}

// Combines per-source selections into one episode list: ids become composite,
// each file remembers its torrent's hash, and when two sources claim the same
// (season, episode) the later source wins — adding a better pack afterwards
// replaces the older episodes.
export function mergeSelectedFiles(
  sources: { hash: string; selectedFiles: SelectedFile[] }[],
): SelectedFile[] {
  const byEpisode = new Map<string, SelectedFile>();
  const unmapped: SelectedFile[] = [];
  for (const [sourceIndex, source] of sources.entries()) {
    for (const file of source.selectedFiles) {
      const mapped: SelectedFile = {
        ...file,
        id: compositeFileId(sourceIndex, file.id),
        ...(sourceIndex > 0 ? { hash: source.hash } : {}),
      };
      if (mapped.season === undefined || mapped.episode === undefined) {
        unmapped.push(mapped);
        continue;
      }
      const key = `${mapped.season}:${mapped.episode}`;
      const existing = byEpisode.get(key);
      if (existing) {
        console.log(
          JSON.stringify({
            level: "warn",
            event: "duplicate_episode_dropped",
            season: mapped.season,
            episode: mapped.episode,
            droppedFileId: existing.id,
          }),
        );
      }
      byEpisode.set(key, mapped);
    }
  }
  return [...byEpisode.values(), ...unmapped].sort(
    (a, b) =>
      (a.season ?? 0) - (b.season ?? 0) ||
      (a.episode ?? 0) - (b.episode ?? 0) ||
      a.path.localeCompare(b.path),
  );
}
