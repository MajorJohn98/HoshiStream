import { toMetaPreview, videoIdFor } from "./catalog.ts";
import { episodeOverrideFor, episodeTitle } from "./episode-titles.ts";
import { resolveStreamSource, warmStreamSource } from "./inspection.ts";
import type { Library } from "./library.ts";
import {
  torrentStreamsForFile,
  type Stream,
  type StreamTargetOptions,
} from "./streams.ts";
import type { ThumbnailService } from "./thumbnail-service.ts";
import type { TorrServerClient } from "./torrserver-client.ts";
import { resumeFile } from "./watch-state.ts";

export function thumbnailUrl(
  addonUrl: string,
  accessToken: string,
  entryId: string,
  season: number,
  episode: number,
): string {
  return `${addonUrl}/thumbnails/${encodeURIComponent(accessToken)}/${encodeURIComponent(entryId)}/${season}/${episode}.jpg`;
}

export async function getMetadata(
  library: Library,
  torrServer: TorrServerClient,
  type: string,
  id: string,
  embed?: StreamTargetOptions,
  thumbnails?: ThumbnailService,
) {
  const entry = await library.get(id);
  if (!entry || entry.type !== type) return { meta: null };
  const meta = toMetaPreview(entry);
  if (entry.type === "movie") {
    warmStreamSource(entry, torrServer, library);
    return { meta };
  }

  // Embedding streams (Phase 15) only when the inspection was cached before
  // this request: an uncached series would otherwise pay for a full
  // inspection inside the meta call. Local entries keep the stream resource
  // (their per-file subtitle hash means a disk read each).
  const cachedHash =
    embed && !entry.localFilePath && !entry.localFolderPath
      ? entry.inspectionCache?.hash
      : undefined;
  const inspection = await resolveStreamSource(entry, torrServer, library);
  // A series with history opens on the episode to pick up at.
  const resume = resumeFile(entry, inspection.selectedFiles);
  const embedded = new Map<number, Stream[]>();
  if (embed && cachedHash) {
    await Promise.all(
      inspection.selectedFiles.map(async (file) => {
        embedded.set(
          file.id,
          await torrentStreamsForFile(
            { ...embed, volumes: undefined },
            entry,
            cachedHash,
            file,
          ),
        );
      }),
    );
  }
  // Thumbnail URLs need the origin the client reached us on, which only the
  // embed options carry; a frame is advertised only when it exists on disk.
  const frames = new Set<string>();
  if (thumbnails && embed) {
    for (const slot of await thumbnails.available(entry.id))
      frames.add(`${slot.season}:${slot.episode}`);
  }
  const behaviorHints = {
    ...(resume ? { defaultVideoId: videoIdFor(entry, resume) } : {}),
    ...(entry.ongoing ? { hasScheduledVideos: true } : {}),
  };
  return {
    meta: {
      ...meta,
      ...(Object.keys(behaviorHints).length ? { behaviorHints } : {}),
      videos: inspection.selectedFiles.map((file) => {
        const streams = embedded.get(file.id);
        const override = episodeOverrideFor(entry.episodes, file);
        const thumbnail =
          embed &&
          file.season !== undefined &&
          file.episode !== undefined &&
          frames.has(`${file.season}:${file.episode}`)
            ? thumbnailUrl(
                embed.publicAddonUrl,
                embed.accessToken,
                entry.id,
                file.season,
                file.episode,
              )
            : undefined;
        return {
          id: `${entry.id}:${file.season}:${file.episode}`,
          title: episodeTitle(entry, file),
          season: file.season,
          episode: file.episode,
          released: override?.released ?? entry.createdAt,
          ...(override?.overview ? { overview: override.overview } : {}),
          ...(thumbnail ? { thumbnail } : {}),
          ...(streams?.length ? { streams } : {}),
        };
      }),
    },
  };
}
