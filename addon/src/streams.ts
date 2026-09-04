import type { Library } from "./library.ts";
import type { SelectedFile } from "./media-file-selection.ts";
import { markStreamActivity } from "./activity.ts";
import { directPlayLabel } from "./direct-play.ts";
import { sourceKey } from "./disk-copy.ts";
import { resolveStreamSource } from "./inspection.ts";
import { repairTier, repairDescription } from "./transcode.ts";
import type { TorrServerClient } from "./torrserver-client.ts";

const episodeId = /^(hoshi:[^:]+):(\d+):(\d+)$/;

export function streamBehaviorHints(entryId: string, file: SelectedFile) {
  return {
    filename: file.path,
    videoSize: file.length,
    bingeGroup: `hoshistream-${entryId}`,
  };
}

export interface PublicUrls {
  addonUrl: string;
  torrServerUrl: string;
}

export function resolvePublicUrls(
  hostHeader: string | undefined,
  fallback: PublicUrls,
): PublicUrls {
  if (!hostHeader) return fallback;
  let requested: URL;
  try {
    requested = new URL(`http://${hostHeader}`);
  } catch {
    return fallback;
  }
  if (!requested.hostname) return fallback;
  const torrServer = new URL(fallback.torrServerUrl);
  torrServer.hostname = requested.hostname;
  return { addonUrl: requested.origin, torrServerUrl: torrServer.origin };
}

export function resolveClientAwareUrls(
  headers: { host?: string; "cf-connecting-ip"?: string | string[] },
  fallback: PublicUrls,
  ownIp: string | null,
): PublicUrls {
  const clientIp = headers["cf-connecting-ip"];
  if (typeof clientIp === "string" && ownIp && clientIp === ownIp) {
    return fallback;
  }
  return resolvePublicUrls(headers.host, fallback);
}

export function rewritePublicUrl(
  internalUrl: string,
  publicBaseUrl: string,
): string {
  const internal = new URL(internalUrl);
  const publicBase = new URL(publicBaseUrl);
  internal.protocol = publicBase.protocol;
  internal.host = publicBase.host;
  return internal.toString();
}

function requestedFile(
  files: SelectedFile[],
  type: string,
  id: string,
): { entryId: string; file?: SelectedFile } {
  if (type !== "series") return { entryId: id, file: files[0] };
  const match = episodeId.exec(id);
  if (!match) return { entryId: id };
  const [, entryId, season, episode] = match;
  return {
    entryId,
    file: files.find(
      (file) =>
        file.season === Number(season) && file.episode === Number(episode),
    ),
  };
}

export interface RepairOptions {
  videoEncoder?: string;
  videoBitrateMbps: number;
  // True when the requesting client is not on the LAN (e.g. behind the
  // Cloudflare Tunnel), which makes a lower-bitrate rendition worth offering.
  remoteClient: boolean;
}

export async function getStreams(
  library: Library,
  torrServer: TorrServerClient,
  publicTorrServerUrl: string,
  publicAddonUrl: string,
  accessToken: string,
  type: string,
  id: string,
  repair?: RepairOptions,
) {
  const requested = requestedFile([], type, id);
  const entry = await library.get(requested.entryId);
  if (!entry || entry.type !== type) return { streams: [] };

  if (entry.localFilePath || entry.localFolderPath) {
    const source = await resolveStreamSource(entry, torrServer, library);
    const file = requestedFile(source.selectedFiles, type, id).file;
    if (!file) return { streams: [] };
    markStreamActivity();
    void library.markStreamed(entry.id).catch(() => undefined);
    return {
      streams: [
        {
          name: "HoshiStream",
          description: describe("Local", file, entry),
          url: `${publicAddonUrl}/local/${encodeURIComponent(accessToken)}/${encodeURIComponent(entry.id)}/${file.id}`,
          behaviorHints: streamBehaviorHints(entry.id, file),
        },
        ...compatibleStreams(repair, publicAddonUrl, accessToken, entry, file),
      ],
    };
  }

  const source = await resolveStreamSource(entry, torrServer, library);
  const file = requestedFile(source.selectedFiles, type, id).file;
  if (!file) return { streams: [] };
  markStreamActivity();
  void library.markStreamed(entry.id).catch(() => undefined);

  // Disk-copy entries get the stable /media URL: the router picks disk or
  // torrent per range request, so the client never reselects a stream when
  // the drive comes and goes. Others keep the direct TorrServer URL (no
  // proxy hop).
  const diskCopy =
    entry.diskCopy?.desired === "keep" ? entry.diskCopy : undefined;
  const key = diskCopy && sourceKey(source.hash, file);
  const manifestFile =
    diskCopy && diskCopy.files.find((candidate) => candidate.sourceKey === key);
  const url =
    diskCopy && manifestFile?.included
      ? `${publicAddonUrl}/media/${encodeURIComponent(accessToken)}/${encodeURIComponent(entry.id)}/${key}`
      : rewritePublicUrl(
          torrServer.streamUrl(source.hash, file),
          publicTorrServerUrl,
        );
  const label =
    diskCopy && manifestFile?.included
      ? manifestFile.state === "complete"
        ? "Disk"
        : "Disk (syncing)"
      : "Torrent";
  console.log(
    JSON.stringify({
      level: "info",
      event: "stream_generated",
      entryId: entry.id,
      fileId: file.id,
      filename: file.path,
    }),
  );
  return {
    streams: [
      {
        name: "HoshiStream",
        description: describe(label, file, entry),
        url,
        behaviorHints: streamBehaviorHints(entry.id, file),
      },
      ...compatibleStreams(repair, publicAddonUrl, accessToken, entry, file),
    ],
  };
}

// Repaired renditions appear as extra streams in the Stremio picker, so
// choosing between "Direct" and "Compatible" needs no custom client UI. The
// session itself starts lazily on the first playlist request.
export function compatibleStreams(
  repair: RepairOptions | undefined,
  publicAddonUrl: string,
  accessToken: string,
  entry: {
    id: string;
    directPlay?: Parameters<typeof repairTier>[0] & { bitrateMbps?: number };
    forceTranscode?: boolean;
  },
  file: SelectedFile,
) {
  if (!repair) return [];
  const hlsUrl = (variant: string) =>
    `${publicAddonUrl}/hls/${encodeURIComponent(accessToken)}/${encodeURIComponent(entry.id)}/${file.id}/${variant}/index.m3u8`;
  const streams = [];
  let tier = repairTier(entry.directPlay);
  // Tier V needs a hardware encoder (ADR 0010: no software fallback); without
  // one an undecodable entry gets no repaired stream rather than a CPU burn.
  if (tier === "video" && !repair.videoEncoder) tier = undefined;
  if (!tier && entry.forceTranscode) tier = "remux";
  if (tier) {
    streams.push({
      name: "HoshiStream",
      description: repairDescription(tier),
      url: hlsUrl("auto"),
      behaviorHints: streamBehaviorHints(entry.id, file),
    });
  }
  // Remote clients on constrained links get a capped rendition when the
  // original bitrate clearly exceeds the configured target.
  const bitrate = entry.directPlay?.bitrateMbps;
  if (
    repair.remoteClient &&
    repair.videoEncoder &&
    bitrate &&
    bitrate > repair.videoBitrateMbps
  ) {
    streams.push({
      name: "HoshiStream",
      description: `Lower bitrate • ${repair.videoBitrateMbps} Mbps for remote playback`,
      url: hlsUrl("video"),
      behaviorHints: streamBehaviorHints(entry.id, file),
    });
  }
  return streams;
}

function describe(
  source: string,
  file: SelectedFile,
  entry: { directPlay?: Parameters<typeof directPlayLabel>[0] },
): string {
  const label = entry.directPlay && directPlayLabel(entry.directPlay);
  return [`${source} • ${formatSize(file.length)}`, label]
    .filter(Boolean)
    .join(" • ");
}

function formatSize(bytes: number): string {
  return bytes >= 1_000_000_000
    ? `${(bytes / 1_000_000_000).toFixed(1)} GB`
    : `${Math.round(bytes / 1_000_000)} MB`;
}
