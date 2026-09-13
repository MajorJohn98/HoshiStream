import { entrySourceDefinitionRevision } from "./imports/source-identity.ts";
import type { Library } from "./library.ts";
import {
  RECENTLY_ADDED_ID,
  TAG_CATALOG_PREFIX,
  UNWATCHED_ID,
} from "./manifest.ts";
import { tagKey } from "./tags.ts";
import type { LibraryEntry } from "./types.ts";
import type { SelectedFile } from "./media-file-selection.ts";
import {
  lastWatchActivity,
  resumeFile,
  watchableFiles,
} from "./watch-state.ts";

const PAGE_SIZE = 100;
export const CONTINUE_WATCHING_ID = "continue-watching";

// Stremio renders `links` as tappable chips; a search deep link keeps them
// useful without a metadata provider.
export function searchLink(category: string, name: string) {
  return {
    name,
    category,
    url: `stremio:///search?search=${encodeURIComponent(name)}`,
  };
}

// "1h 52m" from the probe of the entry's current source, for movies whose
// runtime has not been typed in. Series runtimes vary per episode, so they
// are left to the user.
export function derivedRuntime(entry: LibraryEntry): string | undefined {
  if (entry.type !== "movie") return undefined;
  const revision = entrySourceDefinitionRevision(entry);
  const seconds = entry.mediaFacts?.find(
    (fact) => fact.revision === revision && fact.technical.durationSeconds,
  )?.technical.durationSeconds;
  if (!seconds) return undefined;
  const minutes = Math.round(seconds / 60);
  if (minutes < 1) return undefined;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return hours ? `${hours}h${rest ? ` ${rest}m` : ""}` : `${rest}m`;
}

export function toMetaPreview(entry: LibraryEntry) {
  const links = [
    ...(entry.tags ?? []).map((tag) => searchLink("Genres", tag)),
    ...(entry.cast ?? []).map((name) => searchLink("Cast", name)),
  ];
  return {
    id: entry.id,
    type: entry.type,
    name: entry.name,
    description: entry.description,
    poster: entry.poster,
    posterShape: entry.posterShape ?? "poster",
    background: entry.background,
    ...(entry.tags?.length ? { genres: [...entry.tags] } : {}),
    releaseInfo: entry.releaseInfo,
    runtime: entry.runtime ?? derivedRuntime(entry),
    imdbRating: entry.imdbRating,
    cast: entry.cast,
    director: entry.director,
    writer: entry.writer,
    country: entry.country,
    language: entry.language,
    logo: entry.logo,
    awards: entry.awards,
    trailers: entry.trailers,
    ...(links.length ? { links } : {}),
    // Movies have one video; opening the stream picker directly skips an
    // empty episode list.
    ...(entry.type === "movie"
      ? { behaviorHints: { defaultVideoId: entry.id } }
      : {}),
  };
}

// Stremio's video id for a file: movies have one video (the entry itself);
// series videos are keyed by season and episode (metadata.ts).
export function videoIdFor(entry: LibraryEntry, file: SelectedFile): string {
  return entry.type === "movie"
    ? entry.id
    : `${entry.id}:${file.season}:${file.episode}`;
}

// Entries with something to resume, newest activity first, each opening on
// the file playback should pick up at. Entries whose every file is watched
// drop out, so the row stays a to-do list rather than a history.
export async function continueWatching(library: Library, type: string) {
  const rows: { entry: LibraryEntry; file: SelectedFile; at: number }[] = [];
  for (const entry of await library.list()) {
    if (entry.type !== type || !entry.watchStates?.length) continue;
    const file = resumeFile(entry, await watchableFiles(entry));
    if (file) rows.push({ entry, file, at: lastWatchActivity(entry) });
  }
  return rows
    .sort((a, b) => b.at - a.at)
    .map(({ entry, file }) => ({
      ...toMetaPreview(entry),
      behaviorHints: { defaultVideoId: videoIdFor(entry, file) },
    }));
}

export async function getCatalog(
  library: Library,
  type: string,
  extra: Record<string, string | string[] | undefined>,
  id?: string,
) {
  const parsedSkip = Number.parseInt(String(extra.skip ?? "0"), 10);
  const skip =
    Number.isSafeInteger(parsedSkip) && parsedSkip > 0 ? parsedSkip : 0;
  if (id === CONTINUE_WATCHING_ID) {
    const metas = await continueWatching(library, type);
    return { metas: metas.slice(skip, skip + PAGE_SIZE) };
  }
  // Board rows (Phase 15). Recently added orders by when the title entered
  // the library rather than by edits; Unwatched is every title nobody has
  // started, so it stays disjoint from Continue Watching; a pinned tag row is
  // the picker narrowed to that tag. None of them take search or genre.
  if (id === RECENTLY_ADDED_ID || id === UNWATCHED_ID) {
    const metas = (await library.list())
      .filter((entry) => entry.type === type)
      .filter((entry) => id !== UNWATCHED_ID || !entry.watchStates?.length)
      .sort((a, b) =>
        id === RECENTLY_ADDED_ID
          ? b.createdAt.localeCompare(a.createdAt)
          : b.updatedAt.localeCompare(a.updatedAt),
      )
      .slice(skip, skip + PAGE_SIZE)
      .map(toMetaPreview);
    return { metas };
  }
  const search = String(extra.search ?? "").toLocaleLowerCase();
  const pinnedTag = id?.startsWith(TAG_CATALOG_PREFIX)
    ? id.slice(TAG_CATALOG_PREFIX.length)
    : "";
  const genre = pinnedTag || (extra.genre ? tagKey(String(extra.genre)) : "");
  const entries = (await library.list())
    .filter((entry) => entry.type === type)
    .filter(
      (entry) => !search || entry.name.toLocaleLowerCase().includes(search),
    )
    .filter(
      (entry) => !genre || entry.tags?.some((tag) => tagKey(tag) === genre),
    )
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    .slice(skip, skip + PAGE_SIZE)
    .map(toMetaPreview);
  return { metas: entries };
}
