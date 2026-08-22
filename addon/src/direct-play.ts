import { z } from "zod";

// Codecs that commonly force a TV or player into software decoding, which is
// the usual cause of stutter that looks like a network problem.
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
  compatibility: z.enum(["direct", "caution", "risky"]),
  warnings: z.array(z.string()),
  probedAt: z.string().datetime(),
});

export type DirectPlay = z.infer<typeof directPlaySchema>;

export type ProbeSummary = {
  container?: string;
  videoCodec?: string;
  audioCodec?: string;
  width?: number;
  height?: number;
  bitrateMbps?: number;
  recommendedMbps?: number;
};

export function assessDirectPlay(
  probe: ProbeSummary,
  homeSpeedMbps?: number,
): DirectPlay {
  const warnings: string[] = [];
  let compatibility: DirectPlay["compatibility"] = "direct";

  const audio = probe.audioCodec?.toLowerCase();
  if (audio && RISKY_AUDIO.has(audio)) {
    warnings.push(
      `${probe.audioCodec} audio is often software-decoded and is the most common cause of stutter`,
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

  // The bitrate check is about sustained link capacity, not decoding, so it
  // uses the same 1.5x headroom the inspect endpoint already reports.
  if (probe.bitrateMbps && homeSpeedMbps) {
    const required = probe.bitrateMbps * 1.5;
    if (required > homeSpeedMbps) {
      warnings.push(
        `needs about ${required.toFixed(1)} Mbps sustained but the link is ${homeSpeedMbps} Mbps`,
      );
      compatibility = "risky";
    }
  }

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
  const prefix = directPlay.compatibility === "risky" ? "May stutter" : "Check";
  return `${prefix}: ${directPlay.warnings.join("; ")}`;
}
