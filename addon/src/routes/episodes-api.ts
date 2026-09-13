import { z } from "zod";
import { cleanEpisodeTitle, episodeOverrideFor } from "../episode-titles.ts";
import { resolveStreamSource } from "../inspection.ts";
import { thumbnailUrl } from "../metadata.ts";
import { resolvePublicUrls } from "../streams.ts";
import { body, logInfo, reply, type RouteHandler } from "./context.ts";

const generateBodySchema = z
  .object({ force: z.boolean().optional() })
  .strict()
  .default({});

// Episode presentation for the entry sheet (Phase 13): every selected
// episode with its default title, the viewer's overrides, whether its media
// is on disk (thumbnail-eligible) and whether a frame exists. Nothing here
// touches the swarm: torrent series are read from the inspection cache.
export const handleEpisodes: RouteHandler = async (
  { library, torrServer, thumbnails, accessToken, publicUrls },
  { request, response, url, method },
) => {
  const match = /^\/api\/library\/([^/]+)\/episodes$/.exec(url.pathname);
  if (!match || method !== "GET") return false;
  const entry = await library.get(decodeURIComponent(match[1]));
  if (!entry) return reply(response, 404, { error: "Not found" });
  if (entry.type !== "series")
    return reply(response, 400, { error: "Only series have episodes" });
  const torrentBacked = !entry.localFilePath && !entry.localFolderPath;
  if (torrentBacked && !entry.inspectionCache)
    return reply(response, 200, {
      episodes: [],
      eligible: 0,
      inspected: false,
      thumbnails: thumbnails?.statusFor(entry.id) ?? null,
    });
  const { selectedFiles } = await resolveStreamSource(
    entry,
    torrServer,
    library,
  );
  const onDisk = new Set(
    (await thumbnails?.episodesOnDisk(entry).catch(() => []))?.map(
      (episode) => `${episode.season}:${episode.episode}`,
    ) ?? [],
  );
  const frames = new Set(
    ((await thumbnails?.available(entry.id)) ?? []).map(
      (slot) => `${slot.season}:${slot.episode}`,
    ),
  );
  const addonUrl = resolvePublicUrls(request.headers.host, publicUrls).addonUrl;
  const episodes = selectedFiles
    .filter((file) => file.season !== undefined && file.episode !== undefined)
    .map((file) => {
      const season = file.season as number;
      const episode = file.episode as number;
      const key = `${season}:${episode}`;
      const override = episodeOverrideFor(entry.episodes, file);
      return {
        season,
        episode,
        fileId: file.id,
        path: file.path,
        defaultTitle: cleanEpisodeTitle(file.path, season, episode),
        ...(override?.title ? { title: override.title } : {}),
        ...(override?.overview ? { overview: override.overview } : {}),
        ...(override?.released ? { released: override.released } : {}),
        onDisk: onDisk.has(key),
        thumbnail: frames.has(key)
          ? thumbnailUrl(addonUrl, accessToken, entry.id, season, episode)
          : null,
      };
    })
    .sort((a, b) => a.season - b.season || a.episode - b.episode);
  return reply(response, 200, {
    episodes,
    eligible: onDisk.size,
    inspected: true,
    thumbnails: thumbnails?.statusFor(entry.id) ?? null,
  });
};

// Viewer-triggered frame grabs. 202 when queued, 409 while a run for the
// entry is already in progress, 409 when the service is not configured.
export const handleThumbnailGeneration: RouteHandler = async (
  { library, thumbnails },
  { request, response, url, method },
) => {
  const match = /^\/api\/library\/([^/]+)\/thumbnails$/.exec(url.pathname);
  if (!match) return false;
  const id = decodeURIComponent(match[1]);
  const entry = await library.get(id);
  if (!entry) return reply(response, 404, { error: "Not found" });
  if (!thumbnails)
    return reply(response, 409, { error: "Thumbnails unavailable" });
  if (method === "GET")
    return reply(response, 200, {
      ...thumbnails.statusFor(id),
      available: await thumbnails.available(id),
    });
  if (method !== "POST") return false;
  if (entry.type !== "series")
    return reply(response, 400, { error: "Only series have episodes" });
  const parsed = generateBodySchema.parse(
    request.headers["content-length"] &&
      request.headers["content-length"] !== "0"
      ? await body(request)
      : undefined,
  );
  const force = parsed.force;
  if (!thumbnails.generate(id, { force }))
    return reply(response, 409, {
      error: "Thumbnails are already being generated",
      code: "thumbnails_running",
    });
  logInfo("thumbnails_requested", { entryId: id, force: Boolean(force) });
  return reply(response, 202, { queued: true });
};
