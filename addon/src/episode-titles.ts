// Readable episode titles from release filenames (Phase 13). Pure string
// work: strip the extension and release-group noise, keep whatever text
// follows the SxxEyy token, and fall back to "Episode N" when nothing
// human-readable is left. Viewer overrides in entry.episodes win.
import type { Episodes, LibraryEntry } from "./types.ts";
import { episodeKey } from "./types.ts";

const EPISODE_TOKEN = /\bS(\d{1,3})[ ._-]?E(\d{1,4})(?:[ ._-]?E\d{1,4})*\b/i;
const ALT_EPISODE_TOKEN = /\b(\d{1,3})x(\d{1,4})\b/i;
// Anything from here to the end is release metadata, not a title.
const NOISE = new RegExp(
  [
    "\\b(?:2160p|1080p|720p|480p|4k|uhd)\\b",
    "\\b(?:web[ ._-]?dl|webrip|web|bluray|blu[ ._-]?ray|bdrip|brrip|hdtv|dvdrip|hdrip|remux|amzn|nf|dsnp|hmax|atvp|itunes)\\b",
    "\\b(?:x264|x265|h[ ._-]?264|h[ ._-]?265|hevc|avc|av1|xvid|divx|vp9)\\b",
    "\\b(?:aac|ac3|eac3|dd[p+]?[ ._-]?\\d|dts(?:[ ._-]?hd)?|truehd|atmos|flac|opus|mp3|ma|5[ ._]1|7[ ._]1|2[ ._]0)\\b",
    "\\b(?:hdr(?:10)?\\+?|dv|dolby[ ._-]?vision|sdr|10bit|8bit|hi10p)\\b",
    "\\b(?:proper|repack|internal|limited|extended|uncut|remastered|multi|dual[ ._-]?audio|subbed|dubbed)\\b",
    "\\[[^\\]]*\\]",
    "\\([^)]*\\)",
  ].join("|"),
  "i",
);
const EXTENSION = /\.[A-Za-z0-9]{2,4}$/;

function basename(path: string): string {
  const parts = path.split(/[\\/]/);
  return parts[parts.length - 1] ?? path;
}

function tidy(text: string): string {
  return text
    .replace(/[._]+/g, " ")
    .replace(/\s+/g, " ")
    .replace(/^[\s\-–—:]+|[\s\-–—:]+$/g, "")
    .trim();
}

/** Title text from a release filename, or "Episode N" when none survives. */
export function cleanEpisodeTitle(
  path: string,
  season?: number,
  episode?: number,
): string {
  let name = basename(path).replace(EXTENSION, "");
  // Bracketed groups are noise wherever they sit: "[Group] Show - 01 [1080p]".
  name = name.replace(/\[[^\]]*\]/g, " ");
  const token = EPISODE_TOKEN.exec(name) ?? ALT_EPISODE_TOKEN.exec(name);
  // "Show - 01 (1080p)": no SxxEyy token, just the show name and a number
  // that is the episode itself. That is not a title.
  if (
    !token &&
    episode !== undefined &&
    new RegExp(`(?:^|[\\s._-])0*${episode}(?=[\\s._-]|$)`).test(name)
  )
    return `Episode ${episode}`;
  let candidate = token ? name.slice(token.index + token[0].length) : name;
  const noise = NOISE.exec(candidate);
  if (noise) candidate = candidate.slice(0, noise.index);
  // A trailing "-GROUP" only counts as a group tag when it ends the string.
  candidate = candidate.replace(/[ ._]-[A-Za-z0-9]+$/, "");
  const title = tidy(candidate);
  if (title && !/^\d+$/.test(title)) return title;
  const number = episode ?? (token ? Number(token[2]) : undefined);
  if (number !== undefined) return `Episode ${number}`;
  return tidy(name.replace(NOISE, " ")) || basename(path);
}

/** The viewer's title override, else the cleaned filename. */
export function episodeTitle(
  entry: Pick<LibraryEntry, "episodes">,
  file: { path: string; season?: number; episode?: number },
): string {
  const override = episodeOverrideFor(entry.episodes, file);
  return (
    override?.title ?? cleanEpisodeTitle(file.path, file.season, file.episode)
  );
}

export function episodeOverrideFor(
  episodes: Episodes | undefined,
  file: { season?: number; episode?: number },
) {
  if (!episodes || file.season === undefined || file.episode === undefined)
    return undefined;
  return episodes[episodeKey(file.season, file.episode)];
}
