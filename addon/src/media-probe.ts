import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { z } from "zod";

const execFileAsync = promisify(execFile);

// The supervisor points this at the vendored ffprobe; a bare "ffprobe" from
// PATH keeps dev setups working.
const FFPROBE = process.env.FFPROBE_PATH ?? "ffprobe";

type Probe = {
  format?: { duration?: string; bit_rate?: string; format_name?: string };
  streams?: Array<{
    codec_type?: string;
    codec_name?: string;
    width?: number;
    height?: number;
  }>;
};
const probeSchema = z.object({
  format: z
    .object({
      duration: z.string().optional(),
      bit_rate: z.string().optional(),
      format_name: z.string().optional(),
    })
    .optional(),
  streams: z
    .array(
      z.object({
        codec_type: z.string().optional(),
        codec_name: z.string().optional(),
        width: z.number().int().nonnegative().optional(),
        height: z.number().int().nonnegative().optional(),
      }),
    )
    .max(128)
    .optional(),
});

export class MediaProbeError extends Error {
  readonly code: string;
  constructor(message: string, code: string) {
    super(message);
    this.code = code;
  }
}

export function summarizeProbe(probe: Probe, sizeBytes: number) {
  const durationSeconds = Number(probe.format?.duration);
  const reportedBitrate = Number(probe.format?.bit_rate);
  const bitrateMbps =
    Number.isFinite(reportedBitrate) && reportedBitrate > 0
      ? reportedBitrate / 1_000_000
      : Number.isFinite(durationSeconds) && durationSeconds > 0
        ? (sizeBytes * 8) / durationSeconds / 1_000_000
        : undefined;
  const video = probe.streams?.find((stream) => stream.codec_type === "video");
  const audio = probe.streams?.find((stream) => stream.codec_type === "audio");
  return {
    sizeBytes,
    durationSeconds:
      Number.isFinite(durationSeconds) && durationSeconds > 0
        ? durationSeconds
        : undefined,
    bitrateMbps,
    recommendedMbps: bitrateMbps ? bitrateMbps * 1.5 : undefined,
    container: probe.format?.format_name?.split(",")[0],
    videoCodec: video?.codec_name,
    audioCodec: audio?.codec_name,
    width: video?.width && video.width > 0 ? video.width : undefined,
    height: video?.height && video.height > 0 ? video.height : undefined,
  };
}

export async function probeMedia(
  input: string,
  file: { id: number; length: number; localPath?: string },
  options: { timeoutMs?: number; signal?: AbortSignal; bounded?: boolean } = {},
) {
  if (options.signal?.aborted)
    throw new MediaProbeError("Playback check was cancelled", "cancelled");
  // Torrent-backed probes read through TorrServer, which may need a minute to
  // fetch the header pieces from a cold swarm; local files answer instantly.
  const timeout =
    options.timeoutMs ?? (input.startsWith("http") ? 180_000 : 45_000);
  let stdout: string;
  try {
    ({ stdout } = await execFileAsync(
      FFPROBE,
      [
        "-v",
        "error",
        ...(options.bounded
          ? [
              "-probesize",
              "2097152",
              "-analyzeduration",
              "3000000",
              "-format_whitelist",
              "mov,matroska,webm,avi,m4v,h264,hevc,mpegvideo,mpegts,ogg",
              "-protocol_whitelist",
              "file,http,https,tcp,tls",
              "-rw_timeout",
              "10000000",
            ]
          : []),
        "-show_entries",
        "format=duration,bit_rate,format_name:stream=codec_type,codec_name,width,height",
        "-of",
        "json",
        input,
      ],
      {
        timeout,
        signal: options.signal,
        maxBuffer: 1_000_000,
        killSignal: options.bounded ? "SIGKILL" : "SIGTERM",
      },
    ));
  } catch (error) {
    if (options.signal?.aborted)
      throw new MediaProbeError("Playback check was cancelled", "cancelled");
    if (error instanceof Error && "code" in error && error.code === "ENOENT")
      throw new MediaProbeError(
        "ffprobe is not available on this host",
        "probe_unavailable",
      );
    if (error instanceof Error && "killed" in error && error.killed)
      throw new MediaProbeError(
        "Timed out reading the video sample",
        "probe_timeout",
      );
    throw new MediaProbeError(
      "The video sample could not be read",
      "probe_failed",
    );
  }
  try {
    return summarizeProbe(probeSchema.parse(JSON.parse(stdout)), file.length);
  } catch {
    throw new MediaProbeError(
      "The media probe returned invalid metadata",
      "probe_response",
    );
  }
}
