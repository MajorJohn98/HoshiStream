import { toMetaPreview } from "./catalog.ts";
import { resolveStreamSource, warmStreamSource } from "./inspection.ts";
import type { Library } from "./library.ts";
import type { TorrServerClient } from "./torrserver-client.ts";

export async function getMetadata(
  library: Library,
  torrServer: TorrServerClient,
  type: string,
  id: string,
) {
  const entry = await library.get(id);
  if (!entry || entry.type !== type) return { meta: null };
  const meta = toMetaPreview(entry);
  if (entry.type === "movie") {
    warmStreamSource(entry, torrServer, library);
    return { meta };
  }

  const inspection = await resolveStreamSource(entry, torrServer, library);
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
