import { describe, expect, it } from "vitest";
import {
  evaluateStreamTest,
  median,
  rateLimitMbps,
  readAheadBytes,
  summarizeSwarm,
  type SwarmMeasurement,
  type SwarmSummary,
} from "../src/stream-verdict.ts";

const GIB3 = 3 * 1024 ** 3;

function swarm(sustainedMbps: number, extra: Partial<SwarmSummary> = {}) {
  return {
    sustainedMbps,
    peakMbps: sustainedMbps,
    atLeast: false,
    stillSpeedingUp: false,
    peers: 20,
    seeders: 5,
    samples: 40,
    bytes: 100e6,
    ...extra,
  } satisfies SwarmSummary;
}

function measurement(
  rates: number[],
  extra: Partial<SwarmMeasurement> = {},
): SwarmMeasurement {
  // One sample every 2 s from t = 2 s; the first 10 s are warm-up.
  return {
    samples: rates.map((downloadMbps, index) => ({
      atMs: (index + 1) * 2000,
      downloadMbps,
      peers: index + 1,
      seeders: index,
    })),
    warmupMs: 10_000,
    bytes: 50e6,
    measuringMs: rates.length * 2000,
    reader: { bytesAfterWarmup: 1e9, windowMs: 60_000, eof: false },
    capped: false,
    ...extra,
  };
}

describe("unit helpers", () => {
  it("takes the median of odd and even lists", () => {
    expect(median([3, 1, 2])).toBe(2);
    expect(median([4, 1, 3, 2])).toBe(2.5);
  });

  it("converts TorrServer's KiB/s limit and read-ahead share", () => {
    expect(rateLimitMbps(0)).toBeUndefined();
    expect(rateLimitMbps(undefined)).toBeUndefined();
    expect(rateLimitMbps(2048)).toBeCloseTo(16.777216, 6);
    expect(readAheadBytes(1000, 95)).toBe(950);
    expect(readAheadBytes(1000, 150)).toBe(1000);
    expect(readAheadBytes(undefined, 95)).toBeUndefined();
    expect(readAheadBytes(1000, 0)).toBeUndefined();
  });
});

describe("summarizeSwarm", () => {
  it("uses the post-warm-up median, the peak and the latest peer counts", () => {
    // Samples at 2..8 s are warm-up; 10..20 s count.
    const summary = summarizeSwarm(
      measurement([40, 40, 40, 40, 5, 6, 7, 8, 9, 10]),
    );
    expect(summary.samples).toBe(6);
    expect(summary.sustainedMbps).toBe(7.5);
    expect(summary.peakMbps).toBe(40);
    expect(summary).toMatchObject({ peers: 10, seeders: 9, atLeast: false });
  });

  it("counts the reader's lower in-order throughput", () => {
    // 30 MB over 60 s is 4 Mbps, below the reported 10 Mbps.
    const summary = summarizeSwarm(
      measurement(Array(10).fill(10), {
        reader: { bytesAfterWarmup: 30e6, windowMs: 60_000, eof: false },
      }),
    );
    expect(summary.sustainedMbps).toBeCloseTo(4, 6);
    // TorrServer's own figure still names the bottleneck.
    expect(summary.downloadMbps).toBe(10);
  });

  it("ignores reader throughput after EOF or over a short window", () => {
    const slowReader = { bytesAfterWarmup: 1e6, windowMs: 60_000 };
    expect(
      summarizeSwarm(
        measurement(Array(10).fill(10), {
          reader: { ...slowReader, eof: true },
        }),
      ).sustainedMbps,
    ).toBe(10);
    expect(
      summarizeSwarm(
        measurement(Array(10).fill(10), {
          reader: { ...slowReader, windowMs: 9_999, eof: false },
        }),
      ).sustainedMbps,
    ).toBe(10);
  });

  it("reports a lower bound when the cap ends a test before enough samples", () => {
    // 256 MiB in 8 s.
    const summary = summarizeSwarm(
      measurement([100, 200, 250, 260], {
        bytes: 256 * 1024 ** 2,
        measuringMs: 8000,
        capped: true,
      }),
    );
    expect(summary.samples).toBe(0);
    expect(summary.sustainedMbps).toBeCloseTo(268.435456, 5);
    expect(summary.downloadMbps).toBeUndefined();
    expect(summary.atLeast).toBe(true);
  });

  it("marks a capped test with enough samples as a lower bound too", () => {
    const summary = summarizeSwarm(
      measurement(Array(10).fill(30), { capped: true }),
    );
    expect(summary.sustainedMbps).toBe(30);
    expect(summary.atLeast).toBe(true);
  });

  it("has no sustained rate from too few samples of an uncapped test", () => {
    // Samples at 10, 12 and 14 s follow the warm-up: three of five needed.
    const summary = summarizeSwarm(measurement([5, 5, 5, 5, 5, 5, 5]));
    expect(summary.samples).toBe(3);
    expect(summary.sustainedMbps).toBeUndefined();
    expect(summary.atLeast).toBe(false);
    expect(summarizeSwarm(measurement([])).peakMbps).toBeUndefined();
  });

  it("flags a swarm that is still speeding up", () => {
    const warm = [1, 1, 1, 1];
    const rising = summarizeSwarm(
      measurement([...warm, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8]),
    );
    expect(rising.stillSpeedingUp).toBe(true);
    const flat = summarizeSwarm(
      measurement([...warm, 6, 6, 5, 6, 6, 5, 6, 6, 6, 6]),
    );
    expect(flat.stillSpeedingUp).toBe(false);
    // Thirds of fewer than two samples are too noisy to call.
    expect(
      summarizeSwarm(measurement([...warm, 1, 1, 1, 9, 9])).stillSpeedingUp,
    ).toBe(false);
  });
});

describe("evaluateStreamTest", () => {
  it("rates a 42-minute episode on a thin swarm (worked example 1)", () => {
    const verdict = evaluateStreamTest({
      bitrateMbps: 9.8,
      durationSeconds: 2520,
      sizeBytes: 3.1e9,
      swarm: swarm(4.1),
      lineMbps: 48,
      cacheWindowBytes: GIB3,
    });
    expect(verdict.level).toBe("too_slow");
    expect(verdict.bottleneck).toBe("swarm");
    expect(verdict.lineStale).toBe(false);
    expect(verdict.remedies?.waitSeconds).toBeCloseTo(3503.41, 1);
    expect(verdict.remedies?.bufferBytes).toBeCloseTo(1.7955e9, -4);
    expect(verdict.remedies?.fitsCache).toBe(true);
    expect(verdict.remedies?.copySeconds).toBeCloseTo(6048.78, 1);
    expect(verdict.remedies?.betterSeeded).toBe(true);
    expect(verdict.remedies?.targetMbps).toBeUndefined();
    expect(verdict.suggestTestLonger).toBe(false);
  });

  it("rates a 4K remux on a slow line (worked example 2)", () => {
    const verdict = evaluateStreamTest({
      bitrateMbps: 60,
      durationSeconds: 7200,
      sizeBytes: 54e9,
      swarm: swarm(40),
      lineMbps: 42,
      cacheWindowBytes: GIB3,
    });
    expect(verdict.level).toBe("too_slow");
    expect(verdict.bottleneck).toBe("line");
    expect(verdict.remedies?.waitSeconds).toBeCloseTo(3600, 6);
    expect(verdict.remedies?.bufferBytes).toBeCloseTo(18e9, -3);
    expect(verdict.remedies?.fitsCache).toBe(false);
    expect(verdict.remedies?.copySeconds).toBeCloseTo(10800, 6);
    expect(verdict.remedies?.targetMbps).toBeCloseTo(33.333, 3);
    expect(verdict.remedies?.targetBytes).toBeCloseTo(30e9, -3);
    expect(verdict.remedies?.betterSeeded).toBe(false);
  });

  it("calls a 1.2x margin smooth with no remedies or bottleneck", () => {
    const verdict = evaluateStreamTest({
      bitrateMbps: 10,
      durationSeconds: 3600,
      sizeBytes: 4.5e9,
      swarm: swarm(12),
      lineMbps: 100,
    });
    expect(verdict).toMatchObject({
      level: "smooth",
      suggestTestLonger: false,
    });
    expect(verdict.bottleneck).toBeUndefined();
    expect(verdict.remedies).toBeUndefined();
  });

  it("gives tight results the wait for a 1.2x margin", () => {
    const verdict = evaluateStreamTest({
      bitrateMbps: 10,
      durationSeconds: 3600,
      sizeBytes: 4.5e9,
      swarm: swarm(11),
      lineMbps: 100,
    });
    expect(verdict.level).toBe("tight");
    expect(verdict.bottleneck).toBe("swarm");
    // D × (1.2B / R − 1) and P = D × (1.2B − R) / 8 in bytes.
    expect(verdict.remedies?.waitSeconds).toBeCloseTo(3600 * (12 / 11 - 1), 6);
    expect(verdict.remedies?.bufferBytes).toBeCloseTo((3600 * 1e6) / 8, -1);
    expect(verdict.remedies?.fitsCache).toBeUndefined();
  });

  it("names TorrServer's rate limit before the line", () => {
    const verdict = evaluateStreamTest({
      bitrateMbps: 20,
      durationSeconds: 3600,
      sizeBytes: 9e9,
      swarm: swarm(16),
      lineMbps: 17,
      limitMbps: rateLimitMbps(2048),
    });
    expect(verdict.bottleneck).toBe("limit");
    expect(verdict.remedies?.targetMbps).toBeCloseTo(16 / 1.2, 6);
  });

  it("names a limit that caps what peers send, not what arrives in order", () => {
    // Live test: a 96 KiB/s limit held TorrServer at 0.8 Mbps while only
    // 0.4 Mbps reached the reader in order.
    const verdict = evaluateStreamTest({
      bitrateMbps: 1.2,
      durationSeconds: 888,
      sizeBytes: 129_241_752,
      swarm: swarm(0.4, { downloadMbps: 0.8 }),
      lineMbps: 3.6,
      limitMbps: rateLimitMbps(96),
    });
    expect(verdict.level).toBe("too_slow");
    expect(verdict.bottleneck).toBe("limit");
    expect(verdict.remedies?.betterSeeded).toBe(false);
    expect(verdict.remedies?.targetMbps).toBeCloseTo(0.4 / 1.2, 6);
  });

  it("offers to re-measure a line slower than the swarm delivered", () => {
    const verdict = evaluateStreamTest({
      bitrateMbps: 80,
      durationSeconds: 3600,
      sizeBytes: 36e9,
      swarm: swarm(60),
      lineMbps: 48,
    });
    expect(verdict.lineStale).toBe(true);
    expect(verdict.bottleneck).toBe("line");
  });

  it("checks the line reading against what peers sent", () => {
    const verdict = evaluateStreamTest({
      bitrateMbps: 10,
      durationSeconds: 3600,
      sizeBytes: 4.5e9,
      swarm: swarm(5, { downloadMbps: 12 }),
      lineMbps: 10,
    });
    expect(verdict.lineStale).toBe(true);
    expect(verdict.bottleneck).toBe("line");
  });

  it("derives the duration from size and bitrate when ffprobe had none", () => {
    const verdict = evaluateStreamTest({
      bitrateMbps: 8,
      sizeBytes: 3.6e9,
      swarm: swarm(4),
    });
    // 3.6 GB at 8 Mbps is 3600 s; waiting D × (8/4 − 1).
    expect(verdict.remedies?.waitSeconds).toBeCloseTo(3600, 6);
  });

  it("suggests testing longer for lower bounds or rising swarms that are not smooth", () => {
    const base = { bitrateMbps: 20, durationSeconds: 3600, sizeBytes: 9e9 };
    expect(
      evaluateStreamTest({ ...base, swarm: swarm(10, { atLeast: true }) }),
    ).toMatchObject({
      level: "too_slow",
      suggestTestLonger: true,
      flags: { atLeast: true },
    });
    expect(
      evaluateStreamTest({
        ...base,
        swarm: swarm(10, { stillSpeedingUp: true }),
      }).suggestTestLonger,
    ).toBe(true);
    expect(
      evaluateStreamTest({
        ...base,
        swarm: swarm(10, { samples: 0, atLeast: true }),
      }).suggestTestLonger,
    ).toBe(true);
    expect(
      evaluateStreamTest({ ...base, swarm: swarm(30, { atLeast: true }) }),
    ).toMatchObject({ level: "smooth", suggestTestLonger: false });
  });

  it("reports a disk copy sharing the line", () => {
    expect(
      evaluateStreamTest({
        bitrateMbps: 20,
        durationSeconds: 3600,
        sizeBytes: 9e9,
        swarm: swarm(10),
        sharedWithDiskCopy: true,
      }).flags.sharedWithDiskCopy,
    ).toBe(true);
  });

  it("reports playback sharing the line without changing the level", () => {
    const input = {
      bitrateMbps: 2,
      durationSeconds: 3600,
      sizeBytes: 9e8,
      swarm: swarm(10),
    };
    const alone = evaluateStreamTest(input);
    const shared = evaluateStreamTest({ ...input, sharedWithPlayback: true });
    expect(alone.flags.sharedWithPlayback).toBe(false);
    expect(shared.flags.sharedWithPlayback).toBe(true);
    expect({ ...shared, flags: alone.flags }).toEqual(alone);
    expect(
      evaluateStreamTest({ noMetadata: true, sharedWithPlayback: true }).flags
        .sharedWithPlayback,
    ).toBe(true);
  });

  it("stays inconclusive with a reason when it cannot judge", () => {
    expect(evaluateStreamTest({ noMetadata: true })).toMatchObject({
      level: "inconclusive",
      reason: "no_metadata",
      suggestTestLonger: true,
    });
    expect(
      evaluateStreamTest({ bitrateMbps: 5, swarm: swarm(0) }),
    ).toMatchObject({ level: "inconclusive", reason: "no_peers" });
    const few = { ...swarm(5), sustainedMbps: undefined, samples: 2 };
    expect(evaluateStreamTest({ bitrateMbps: 5, swarm: few })).toMatchObject({
      level: "inconclusive",
      reason: "few_samples",
      suggestTestLonger: true,
    });
    expect(
      evaluateStreamTest({ bitrateMbps: 5, swarm: few, streamStarted: true }),
    ).toMatchObject({
      level: "inconclusive",
      reason: "stream_started",
      suggestTestLonger: false,
    });
    const unknown = evaluateStreamTest({ swarm: swarm(9), lineMbps: 5 });
    expect(unknown).toMatchObject({
      level: "inconclusive",
      reason: "unknown_bitrate",
      lineStale: true,
    });
    expect(unknown.remedies).toBeUndefined();
  });
});
