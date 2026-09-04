import { markStreamActivity } from "../activity.js";
import { resolveStreamSource } from "../inspection.js";
import { inspectLocalEntry, serveLocalMedia } from "../local-media.js";
import { serveMediaSource } from "../media-source.js";
import { validToken } from "../security.js";
import { repairTier, TranscodeBusyError } from "../transcode.js";
import {
  isReadMethod,
  observeClient,
  reply,
  type RouteHandler,
} from "./context.js";

// Repaired-stream HLS sessions (ADR 0010). The session starts lazily on the
// first playlist request and is reaped when segment requests stop.
export const handleHls: RouteHandler = async (
  { library, torrServer, accessToken, transcode },
  { request, response, url, method },
) => {
  const hlsMatch =
    /^\/hls\/([^/]+)\/([^/]+)\/(\d+)\/(auto|video)\/(index\.m3u8|init\.mp4|seg-\d+\.m4s)$/.exec(
      url.pathname,
    );
  if (
    !hlsMatch ||
    !isReadMethod(method) ||
    !transcode ||
    !validToken(decodeURIComponent(hlsMatch[1]), accessToken)
  )
    return false;
  const entry = await library.get(decodeURIComponent(hlsMatch[2]));
  const fileId = Number(hlsMatch[3]);
  const variant = hlsMatch[4] as "auto" | "video";
  const asset = hlsMatch[5];
  if (!entry) return reply(response, 404, { error: "Unknown entry" });
  let session = transcode.get(entry.id, fileId, variant);
  if (!session || session.failed) {
    // The video variant is the remote lower-bitrate rendition; "auto"
    // follows the probe verdict, defaulting to a copy-only remux.
    const tier =
      variant === "video" ? "video" : (repairTier(entry.directPlay) ?? "remux");
    let input: string | undefined;
    if (entry.localFilePath || entry.localFolderPath) {
      const inspection = await inspectLocalEntry(entry);
      input = inspection?.files.find((file) => file.id === fileId)?.localPath;
    } else {
      const source = await resolveStreamSource(entry, torrServer, library);
      const file = source.selectedFiles.find(
        (candidate) => candidate.id === fileId,
      );
      if (file) input = torrServer.streamUrl(source.hash, file);
    }
    if (!input) return reply(response, 404, { error: "Unknown file" });
    try {
      session = await transcode.ensure({
        entryId: entry.id,
        fileId,
        variant,
        tier,
        input,
      });
    } catch (error) {
      if (error instanceof TranscodeBusyError)
        return reply(response, 503, { error: error.message });
      if (error instanceof Error && error.message.includes("video encoder"))
        return reply(response, 503, { error: error.message });
      throw error;
    }
  }
  transcode.touch(session);
  markStreamActivity();
  observeClient(request, "playback");
  if (asset === "index.m3u8") {
    try {
      await transcode.waitForPlaylist(session);
    } catch (error) {
      return reply(response, 502, {
        error: error instanceof Error ? error.message : "Repair failed",
      });
    }
  }
  const content = await transcode.readAsset(session, asset);
  if (!content) return reply(response, 404, { error: "Not found" });
  response.writeHead(200, {
    "content-type":
      asset === "index.m3u8"
        ? "application/vnd.apple.mpegurl"
        : asset === "init.mp4"
          ? "video/mp4"
          : "video/iso.segment",
    "content-length": content.length,
    "cache-control": asset === "index.m3u8" ? "no-store" : "max-age=60",
    "access-control-allow-origin": "*",
  });
  response.end(method === "HEAD" ? undefined : content);
  return true;
};

// Direct playback of local-file and local-folder entries.
export const handleLocalMedia: RouteHandler = async (
  { library, accessToken },
  { request, response, url, method },
) => {
  const localMatch = /^\/local\/([^/]+)\/([^/]+)(?:\/(\d+))?$/.exec(
    url.pathname,
  );
  if (
    !localMatch ||
    !isReadMethod(method) ||
    !validToken(decodeURIComponent(localMatch[1]), accessToken)
  )
    return false;
  const entry = await library.get(decodeURIComponent(localMatch[2]));
  if (!entry) return false;
  markStreamActivity();
  void library.markStreamed(entry.id).catch(() => undefined);
  observeClient(request, "playback");
  await serveLocalMedia(
    request,
    response,
    entry,
    localMatch[3] === undefined ? undefined : Number(localMatch[3]),
  );
  return true;
};

// Stable playback URL for disk-copy entries: every range request
// independently resolves disk vs torrent, so plugging or unplugging a drive
// changes the source on the client's next request.
export const handleDiskMedia: RouteHandler = async (
  { library, torrServer, accessToken, volumes },
  { request, response, url, method },
) => {
  const mediaMatch = /^\/media\/([^/]+)\/([^/]+)\/([0-9a-fA-F]+:\d+)$/.exec(
    url.pathname,
  );
  if (
    !mediaMatch ||
    !isReadMethod(method) ||
    !volumes ||
    !validToken(decodeURIComponent(mediaMatch[1]), accessToken)
  )
    return false;
  const entry = await library.get(decodeURIComponent(mediaMatch[2]));
  if (!entry) return false;
  markStreamActivity();
  void library.markStreamed(entry.id).catch(() => undefined);
  observeClient(request, "playback");
  await serveMediaSource(
    request,
    response,
    entry,
    mediaMatch[3],
    volumes,
    torrServer,
    library,
  );
  return true;
};
