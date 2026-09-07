import { z } from "zod";
import type { ProbeSummary as MediaSummary } from "./source-check-types.ts";

// Player-support advice, not measurements of torrent availability.
const RISKY_AUDIO = new Set(["dts", "dtshd", "truehd", "mlp", "pcm_bluray"]);
const CAUTION_AUDIO = new Set(["flac", "opus", "vorbis"]);
const RISKY_VIDEO = new Set(["vc1", "mpeg2video"]);
const CAUTION_VIDEO = new Set(["av1", "vp9"]);

export const directPlaySchema = z.object({
  container: z.string().optional(),
  videoCodec: z.string().optional(),
  audioCodec: z.string().optional(),
  width: z.number().int().positive().optional(),
  height: z.number().int().positive().optional(),
  bitrateMbps: z.number().nonnegative().optional(),
  compatibility: z.enum(["direct", "caution", "risky", "unknown"]),
  warnings: z.array(z.string()),
  probedAt: z.string().datetime(),
});

export type DirectPlay = z.infer<typeof directPlaySchema>;

export type ProbeSummary = Partial<MediaSummary>;

export function browserSupport(
  probe: ProbeSummary,
): "likely" | "limited" | "unknown" {
  const container = probe.container?.toLowerCase();
  const video = probe.videoCodec?.toLowerCase();
  if (!container || !video) return "unknown";
  const audio = (
    probe.audioCodecs ?? (probe.audioCodec ? [probe.audioCodec] : [])
  ).map((codec) => codec.toLowerCase());
  const audioKnown = probe.audioTracks === 0 || audio.length > 0;
  if (container === "matroska") {
    // ffprobe uses the same demuxer for MKV and WebM. Its first alias alone
    // cannot establish that a file satisfies the browser's WebM restrictions.
    return ["vp8", "vp9", "av1"].includes(video) ? "unknown" : "limited";
  }
  if (["mov", "mp4"].includes(container) && video === "h264") {
    if (audio.some((codec) => !["aac", "mp3"].includes(codec)))
      return "limited";
    if (probe.pixelFormat && probe.pixelFormat !== "yuv420p") return "limited";
    if (probe.videoLevel !== undefined && probe.videoLevel > 52)
      return "limited";
    if (probe.videoTag && !["avc1", "avc3"].includes(probe.videoTag))
      return "unknown";
    if (
      probe.videoProfile &&
      !["Baseline", "Constrained Baseline", "Main", "High"].includes(
        probe.videoProfile,
      )
    )
      return "limited";
    return audioKnown && probe.pixelFormat && probe.videoProfile
      ? "likely"
      : "unknown";
  }
  if (
    container === "webm" &&
    ["vp8", "vp9", "av1"].includes(video) &&
    audioKnown &&
    audio.every((codec) => ["opus", "vorbis"].includes(codec))
  )
    return probe.pixelFormat === "yuv420p" ? "likely" : "unknown";
  return "limited";
}

export function assessDirectPlay(probe: ProbeSummary): DirectPlay {
  const warnings: string[] = [];
  const browser = browserSupport(probe);
  let compatibility: DirectPlay["compatibility"] =
    browser === "likely"
      ? "direct"
      : browser === "limited"
        ? "caution"
        : "unknown";

  const audio = probe.audioCodec?.toLowerCase();
  if (audio && RISKY_AUDIO.has(audio)) {
    warnings.push(
      `${probe.audioCodec} audio support depends on the player; this does not measure torrent availability`,
    );
    compatibility = "risky";
  } else if (audio && CAUTION_AUDIO.has(audio)) {
    warnings.push(`${probe.audioCodec} audio is not supported by every player`);
    compatibility = "caution";
  }

  const video = probe.videoCodec?.toLowerCase();
  if (video && RISKY_VIDEO.has(video)) {
    warnings.push(`${probe.videoCodec} video rarely has hardware decoding`);
    compatibility = "risky";
  } else if (video && CAUTION_VIDEO.has(video)) {
    warnings.push(`${probe.videoCodec} video needs a recent device to decode`);
    if (compatibility === "direct") compatibility = "caution";
  }

  if (browser === "limited")
    warnings.push(
      "Browser format support is limited; a native player may support this file",
    );
  else if (browser === "unknown")
    warnings.push(
      "Browser support is uncertain from the available media metadata",
    );

  return {
    container: probe.container,
    videoCodec: probe.videoCodec,
    audioCodec: probe.audioCodec,
    width: probe.width,
    height: probe.height,
    bitrateMbps: probe.bitrateMbps,
    compatibility,
    warnings,
    probedAt: new Date().toISOString(),
  };
}

export function directPlayLabel(directPlay: DirectPlay): string | undefined {
  if (directPlay.compatibility === "direct") return undefined;
  const prefix =
    directPlay.compatibility === "unknown" ? "Unknown support" : "Check player";
  return `${prefix}: ${directPlay.warnings.join("; ")}`;
}
