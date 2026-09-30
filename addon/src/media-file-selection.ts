import { extname } from "node:path";
import type { ContentType } from "./types.ts";

export const VIDEO_EXTENSIONS = new Set([
  ".mp4",
  ".mkv",
  ".webm",
  ".avi",
  ".mov",
  ".m4v",
]);
const SAMPLE = /(?:^|[/._\s-])(sample|trailer)(?:[/._\s-]|$)/i;
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
export type EpisodeOverride = { id: number; season: number; episode: number };

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

// Re-homes a composite file id after sources move: `sourceMap[old]` is the
// source's new index, or undefined when the source was removed.
export function remapFileId(
  id: number,
  sourceMap: (number | undefined)[],
): number | undefined {
  const to = sourceMap[fileSourceIndex(id)];
  return to === undefined ? undefined : compositeFileId(to, rawFileId(id));
}

export class MediaSelectionError extends Error {}

export function isPlayablePath(path: string): boolean {
  return VIDEO_EXTENSIONS.has(extname(path).toLowerCase());
}

function playable(file: TorrentFile): boolean {
  return isPlayablePath(file.path);
}

// Season and episode together: "S01E02", "S01 E02", "S01.E02", "1x02",
// "Season 1 Episode 2". Explicit numbering is used verbatim.
const EXPLICIT_EPISODE = [
  /s(\d{1,2})[ ._-]?e(\d{1,3})(?!\d)/i,
  /(?<!\d)(\d{1,2})x(\d{1,3})(?!\d)/i,
  /(?<![a-z0-9])season[ ._-]*(\d{1,2})[ ._-]*(?:episode|ep)[ ._-]*(\d{1,3})(?!\d)/i,
];
// Episode number alone, matched against the file name without extension:
// "Episode 5", "Ep05", "E05", "[Group] Show - 05 [1080p]", "05 - Title".
const LOOSE_EPISODE = [
  /(?<![a-z0-9])(?:episode|ep)[ ._-]*(\d{1,3})(?!\d)/i,
  /(?<![a-z0-9])e(\d{1,3})(?!\d)/i,
  /(?:^|[\s_])-[\s_]+(\d{1,3})(?:v\d)?(?=$|[\s._[(])/,
  /^(\d{1,3})(?:v\d)?(?=$|[\s._]|-(?!\d))/,
];
// Season alone, from the name or any folder: "Season 2", "Series 2", or a
// standalone "S02" token ("Show.S02.1080p/…").
const LOOSE_SEASON = [
  /(?<![a-z0-9])(?:season|series)[ ._-]*(\d{1,2})(?!\d)/i,
  /(?<![a-z0-9])s(\d{1,2})(?![\da-z])/i,
];

export type ParsedEpisode = {
  season?: number;
  episode?: number;
  // True when season and episode were named together; hints never override
  // explicit numbering.
  explicit: boolean;
};

function firstMatch(patterns: RegExp[], texts: string[]) {
  for (const text of texts)
    for (const pattern of patterns) {
      const match = pattern.exec(text);
      if (match) return match;
    }
  return undefined;
}

export function parseEpisodeNumbers(path: string): ParsedEpisode {
  const segments = path.replaceAll("\\", "/").split("/").filter(Boolean);
  const base = segments.at(-1) ?? "";
  const stem = extname(base) ? base.slice(0, -extname(base).length) : base;
  const explicit = firstMatch(EXPLICIT_EPISODE, [stem, path]);
  if (explicit)
    return {
      season: Number(explicit[1]),
      episode: Number(explicit[2]),
      explicit: true,
    };
  const episode = firstMatch(LOOSE_EPISODE, [stem]);
  const season = firstMatch(LOOSE_SEASON, [
    stem,
    ...segments.slice(0, -1).reverse(),
  ]);
  return {
    ...(season ? { season: Number(season[1]) } : {}),
    ...(episode && Number(episode[1]) > 0
      ? { episode: Number(episode[1]) }
      : {}),
    explicit: false,
  };
}

// Per-source numbering for files whose names carry no explicit SxxEyy: the
// season they belong to, and the episode the first of them starts at.
export type SourceHints = { seasonHint?: number; episodeHint?: number };

export function selectMediaFiles(
  type: ContentType,
  files: TorrentFile[],
  preferredFileIndex?: number,
  overrides: FileOverride[] = [],
  hints: SourceHints = {},
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

  // Precedence: per-file override, explicit SxxEyy, the source's hints, then
  // numbers guessed from the name, then the file's position in the torrent.
  // Guessed episode numbers are trusted only when they are unique within the
  // torrent: "12 Monkeys Pilot.mkv" and "12 Monkeys Splinter.mkv" must not
  // both become episode 12.
  const sorted = candidates.sort((a, b) => a.path.localeCompare(b.path));
  const parsed = sorted.map((file) => parseEpisodeNumbers(file.path));
  const guessed = sorted.flatMap((file, index) => {
    const override = configured.get(file.id);
    const numbers = parsed[index]!;
    return (override?.season !== undefined && override.episode !== undefined) ||
      numbers.explicit ||
      numbers.episode === undefined
      ? []
      : [numbers.episode];
  });
  const trustGuesses = new Set(guessed).size === guessed.length;
  return sorted
    .map((file, index) => {
      const override = configured.get(file.id);
      if (override?.season !== undefined && override.episode !== undefined)
        return { ...file, season: override.season, episode: override.episode };
      const numbers = parsed[index]!;
      if (numbers.explicit)
        return { ...file, season: numbers.season!, episode: numbers.episode! };
      return {
        ...file,
        season: hints.seasonHint ?? numbers.season ?? 1,
        episode:
          hints.episodeHint !== undefined
            ? hints.episodeHint + index
            : ((trustGuesses ? numbers.episode : undefined) ?? index + 1),
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
// replaces the older episodes. Manual repairs (episodeOverrides, keyed by
// composite id) are applied here so a repaired file always keeps its slot and
// is never dropped as an automatic duplicate.
export function mergeSelectedFiles(
  sources: { hash: string; selectedFiles: SelectedFile[] }[],
  overrides: EpisodeOverride[] = [],
): SelectedFile[] {
  const byOverrideId = new Map(
    overrides.map((override) => [override.id, override]),
  );
  const repaired: SelectedFile[] = [];
  const automatic: SelectedFile[] = [];
  for (const [sourceIndex, source] of sources.entries()) {
    for (const file of source.selectedFiles) {
      const mapped: SelectedFile = {
        ...file,
        id: compositeFileId(sourceIndex, file.id),
        ...(sourceIndex > 0 ? { hash: source.hash } : {}),
      };
      const override = byOverrideId.get(mapped.id);
      if (override) {
        repaired.push({
          ...mapped,
          season: override.season,
          episode: override.episode,
        });
      } else {
        automatic.push(mapped);
      }
    }
  }
  const claimed = new Set(
    repaired.map((file) => `${file.season}:${file.episode}`),
  );
  const byEpisode = new Map<string, SelectedFile>();
  const unmapped: SelectedFile[] = [];
  for (const file of automatic) {
    if (file.season === undefined || file.episode === undefined) {
      unmapped.push(file);
      continue;
    }
    const key = `${file.season}:${file.episode}`;
    if (claimed.has(key)) {
      logDropped("episode_override_shadowed", file);
      continue;
    }
    const existing = byEpisode.get(key);
    if (existing) logDropped("duplicate_episode_dropped", existing);
    byEpisode.set(key, file);
  }
  return sortEpisodes([...repaired, ...byEpisode.values(), ...unmapped]);
}

function logDropped(event: string, file: SelectedFile): void {
  console.log(
    JSON.stringify({
      level: "warn",
      event,
      season: file.season,
      episode: file.episode,
      droppedFileId: file.id,
    }),
  );
}

function sortEpisodes(files: SelectedFile[]): SelectedFile[] {
  return files.sort(
    (a, b) =>
      (a.season ?? 0) - (b.season ?? 0) ||
      (a.episode ?? 0) - (b.episode ?? 0) ||
      a.path.localeCompare(b.path),
  );
}

// Applies manual season/episode repairs to a single-source selection (local
// folders, which never go through mergeSelectedFiles). Overridden files keep
// their slot; an automatically mapped file on the same (season, episode) is
// dropped so Stremio never sees two videos for one episode. Overrides for
// files that are no longer selected are ignored.
export function applyEpisodeOverrides(
  files: SelectedFile[],
  overrides: EpisodeOverride[] = [],
): SelectedFile[] {
  if (!overrides.length) return files;
  const byId = new Map(overrides.map((override) => [override.id, override]));
  const repaired: SelectedFile[] = [];
  const automatic: SelectedFile[] = [];
  for (const file of files) {
    const override = byId.get(file.id);
    if (override) {
      repaired.push({
        ...file,
        season: override.season,
        episode: override.episode,
      });
    } else {
      automatic.push(file);
    }
  }
  if (!repaired.length) return files;
  const claimed = new Set(
    repaired.map((file) => `${file.season}:${file.episode}`),
  );
  const kept = automatic.filter((file) => {
    if (file.season === undefined || file.episode === undefined) return true;
    if (!claimed.has(`${file.season}:${file.episode}`)) return true;
    logDropped("episode_override_shadowed", file);
    return false;
  });
  return sortEpisodes([...repaired, ...kept]);
}
