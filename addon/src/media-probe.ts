import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

type Probe = {
  format?: { duration?: string; bit_rate?: string; format_name?: string };
  streams?: Array<{
    codec_type?: string;
    codec_name?: string;
    width?: number;
    height?: number;
  }>;
};

export function summarizeProbe(probe: Probe, sizeBytes: number) {
  const durationSeconds = Number(probe.format?.duration);
  const reportedBitrate = Number(probe.format?.bit_rate);
  const bitrateMbps =
    reportedBitrate > 0
      ? reportedBitrate / 1_000_000
      : durationSeconds > 0
        ? (sizeBytes * 8) / durationSeconds / 1_000_000
        : undefined;
  const video = probe.streams?.find((stream) => stream.codec_type === "video");
  const audio = probe.streams?.find((stream) => stream.codec_type === "audio");
  return {
    sizeBytes,
    durationSeconds: durationSeconds || undefined,
    bitrateMbps,
    recommendedMbps: bitrateMbps ? bitrateMbps * 1.5 : undefined,
    container: probe.format?.format_name?.split(",")[0],
    videoCodec: video?.codec_name,
    audioCodec: audio?.codec_name,
    width: video?.width,
    height: video?.height,
  };
}

export async function probeMedia(
  input: string,
  file: { id: number; length: number; localPath?: string },
) {
  const { stdout } = await execFileAsync(
    "ffprobe",
    [
      "-v",
      "error",
      "-show_entries",
      "format=duration,bit_rate,format_name:stream=codec_type,codec_name,width,height",
      "-of",
      "json",
      input,
    ],
    { timeout: 45_000, maxBuffer: 1_000_000 },
  );
  return summarizeProbe(JSON.parse(stdout) as Probe, file.length);
}
