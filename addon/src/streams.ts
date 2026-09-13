import type { Library } from "./library.ts";
import type { LibraryEntry } from "./types.ts";
import type { SelectedFile } from "./media-file-selection.ts";
import { markStreamActivity } from "./activity.ts";
import { directPlayLabel, type DirectPlay } from "./direct-play.ts";
import { destinationPath, sourceKey } from "./disk-copy.ts";
import { resolveStreamSource } from "./inspection.ts";
import { fitsLine, lineFitNote } from "./line-fit.ts";
import { inspectLocalEntry } from "./local-media.ts";
import { directPlayForFile } from "./media-facts.ts";
import { noteStreamTarget } from "./playback-telemetry.ts";
import { homeSpeedMbps } from "./speedtest.ts";
import { repairTier, repairDescription } from "./transcode.ts";
import type { TorrServerClient } from "./torrserver-client.ts";
import { openSubtitlesHash } from "./video-hash.ts";
import type { VolumeRegistry } from "./volumes.ts";

const episodeId = /^(hoshi:[^:]+):(\d+):(\d+)$/;

export interface Stream {
  name: string;
  description: string;
  url: string;
  behaviorHints: ReturnType<typeof streamBehaviorHints>;
}

// A stream plus the average bitrate it will need, known only while the list
// is assembled; presentStreams strips it before the reply.
export type AssembledStream = Stream & { bitrateMbps?: number };

// Files the line can carry come first (original order kept within each
// group); heavier ones stay listed with an explicit reason. Nothing is
// hidden — the viewer may know their swarm better than a speed test does.
// Every stream with a known bitrate and line gets a one-line verdict.
export function presentStreams(
  streams: AssembledStream[],
  lineMbps: number | undefined,
): Stream[] {
  const fitting: Stream[] = [];
  const heavy: Stream[] = [];
  for (const { bitrateMbps, ...stream } of streams) {
    const fits = fitsLine(bitrateMbps, lineMbps);
    if (fits === undefined || !bitrateMbps || !lineMbps) {
      fitting.push(stream);
      continue;
    }
    const verdict = fits
      ? "fits your line"
      : `above your line · ${lineFitNote(bitrateMbps, lineMbps)}`;
    const described = {
      ...stream,
      description: `${stream.description}\n${verdict}`,
    };
    (fits ? fitting : heavy).push(described);
  }
  return [...fitting, ...heavy];
}

export function streamBehaviorHints(
  entryId: string,
  file: SelectedFile,
  options: { directPlay?: DirectPlay; videoHash?: string } = {},
) {
  return {
    filename: file.path,
    videoSize: file.length,
    bingeGroup: `hoshistream-${entryId}`,
    ...(options.directPlay && notWebReady(options.directPlay)
      ? { notWebReady: true }
      : {}),
    ...(options.videoHash ? { videoHash: options.videoHash } : {}),
  };
}

// Formats browsers cannot decode natively (ADR 0010 keeps the original as
// the first choice; this hint lets Stremio Web offer an external player
// instead of a black screen). Repaired renditions are never flagged.
const WEB_UNREADY_VIDEO = new Set([
  "hevc",
  "h265",
  "mpeg4",
  "msmpeg4v2",
  "msmpeg4v3",
  "vc1",
  "mpeg2video",
]);
const WEB_UNREADY_AUDIO = new Set([
  "dts",
  "dtshd",
  "truehd",
  "mlp",
  "pcm_bluray",
]);
const WEB_UNREADY_CONTAINER = new Set(["avi"]);

export function notWebReady(directPlay: DirectPlay): boolean {
  const video = directPlay.videoCodec?.toLowerCase();
  const audio = directPlay.audioCodec?.toLowerCase();
  const container = directPlay.container?.toLowerCase().split(",")[0];
  return Boolean(
    (video && WEB_UNREADY_VIDEO.has(video)) ||
    (audio && WEB_UNREADY_AUDIO.has(audio)) ||
    (container && WEB_UNREADY_CONTAINER.has(container)),
  );
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

export function requestedFile(
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
  lineMbps: number | undefined = homeSpeedMbps(),
  volumes?: VolumeRegistry,
) {
  const requested = requestedFile([], type, id);
  const entry = await library.get(requested.entryId);
  if (!entry || entry.type !== type) return { streams: [] };

  if (entry.localFilePath || entry.localFolderPath) {
    const source = await resolveStreamSource(entry, torrServer, library);
    const file = requestedFile(source.selectedFiles, type, id).file;
    if (!file) return { streams: [] };
    const assessed = {
      ...entry,
      directPlay: directPlayForFile(entry, file, source.hash),
    };
    markStreamActivity(Date.now(), entry.id);
    void library.markStreamed(entry.id).catch(() => undefined);
    const localPath = (await inspectLocalEntry(entry))?.files.find(
      (candidate) => candidate.id === file.id,
    )?.localPath;
    const videoHash = localPath
      ? await openSubtitlesHash(localPath)
      : undefined;
    return {
      streams: presentStreams(
        [
          {
            name: "HoshiStream",
            description: describe("Local", file, assessed),
            url: `${publicAddonUrl}/local/${encodeURIComponent(accessToken)}/${encodeURIComponent(entry.id)}/${file.id}`,
            behaviorHints: streamBehaviorHints(entry.id, file, {
              directPlay: assessed.directPlay,
              videoHash,
            }),
            bitrateMbps: assessed.directPlay?.bitrateMbps,
          },
          ...compatibleStreams(
            repair,
            publicAddonUrl,
            accessToken,
            assessed,
            file,
          ),
        ],
        lineMbps,
      ),
    };
  }

  const source = await resolveStreamSource(entry, torrServer, library);
  const file = requestedFile(source.selectedFiles, type, id).file;
  if (!file) return { streams: [] };
  markStreamActivity(Date.now(), entry.id);
  void library.markStreamed(entry.id).catch(() => undefined);
  noteStreamTarget({
    entryId: entry.id,
    hash: file.hash ?? source.hash,
    fileId: file.id,
    title: entry.name,
    bitrateMbps: directPlayForFile(entry, file, source.hash)?.bitrateMbps,
  });

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
    streams: await torrentStreamsForFile(
      {
        torrServer,
        publicTorrServerUrl,
        publicAddonUrl,
        accessToken,
        repair,
        lineMbps,
        volumes,
      },
      entry,
      source.hash,
      file,
    ),
  };
}

export interface StreamTargetOptions {
  torrServer: TorrServerClient;
  publicTorrServerUrl: string;
  publicAddonUrl: string;
  accessToken: string;
  repair?: RepairOptions;
  lineMbps?: number;
  /** Omit to skip the subtitle-matching hash (a disk read per file). */
  volumes?: VolumeRegistry;
}

// The stream list for one torrent-backed file, free of side effects so meta
// responses can embed it per episode (Phase 15) as well as the stream
// resource returning it.
export async function torrentStreamsForFile(
  options: StreamTargetOptions,
  entry: LibraryEntry,
  sourceHash: string,
  file: SelectedFile,
): Promise<Stream[]> {
  const {
    torrServer,
    publicTorrServerUrl,
    publicAddonUrl,
    accessToken,
    repair,
    lineMbps,
    volumes,
  } = options;
  const assessed = {
    ...entry,
    directPlay: directPlayForFile(entry, file, sourceHash),
  };
  // Disk-copy entries get the stable /media URL: the router picks disk or
  // torrent per range request, so the client never reselects a stream when
  // the drive comes and goes. Others keep the direct TorrServer URL (no
  // proxy hop).
  const diskCopy =
    entry.diskCopy?.desired === "keep" ? entry.diskCopy : undefined;
  const key = diskCopy && sourceKey(sourceHash, file);
  const manifestFile =
    diskCopy && diskCopy.files.find((candidate) => candidate.sourceKey === key);
  const url =
    diskCopy && manifestFile?.included
      ? `${publicAddonUrl}/media/${encodeURIComponent(accessToken)}/${encodeURIComponent(entry.id)}/${key}`
      : rewritePublicUrl(
          torrServer.streamUrl(sourceHash, file),
          publicTorrServerUrl,
        );
  const label =
    diskCopy && manifestFile?.included
      ? manifestFile.state === "complete"
        ? "Disk"
        : "Disk (syncing)"
      : "Torrent";
  // Subtitle matching hash only for a finished disk copy; the torrent path
  // would mean reading 128 KiB through the swarm on every stream request.
  const videoHash =
    diskCopy && manifestFile?.included && manifestFile.state === "complete"
      ? await diskCopyVideoHash(volumes, diskCopy, manifestFile.relativePath)
      : undefined;
  return presentStreams(
    [
      {
        name: "HoshiStream",
        description: describe(label, file, assessed),
        url,
        behaviorHints: streamBehaviorHints(entry.id, file, {
          directPlay: assessed.directPlay,
          videoHash,
        }),
        bitrateMbps: assessed.directPlay?.bitrateMbps,
      },
      ...compatibleStreams(repair, publicAddonUrl, accessToken, assessed, file),
    ],
    lineMbps,
  );
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
): AssembledStream[] {
  if (!repair) return [];
  const hlsUrl = (variant: string) =>
    `${publicAddonUrl}/hls/${encodeURIComponent(accessToken)}/${encodeURIComponent(entry.id)}/${file.id}/${variant}/index.m3u8`;
  const streams: AssembledStream[] = [];
  const bitrate = entry.directPlay?.bitrateMbps;
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
      // Remux and audio repair keep the source video, so its bitrate
      // stands; a re-encode runs at the configured target.
      bitrateMbps: tier === "video" ? repair.videoBitrateMbps : bitrate,
    });
  }
  // Remote clients on constrained links get a capped rendition when the
  // original bitrate clearly exceeds the configured target.
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
      bitrateMbps: repair.videoBitrateMbps,
    });
  }
  return streams;
}

async function diskCopyVideoHash(
  volumes: VolumeRegistry | undefined,
  diskCopy: { volumeId: string; relativeDir: string },
  relativePath: string,
): Promise<string | undefined> {
  if (!volumes) return undefined;
  try {
    const resolution = await volumes.resolve(diskCopy.volumeId);
    if (resolution.state !== "online") return undefined;
    return await openSubtitlesHash(
      destinationPath(resolution.root, diskCopy.relativeDir, relativePath),
    );
  } catch {
    return undefined;
  }
}

const VIDEO_LABELS: Record<string, string> = {
  h264: "H.264",
  hevc: "HEVC",
  h265: "HEVC",
  av1: "AV1",
  vp9: "VP9",
  vp8: "VP8",
  mpeg4: "MPEG-4",
  msmpeg4v3: "DivX",
  vc1: "VC-1",
  mpeg2video: "MPEG-2",
};
const AUDIO_LABELS: Record<string, string> = {
  aac: "AAC",
  ac3: "AC3",
  eac3: "E-AC3",
  dts: "DTS",
  dtshd: "DTS-HD",
  truehd: "TrueHD",
  mlp: "TrueHD",
  flac: "FLAC",
  opus: "Opus",
  vorbis: "Vorbis",
  mp3: "MP3",
  pcm_bluray: "PCM",
};

function codecLabel(
  labels: Record<string, string>,
  codec: string | undefined,
): string | undefined {
  if (!codec) return undefined;
  return labels[codec.toLowerCase()] ?? codec.toUpperCase();
}

export function resolutionLabel(
  width: number | undefined,
  height: number | undefined,
): string | undefined {
  if (!height) return undefined;
  // Letterboxed encodes come in a little short of the nominal height.
  if (height >= 2000 || (width ?? 0) >= 3800) return "2160p";
  if (height >= 1000 || (width ?? 0) >= 1900) return "1080p";
  if (height >= 700 || (width ?? 0) >= 1260) return "720p";
  if (height >= 560 || (width ?? 0) >= 1000) return "576p";
  if (height >= 460) return "480p";
  return `${height}p`;
}

// Plain text, up to three lines: what it is · how big; the average bitrate;
// then any player caveat. presentStreams appends the line-fit verdict.
export function describe(
  source: string,
  file: SelectedFile,
  entry: { directPlay?: DirectPlay },
): string {
  const probe = entry.directPlay;
  const first = [
    source,
    resolutionLabel(probe?.width, probe?.height),
    codecLabel(VIDEO_LABELS, probe?.videoCodec),
    codecLabel(AUDIO_LABELS, probe?.audioCodec),
    formatSize(file.length),
  ]
    .filter(Boolean)
    .join(" · ");
  const lines = [first];
  if (probe?.bitrateMbps)
    lines.push(`${probe.bitrateMbps.toFixed(1)} Mbps average`);
  const label = probe && directPlayLabel(probe);
  if (label) lines.push(label);
  return lines.join("\n");
}

function formatSize(bytes: number): string {
  return bytes >= 1_000_000_000
    ? `${(bytes / 1_000_000_000).toFixed(1)} GB`
    : `${Math.round(bytes / 1_000_000)} MB`;
}
