import { entrySourceDefinitionRevision } from "./imports/source-identity.ts";
import type { Library } from "./library.ts";
import { tagKey } from "./tags.ts";
import type { LibraryEntry } from "./types.ts";

const PAGE_SIZE = 100;

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

export async function getCatalog(
  library: Library,
  type: string,
  extra: Record<string, string | string[] | undefined>,
) {
  const search = String(extra.search ?? "").toLocaleLowerCase();
  const genre = extra.genre ? tagKey(String(extra.genre)) : "";
  const parsedSkip = Number.parseInt(String(extra.skip ?? "0"), 10);
  const skip =
    Number.isSafeInteger(parsedSkip) && parsedSkip > 0 ? parsedSkip : 0;
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
