import { toMetaPreview } from "./catalog.js";
import { inspectEntry } from "./inspection.js";
import type { Library } from "./library.js";
import type { TorrServerClient } from "./torrserver-client.js";

export async function getMetadata(
  library: Library,
  torrServer: TorrServerClient,
  type: string,
  id: string,
) {
  const entry = await library.get(id);
  if (!entry || entry.type !== type) return { meta: null };
  const meta = toMetaPreview(entry);
  if (entry.type === "movie") return { meta };

  const inspection = await inspectEntry(entry, torrServer);
  return {
    meta: {
      ...meta,
      videos: inspection.selectedFiles.map((file) => ({
        id: `${entry.id}:${file.season}:${file.episode}`,
        title: file.path,
        season: file.season,
        episode: file.episode,
        released: entry.createdAt,
      })),
    },
  };
}
