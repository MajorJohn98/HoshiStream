// Search text for Cinemeta from an entry name (ADR 0026). Entry names come
// from release folders more often than from a typed title, so strip what a
// release adds — group tags, season markers, quality/source/codec noise —
// pull out a year, and keep the words that name the title. Pure string
// work; nothing here touches the network.
import { NOISE } from "./episode-titles.ts";

export const MAX_TITLE_QUERY = 120;

export interface TitleQuery {
  title: string;
  year?: number;
}

// Season and pack markers that follow the title in a release name.
const SEASON_MARKER = new RegExp(
  [
    "\\bS\\d{1,3}(?:[ ._-]?E\\d{1,4})?(?:[ ._-]?S?\\d{1,3})?\\b",
    "\\bSeasons?[ ._-]?\\d{1,3}(?:[ ._-]?(?:-|to|&)[ ._-]?\\d{1,3})?\\b",
    "\\bSeries[ ._-]?\\d{1,3}\\b",
    "\\b\\d{1,3}x\\d{1,4}\\b",
    "\\bComplete(?:[ ._-]?(?:series|season|collection|pack))?\\b",
    "\\bBox[ ._-]?set\\b",
    "\\bTrilogy\\b",
    "\\bDuology\\b",
    "\\bPart[ ._-]?\\d{1,2}\\b",
    "\\bVol(?:ume)?[ ._-]?\\d{1,3}\\b",
    "\\bBatch\\b",
    "\\bE\\d{2,4}(?:[ ._-]?E?\\d{2,4})?\\b",
  ].join("|"),
  "i",
);
const YEAR = /(?<![\d])((?:19|20)\d{2})(?![\d])/g;
// Edition words that follow a film title but are not part of it.
const EDITION =
  /\b(?:imax|criterion|directors?[ ._-]?cut|theatrical(?:[ ._-]?cut)?|unrated|ultimate[ ._-]?edition|anniversary[ ._-]?edition|final[ ._-]?cut)\b/i;
const EXTENSION = /\.(?:mkv|mp4|avi|mov|m4v|webm|ts|wmv|torrent)$/i;

function tidy(value: string): string {
  return value
    .replace(/[._]+/g, " ")
    .replace(/\s+/g, " ")
    .replace(/^[\s\-–—:|]+|[\s\-–—:|]+$/g, "")
    .trim();
}

/** Cleaned title and (when one stands apart from the name) release year. */
export function titleQuery(name: string): TitleQuery {
  let work = name.replace(EXTENSION, "");
  // Bracketed groups are noise wherever they sit: "[Group] Show - 01".
  work = work.replace(/\[[^\]]*\]/g, " ").replace(/\{[^}]*\}/g, " ");
  // Keep a parenthesised year, drop other parentheticals ("(1080p)").
  work = work.replace(/\(([^)]*)\)/g, (_, inner: string) =>
    /^\s*(?:19|20)\d{2}\s*$/.test(inner) ? ` ${inner.trim()} ` : " ",
  );
  // Cut at the first release-noise token or season marker.
  const noise = NOISE.exec(work);
  if (noise && noise.index > 0) work = work.slice(0, noise.index);
  const marker = SEASON_MARKER.exec(work);
  if (marker && marker.index > 0) work = work.slice(0, marker.index);
  const edition = EDITION.exec(work);
  if (edition && edition.index > 0) work = work.slice(0, edition.index);
  // A trailing website tag or release group: "www.site.com - Title" / "-GRP".
  work = work.replace(/^www\.[^\s]+[\s._-]+/i, "");
  work = work.replace(/[ ._]-[A-Za-z0-9]+$/, "");

  let year: number | undefined;
  const spaced = tidy(work);
  const years = [...spaced.matchAll(YEAR)];
  // The last standalone year is the release year when text precedes it;
  // a title that *is* a year ("2012", "1917") keeps it.
  const last = years.at(-1);
  if (last && last.index !== undefined && last.index > 0) {
    year = Number(last[1]);
    work = spaced.slice(0, last.index) + spaced.slice(last.index + 4);
  } else work = spaced;
  let title = tidy(work).slice(0, MAX_TITLE_QUERY).trim();
  if (!title) title = tidy(name).slice(0, MAX_TITLE_QUERY) || name.trim();
  return year === undefined ? { title } : { title, year };
}

// Loose equality for auto-accepting a search hit: case, accents,
// punctuation and articles do not make a different title.
export function normalizeTitle(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/^(?:the|a|an) /, "")
    .trim();
}

/** Leading year of a Cinemeta releaseInfo ("2022–", "2019-2021", "2019"). */
export function releaseYear(releaseInfo: string | undefined) {
  const match = /^(\d{4})/.exec(releaseInfo ?? "");
  return match ? Number(match[1]) : undefined;
}
