import type { Library } from "./library.ts";
import { tagKey } from "./tags.ts";
import type { LibraryEntry } from "./types.ts";

const PAGE_SIZE = 100;

export function toMetaPreview(entry: LibraryEntry) {
  return {
    id: entry.id,
    type: entry.type,
    name: entry.name,
    description: entry.description,
    poster: entry.poster,
    posterShape: "poster",
    background: entry.background,
    ...(entry.tags?.length ? { genres: [...entry.tags] } : {}),
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
