import type { Library } from "./library.js";
import type { LibraryEntry } from "./types.js";

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
  };
}

export async function getCatalog(
  library: Library,
  type: string,
  extra: Record<string, string | string[] | undefined>,
) {
  const search = String(extra.search ?? "").toLocaleLowerCase();
  const parsedSkip = Number.parseInt(String(extra.skip ?? "0"), 10);
  const skip =
    Number.isSafeInteger(parsedSkip) && parsedSkip > 0 ? parsedSkip : 0;
  const entries = (await library.list())
    .filter((entry) => entry.type === type)
    .filter(
      (entry) => !search || entry.name.toLocaleLowerCase().includes(search),
    )
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    .slice(skip, skip + PAGE_SIZE)
    .map(toMetaPreview);
  return { metas: entries };
}
