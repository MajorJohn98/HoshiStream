import { SUSTAIN_MARGIN } from "./playback-telemetry.ts";

// Pure math for the pre-add stream test: how fast the file plays (B), how
// fast its peers deliver it here (R), which limit is to blame, and what the
// owner can do. Inputs are in Mbps, seconds and bytes; see the stream-test
// plan (2026-09-30) for the rules and worked examples.

/** Post-warm-up samples needed before a median counts as sustained. */
export const MIN_SAMPLES = 5;
/** A later-samples median this much above the early one means "speeding up". */
export const SPEEDING_UP_RATIO = 1.25;
/** A named limit is "the" bottleneck when R reaches this share of it. */
export const LIMIT_SHARE = 0.9;
/** R above this multiple of the line reading means the reading is stale. */
export const STALE_LINE_RATIO = 1.1;
/** The reader's own throughput counts only over at least this window. */
export const MIN_GOODPUT_WINDOW_MS = 10_000;

export type SwarmSample = {
  /** Milliseconds since measuring began. */
  atMs: number;
  downloadMbps: number;
  peers: number;
  seeders: number;
};

export type SwarmMeasurement = {
  samples: SwarmSample[];
  warmupMs: number;
  /** The larger of cache growth and bytes the test's reader received. */
  bytes: number;
  measuringMs: number;
  reader: { bytesAfterWarmup: number; windowMs: number; eof: boolean };
  /** The byte cap or the end of the file stopped the test early. */
  capped: boolean;
};

export type SwarmSummary = {
  /** R: what a player would get, in order. Sets the verdict level. */
  sustainedMbps?: number;
  /**
   * TorrServer's median download rate after warm-up. It counts every byte
   * peers send, so under a rate limit it can run well above what arrives in
   * order. It names the bottleneck and spots a stale line reading.
   */
  downloadMbps?: number;
  peakMbps?: number;
  atLeast: boolean;
  stillSpeedingUp: boolean;
  peers?: number;
  seeders?: number;
  /** Samples taken after warm-up. */
  samples: number;
  bytes: number;
};

export type InconclusiveReason =
  | "no_metadata"
  | "no_peers"
  | "few_samples"
  | "unknown_bitrate"
  | "stream_started";

export type Bottleneck = "limit" | "line" | "swarm";

export type StreamRemedies = {
  /** Seconds to buffer before pressing play. */
  waitSeconds: number;
  /** Buffered bytes at the moment playback starts after that wait. */
  bufferBytes: number;
  /** Whether that buffer fits TorrServer's read-ahead window, if known. */
  fitsCache?: boolean;
  /** Seconds to copy the whole file to disk at the measured rate. */
  copySeconds?: number;
  /** When the line or limit is the bottleneck: a bitrate that should fit. */
  targetMbps?: number;
  targetBytes?: number;
  /** When the swarm is the bottleneck: a better-seeded release may help. */
  betterSeeded: boolean;
};

export type StreamVerdict = {
  level: "smooth" | "tight" | "too_slow" | "inconclusive";
  reason?: InconclusiveReason;
  bottleneck?: Bottleneck;
  /** The measured rate beat the line reading: offer to measure the line. */
  lineStale: boolean;
  remedies?: StreamRemedies;
  flags: {
    atLeast: boolean;
    stillSpeedingUp: boolean;
    sharedWithDiskCopy: boolean;
    /** Test anyway measured while something streamed on the same line. */
    sharedWithPlayback: boolean;
  };
  suggestTestLonger: boolean;
};

export type VerdictInput = {
  /** B: the file's average bitrate. */
  bitrateMbps?: number;
  /** D: its duration. */
  durationSeconds?: number;
  /** S: its size. */
  sizeBytes?: number;
  swarm?: SwarmSummary;
  /** L: the owner's line speed. */
  lineMbps?: number;
  /** K: TorrServer's download rate limit, when one is set. */
  limitMbps?: number;
  /** C: TorrServer's read-ahead window. */
  cacheWindowBytes?: number;
  sharedWithDiskCopy?: boolean;
  sharedWithPlayback?: boolean;
  /** A stream started, so the test stopped early. */
  streamStarted?: boolean;
  /** Metadata never arrived. */
  noMetadata?: boolean;
};

export function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2
    ? sorted[middle]!
    : (sorted[middle - 1]! + sorted[middle]!) / 2;
}

const mbps = (bytes: number, ms: number) => (bytes * 8) / (ms / 1000) / 1e6;

/** TorrServer's `DownloadRateLimit` is KiB/s; 0 means unlimited. */
export function rateLimitMbps(downloadRateLimit?: number): number | undefined {
  return downloadRateLimit && downloadRateLimit > 0
    ? (downloadRateLimit * 1024 * 8) / 1e6
    : undefined;
}

/** `CacheSize` is bytes and `ReaderReadAHead` a percentage of it. */
export function readAheadBytes(
  cacheSize?: number,
  readerReadAhead?: number,
): number | undefined {
  return cacheSize && cacheSize > 0 && readerReadAhead && readerReadAhead > 0
    ? Math.floor((cacheSize * Math.min(readerReadAhead, 100)) / 100)
    : undefined;
}

export function summarizeSwarm(measurement: SwarmMeasurement): SwarmSummary {
  const settled = measurement.samples.filter(
    (sample) => sample.atMs >= measurement.warmupMs,
  );
  const rates = settled.map((sample) => sample.downloadMbps);
  const latest = measurement.samples.at(-1);
  let sustainedMbps: number | undefined;
  let downloadMbps: number | undefined;
  if (rates.length >= MIN_SAMPLES) {
    downloadMbps = median(rates);
    sustainedMbps = downloadMbps;
    const { reader } = measurement;
    // The rate TorrServer reports can include pieces the reader never got
    // in order; the lower of the two figures is what a player would see.
    if (!reader.eof && reader.windowMs >= MIN_GOODPUT_WINDOW_MS)
      sustainedMbps = Math.min(
        sustainedMbps,
        mbps(reader.bytesAfterWarmup, reader.windowMs),
      );
  } else if (measurement.capped && measurement.measuringMs > 0) {
    sustainedMbps = mbps(measurement.bytes, measurement.measuringMs);
  }
  const third = Math.floor(rates.length / 3);
  const late = third >= 2 ? median(rates.slice(-third)) : 0;
  const stillSpeedingUp =
    late > 0 && late >= SPEEDING_UP_RATIO * median(rates.slice(0, third));
  return {
    ...(sustainedMbps === undefined ? {} : { sustainedMbps }),
    ...(downloadMbps === undefined ? {} : { downloadMbps }),
    ...(measurement.samples.length
      ? {
          peakMbps: Math.max(
            ...measurement.samples.map((sample) => sample.downloadMbps),
          ),
        }
      : {}),
    atLeast: measurement.capped && sustainedMbps !== undefined,
    stillSpeedingUp,
    ...(latest ? { peers: latest.peers, seeders: latest.seeders } : {}),
    samples: rates.length,
    bytes: measurement.bytes,
  };
}

function bottleneckFor(
  rate: number,
  line?: number,
  limit?: number,
): Bottleneck {
  if (limit !== undefined && limit > 0 && rate >= LIMIT_SHARE * limit)
    return "limit";
  if (line !== undefined && line > 0 && rate >= LIMIT_SHARE * line)
    return "line";
  return "swarm";
}

export function evaluateStreamTest(input: VerdictInput): StreamVerdict {
  const swarm = input.swarm;
  const rate = swarm?.sustainedMbps;
  // A limit or line caps what peers send, not what arrives in order, so
  // compare them with TorrServer's own rate.
  const sent = swarm?.downloadMbps ?? rate;
  const flags = {
    atLeast: swarm?.atLeast ?? false,
    stillSpeedingUp: swarm?.stillSpeedingUp ?? false,
    sharedWithDiskCopy: input.sharedWithDiskCopy ?? false,
    sharedWithPlayback: input.sharedWithPlayback ?? false,
  };
  const lineStale =
    sent !== undefined &&
    input.lineMbps !== undefined &&
    input.lineMbps > 0 &&
    sent > STALE_LINE_RATIO * input.lineMbps;
  // A longer test waits longer for metadata, peers and the probe; only a
  // stream that interrupted the test calls for waiting instead.
  const inconclusive = (reason: InconclusiveReason): StreamVerdict => ({
    level: "inconclusive",
    reason,
    lineStale,
    flags,
    suggestTestLonger: reason !== "stream_started",
  });
  if (input.noMetadata) return inconclusive("no_metadata");
  if (rate === undefined)
    return inconclusive(input.streamStarted ? "stream_started" : "few_samples");
  if (rate <= 0) return inconclusive("no_peers");
  const bitrate = input.bitrateMbps;
  if (bitrate === undefined || !(bitrate > 0))
    return inconclusive("unknown_bitrate");

  const level =
    rate >= SUSTAIN_MARGIN * bitrate
      ? "smooth"
      : rate >= bitrate
        ? "tight"
        : "too_slow";
  const verdict: StreamVerdict = {
    level,
    lineStale,
    flags,
    suggestTestLonger:
      level !== "smooth" &&
      (flags.atLeast ||
        flags.stillSpeedingUp ||
        (swarm?.samples ?? 0) < MIN_SAMPLES),
  };
  if (level === "smooth") return verdict;

  const bottleneck = bottleneckFor(
    swarm?.downloadMbps ?? rate,
    input.lineMbps,
    input.limitMbps,
  );
  verdict.bottleneck = bottleneck;
  const size = input.sizeBytes ?? 0;
  const duration =
    input.durationSeconds && input.durationSeconds > 0
      ? input.durationSeconds
      : size > 0
        ? (size * 8) / (bitrate * 1e6)
        : undefined;
  if (duration === undefined) return verdict;
  const need = level === "tight" ? SUSTAIN_MARGIN * bitrate : bitrate;
  const waitSeconds = duration * (need / rate - 1);
  const bufferBytes = (waitSeconds * rate * 1e6) / 8;
  const targetMbps = bottleneck === "swarm" ? undefined : rate / SUSTAIN_MARGIN;
  verdict.remedies = {
    waitSeconds,
    bufferBytes,
    ...(input.cacheWindowBytes === undefined
      ? {}
      : { fitsCache: bufferBytes <= input.cacheWindowBytes }),
    ...(size > 0 ? { copySeconds: (size * 8) / (rate * 1e6) } : {}),
    ...(targetMbps === undefined
      ? {}
      : { targetMbps, targetBytes: (targetMbps * 1e6 * duration) / 8 }),
    betterSeeded: bottleneck === "swarm",
  };
  return verdict;
}
