import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { z } from "zod";
import type { ProbeSummary } from "./source-check-types.ts";

const execFileAsync = promisify(execFile);

// The supervisor points this at the vendored ffprobe; a bare "ffprobe" from
// PATH keeps dev setups working.
const FFPROBE = process.env.FFPROBE_PATH ?? "ffprobe";

type Probe = {
  format?: { duration?: string; bit_rate?: string; format_name?: string };
  streams?: Array<{
    index?: number;
    codec_type?: string;
    codec_name?: string;
    profile?: string;
    level?: number;
    pix_fmt?: string;
    codec_tag_string?: string;
    width?: number;
    height?: number;
    disposition?: { attached_pic?: number };
  }>;
  frames?: Array<{ media_type?: string; stream_index?: number }>;
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
        index: z.number().int().nonnegative().optional(),
        codec_type: z.string().optional(),
        codec_name: z.string().optional(),
        profile: z.string().optional(),
        level: z.number().int().optional(),
        pix_fmt: z.string().optional(),
        codec_tag_string: z.string().optional(),
        width: z.number().int().nonnegative().optional(),
        height: z.number().int().nonnegative().optional(),
        disposition: z
          .object({ attached_pic: z.number().int().optional() })
          .optional(),
      }),
    )
    .max(128)
    .optional(),
  frames: z
    .array(
      z.object({
        media_type: z.string().optional(),
        stream_index: z.number().int().nonnegative().optional(),
      }),
    )
    .max(512)
    .optional(),
});

export class MediaProbeError extends Error {
  readonly code: string;
  readonly technical?: ProbeSummary;
  constructor(message: string, code: string, technical?: ProbeSummary) {
    super(message);
    this.code = code;
    this.technical = technical;
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
  const video = probe.streams?.find(
    (stream) =>
      stream.codec_type === "video" && !stream.disposition?.attached_pic,
  );
  const audio =
    probe.streams?.filter((stream) => stream.codec_type === "audio") ?? [];
  const aliases = probe.format?.format_name?.split(",");
  return {
    sizeBytes,
    durationSeconds:
      Number.isFinite(durationSeconds) && durationSeconds > 0
        ? durationSeconds
        : undefined,
    bitrateMbps,
    recommendedMbps: bitrateMbps ? bitrateMbps * 1.5 : undefined,
    container: aliases?.[0],
    containerAliases: aliases,
    videoCodec: video?.codec_name,
    videoProfile: video?.profile,
    videoLevel: video?.level,
    pixelFormat: video?.pix_fmt,
    videoTag: video?.codec_tag_string,
    audioCodec: audio[0]?.codec_name,
    audioCodecs: audio.map((stream) => stream.codec_name ?? "unknown"),
    audioTracks: audio.length,
    decodedVideoFrames: probe.frames?.filter(
      (frame) =>
        frame.media_type === "video" &&
        video?.index !== undefined &&
        frame.stream_index === video.index,
    ).length,
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
  // These are host observations, not a promise of browser support or future
  // swarm availability. Every caller has a finite process budget.
  const timeout =
    options.timeoutMs ?? (input.startsWith("http") ? 180_000 : 45_000);
  let stdout: string;
  try {
    const operation = execFileAsync(
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
            ]
          : []),
        "-rw_timeout",
        String(timeout * 1000),
        "-read_intervals",
        "%+#64",
        "-show_frames",
        "-show_entries",
        "format=duration,bit_rate,format_name:stream=index,codec_type,codec_name,profile,level,pix_fmt,codec_tag_string,width,height:stream_disposition=attached_pic:frame=media_type,stream_index",
        "-of",
        "json",
        input,
      ],
      {
        timeout,
        signal: options.signal,
        maxBuffer: 1_000_000,
        killSignal: "SIGKILL",
      },
    );
    // Abort can reject execFile's promise before the subprocess has closed.
    // Keep the coordinator's slot until the child and its pipes are drained.
    const drained = operation.child
      ? new Promise<void>((resolve) =>
          operation.child.once("close", () => resolve()),
        )
      : Promise.resolve();
    ({ stdout } = await operation.finally(() => drained));
  } catch (error) {
    if (options.signal?.aborted)
      throw new MediaProbeError("Playback check was cancelled", "cancelled");
    if (error instanceof Error && "code" in error && error.code === "ENOENT")
      throw new MediaProbeError(
        "ffprobe is not available on this host",
        "probe_unavailable",
      );
    if (
      error instanceof Error &&
      (("killed" in error && error.killed) ||
        ("stderr" in error &&
          typeof error.stderr === "string" &&
          /(?:timed out|timeout)/i.test(error.stderr)))
    )
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
    const technical = summarizeProbe(
      probeSchema.parse(JSON.parse(stdout)),
      file.length,
    );
    if (!technical.videoCodec)
      throw new MediaProbeError(
        "No video stream was identified within the sample",
        "no_video",
        technical,
      );
    if (!technical.decodedVideoFrames)
      throw new MediaProbeError(
        "Metadata was read, but no video frame could be decoded within the sample",
        "sample_unreadable",
        technical,
      );
    return technical;
  } catch (error) {
    if (error instanceof MediaProbeError) throw error;
    throw new MediaProbeError(
      "The media probe returned invalid metadata",
      "probe_response",
    );
  }
}
