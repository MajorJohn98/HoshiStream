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

export type TorrentFile = { id: number; path: string; length: number };
export type SelectedFile = TorrentFile & { season?: number; episode?: number };
export type FileOverride = {
  id: number;
  included: boolean;
  season?: number;
  episode?: number;
};

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
  const candidates = withoutSamples.length ? withoutSamples : videos;
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
          : (episodeNumbers(file.path) ?? { season: 1, episode: index + 1 })),
      };
    })
    .sort(
      (a, b) =>
        a.season! - b.season! ||
        a.episode! - b.episode! ||
        a.path.localeCompare(b.path),
    );
}
