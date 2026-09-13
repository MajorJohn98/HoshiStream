import { toMetaPreview, type ArtworkUrl } from "./catalog.ts";
import { episodeOverrideFor, episodeTitle } from "./episode-titles.ts";
import { resolveStreamSource, warmStreamSource } from "./inspection.ts";
import type { Library } from "./library.ts";
import type { SelectedFile } from "./media-file-selection.ts";
import {
  torrentStreamsForFile,
  type Stream,
  type StreamTargetOptions,
} from "./streams.ts";
import type { ThumbnailService } from "./thumbnail-service.ts";
import type { TorrServerClient } from "./torrserver-client.ts";
import type { ArtworkKind } from "./types.ts";

export function artworkUrl(
  addonUrl: string,
  accessToken: string,
  entryId: string,
  kind: ArtworkKind,
): string {
  return `${addonUrl}/artwork/${encodeURIComponent(accessToken)}/${encodeURIComponent(entryId)}/${kind}`;
}

/** Local artwork resolver for the origin a client reached us on. */
export function artworkResolver(
  addonUrl: string,
  accessToken: string,
): ArtworkUrl {
  return (entryId, kind) => artworkUrl(addonUrl, accessToken, entryId, kind);
}

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
  // Cached Cinemeta artwork needs the origin the client reached us on, which
  // only the embed options carry (ADR 0026).
  const meta = toMetaPreview(
    entry,
    embed
      ? { artworkUrl: artworkResolver(embed.publicAddonUrl, embed.accessToken) }
      : undefined,
  );
  if (entry.type === "movie") {
    warmStreamSource(entry, torrServer, library);
    return { meta };
  }

  // Embedding streams (Phase 15) only when the inspection was cached before
  // this request: an uncached series would otherwise pay for a full
  // inspection inside the meta call. Local entries keep the stream resource
  // (their per-file subtitle hash means a disk read each).
  const local = Boolean(entry.localFilePath || entry.localFolderPath);
  const cachedHash = embed && !local ? entry.inspectionCache?.hash : undefined;
  // A cached torrent series answers from the cache alone: re-registering
  // with TorrServer (in case it dropped the torrents) happens in the
  // background, as for movies, so the episode list never waits on the swarm.
  // Without a cache the inspection is shared with any warm-up already
  // running, so a source edit followed by a Stremio visit inspects once.
  let inspection: { selectedFiles: SelectedFile[] };
  if (!local && entry.inspectionCache) {
    inspection = entry.inspectionCache;
    warmStreamSource(entry, torrServer, library);
  } else {
    inspection = await resolveStreamSource(entry, torrServer, library);
  }
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
  // No defaultVideoId here: Stremio reads it on a meta as "this title has one
  // video" and replaces the episode list with that video's stream picker.
  // Resume deep links live on the Continue Watching catalog rows instead.
  const behaviorHints = {
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
