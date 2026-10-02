import { readFile } from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";
import {
  evaluateStreamTest,
  type SwarmSummary,
} from "../src/stream-verdict.ts";

globalThis.location = {
  pathname: "/manage/fixture-token",
} as Location;

const {
  createStreamTestController,
  durationLabel,
  isStreamTestActive,
  magnetTestSource,
  mbpsLabel,
  releaseStreamTest,
  STREAM_TEST_ANYWAY_HINT,
  streamTestAnywayOptions,
  streamTestBadge,
  streamTestFields,
  streamTestFigures,
  streamTestFileLabel,
  streamTestNotes,
  streamTestProgress,
  streamTestRemedies,
  streamTestRequest,
  streamTestRows,
  streamTestStoppedByPlayback,
  streamTestSummary,
} = await import("../assets/manage/components/stream-test.js");

const CACHE = 3 * 1024 ** 3;
const NOW = Date.parse("2026-09-30T12:00:00.000Z");

function swarm(
  sustainedMbps: number,
  overrides: Partial<SwarmSummary> = {},
): SwarmSummary {
  return {
    sustainedMbps,
    peakMbps: sustainedMbps * 1.5,
    atLeast: false,
    stillSpeedingUp: false,
    peers: 23,
    seeders: 9,
    samples: 35,
    bytes: 40e6,
    ...overrides,
  };
}

type Fixture = {
  bitrate: number;
  duration: number;
  size: number;
  rate: number;
  line: number;
  limit?: number;
  swarm?: Partial<SwarmSummary>;
};

// A finished test as the server reports it, judged by the real verdict code.
function finished({
  bitrate,
  duration,
  size,
  rate,
  line,
  limit,
  swarm: swarmOverrides,
}: Fixture) {
  const summary = swarm(rate, swarmOverrides);
  return {
    testId: "test-1",
    phase: "done",
    message: "Test finished.",
    mode: "basic",
    hash: "a".repeat(40),
    elapsedSeconds: 90,
    budgetSeconds: 90,
    expiresAt: new Date(NOW + 6e5).toISOString(),
    file: {
      id: 1,
      name: "Show/Show.S01E01.mkv",
      size,
      season: 1,
      episode: 1,
    },
    bitrate: { mbps: bitrate, durationSeconds: duration },
    swarm: summary,
    line: {
      mbps: line,
      source: "measured",
      measuredAt: new Date(NOW - 5 * 6e4).toISOString(),
    },
    ...(limit === undefined ? {} : { limitMbps: limit }),
    cacheWindowBytes: CACHE,
    stoppedBy: "time",
    verdict: evaluateStreamTest({
      bitrateMbps: bitrate,
      durationSeconds: duration,
      sizeBytes: size,
      swarm: summary,
      lineMbps: line,
      limitMbps: limit,
      cacheWindowBytes: CACHE,
    }),
  };
}

// The plan's worked examples.
const EPISODE = finished({
  bitrate: 9.8,
  duration: 42 * 60,
  size: 3.1e9,
  rate: 4.1,
  line: 48,
});
const REMUX = finished({
  bitrate: 60,
  duration: 2 * 3600,
  size: 54e9,
  rate: 40,
  line: 42,
});

describe("stream test labels", () => {
  it("shares one wording file, copied byte for byte into the companion", async () => {
    const [manage, companion] = await Promise.all(
      ["manage/components", "chrome-extension/lib"].map((folder) =>
        readFile(
          new URL(`../assets/${folder}/stream-test-text.js`, import.meta.url),
          "utf8",
        ),
      ),
    );
    expect(companion).toBe(manage);
    expect(manage).not.toMatch(/^import /m);
  });

  it("rounds rates and durations for reading", () => {
    expect(mbpsLabel(9.8)).toBe("9.8 Mbps");
    expect(mbpsLabel(48)).toBe("48 Mbps");
    expect(mbpsLabel(4.14)).toBe("4.1 Mbps");
    expect(mbpsLabel(123.4)).toBe("123 Mbps");
    expect(durationLabel(10)).toBe("1 min");
    expect(durationLabel(3503)).toBe("58 min");
    expect(durationLabel(6049)).toBe("1 h 41 min");
    expect(durationLabel(10800)).toBe("3 h");
  });

  it("names a file by episode, base name and size", () => {
    expect(
      streamTestFileLabel({
        id: 2,
        name: "Show/Season 1/Show.S01E02.mkv",
        size: 1.2e9,
        season: 1,
        episode: 2,
      }),
    ).toBe("S01E02 · Show.S01E02.mkv · 1.2 GB");
    expect(streamTestFileLabel({ id: 0, name: "Film.mkv", size: 800e6 })).toBe(
      "Film.mkv · 800 MB",
    );
  });
});

describe("stream test badges and summaries", () => {
  it("maps phases and verdicts to short badges", () => {
    expect(streamTestBadge(null)).toEqual({
      tone: "idle",
      label: "Not tested",
    });
    expect(streamTestBadge({ phase: "queued" })).toEqual({
      tone: "warn",
      label: "Queued",
    });
    expect(streamTestBadge({ phase: "metadata" }).label).toBe("Finding peers");
    expect(streamTestBadge({ phase: "measuring" }).label).toBe("Measuring");
    expect(streamTestBadge(EPISODE)).toEqual({
      tone: "bad",
      label: "Won't keep up",
    });
    expect(
      streamTestBadge({ phase: "done", verdict: { level: "smooth" } }),
    ).toEqual({ tone: "ok", label: "Smooth" });
    expect(
      streamTestBadge({ phase: "done", verdict: { level: "tight" } }).tone,
    ).toBe("warn");
    expect(
      streamTestBadge({ phase: "done", verdict: { level: "inconclusive" } }),
    ).toEqual({ tone: "idle", label: "Inconclusive" });
    expect(streamTestBadge({ phase: "failed" })).toEqual({
      tone: "bad",
      label: "Test failed",
    });
    expect(streamTestBadge({ phase: "cancelled" }).label).toBe("Cancelled");
    expect(streamTestBadge({ phase: "done" }).label).toBe("Finished");
  });

  it("treats only queued, metadata and measuring as active", () => {
    expect(isStreamTestActive({ phase: "queued" })).toBe(true);
    expect(isStreamTestActive({ phase: "metadata" })).toBe(true);
    expect(isStreamTestActive({ phase: "measuring" })).toBe(true);
    expect(isStreamTestActive({ phase: "done" })).toBe(false);
    expect(isStreamTestActive(null)).toBe(false);
  });

  it("explains the test before it runs and shows server messages while it does", () => {
    expect(streamTestSummary(null)).toContain("contacts peers");
    expect(
      streamTestSummary({
        phase: "measuring",
        message: "Measuring how fast peers deliver this file…",
      }),
    ).toBe("Measuring how fast peers deliver this file…");
    expect(
      streamTestSummary({
        phase: "failed",
        message: "TorrServer did not answer. Check that it is running.",
      }),
    ).toBe("TorrServer did not answer. Check that it is running.");
  });

  it("names the bottleneck for each worked example", () => {
    expect(streamTestSummary(EPISODE)).toBe(
      "Won't keep up. The swarm is the limit.",
    );
    expect(streamTestSummary(REMUX)).toBe(
      "Won't keep up. Your line is the limit.",
    );
    const limited = finished({
      bitrate: 10,
      duration: 42 * 60,
      size: 3.1e9,
      rate: 11,
      line: 100,
      limit: 12,
    });
    expect(limited.verdict.level).toBe("tight");
    expect(streamTestSummary(limited)).toBe(
      "Tight: it plays, with little room for slow peers or busy scenes. TorrServer's download limit is the limit.",
    );
    const smooth = finished({
      bitrate: 5,
      duration: 42 * 60,
      size: 1.5e9,
      rate: 20,
      line: 100,
    });
    expect(streamTestSummary(smooth)).toBe(
      "Should play smoothly: peers deliver it faster than it plays.",
    );
    expect(streamTestRemedies(smooth)).toEqual([]);
  });

  it("gives each inconclusive reason its own summary", () => {
    const summary = (reason: string) =>
      streamTestSummary({
        phase: "done",
        verdict: { level: "inconclusive", reason, flags: {} },
      });
    expect(summary("no_metadata")).toContain("file list");
    expect(summary("no_peers")).toContain("no peers sent any data");
    expect(summary("few_samples")).toContain("enough readings");
    expect(summary("unknown_bitrate")).toContain("bitrate couldn't be read");
    expect(summary("stream_started")).toContain("playback started");
  });
});

describe("stream test figures and remedies", () => {
  it("shows the figures behind the verdict on one line", () => {
    expect(streamTestFigures(EPISODE)).toBe(
      "Needs 9.8 Mbps · peers deliver 4.1 Mbps (23 peers) · your line 48 Mbps",
    );
    expect(
      streamTestFigures({
        phase: "done",
        bitrate: { mbps: 9.8 },
        swarm: swarm(20, { atLeast: true }),
        limitMbps: 24,
      }),
    ).toBe(
      "Needs 9.8 Mbps · peers deliver at least 20 Mbps (23 peers) · TorrServer limit 24 Mbps",
    );
    expect(
      streamTestFigures({
        phase: "done",
        swarm: {
          peakMbps: 2.5,
          peers: 1,
          atLeast: false,
          stillSpeedingUp: false,
          samples: 2,
          bytes: 1e6,
        },
      }),
    ).toBe("Peers peaked at 2.5 Mbps (1 peer)");
    expect(
      streamTestFigures({ phase: "measuring", bitrate: { mbps: 9 } }),
    ).toBe("");
  });

  it("offers a buffer, a disk copy and better seeders when the swarm is the limit", () => {
    expect(streamTestRemedies(EPISODE)).toEqual([
      "Start it, then pause about 58 min to buffer (1.8 GB; fits the cache).",
      "Save it, then make a disk copy before watching (about 1 h 41 min).",
      "Pick a release with more seeders.",
    ]);
  });

  it("offers a smaller release when the line is the limit and the buffer can't fit", () => {
    expect(streamTestRemedies(REMUX)).toEqual([
      "Pausing to buffer won't help: it needs 18.0 GB, more than TorrServer's 3.2 GB read-ahead cache.",
      "Save it, then make a disk copy before watching (about 3 h).",
      "Pick a release of 33.3 Mbps or less (about 30.0 GB for this runtime).",
    ]);
  });

  it("omits the cache claim when TorrServer's cache size is unknown", () => {
    const verdict = evaluateStreamTest({
      bitrateMbps: 9.8,
      durationSeconds: 42 * 60,
      sizeBytes: 3.1e9,
      swarm: EPISODE.swarm,
      lineMbps: 48,
    });
    expect(
      streamTestRemedies({
        ...EPISODE,
        cacheWindowBytes: undefined,
        verdict,
      })[0],
    ).toBe("Start it, then pause about 58 min to buffer (1.8 GB).");
  });

  it("notes how firm the measurement is", () => {
    const shaky = finished({
      bitrate: 10,
      duration: 42 * 60,
      size: 3.1e9,
      rate: 60,
      line: 50,
      swarm: { atLeast: true, stillSpeedingUp: true },
    });
    expect(shaky.verdict.lineStale).toBe(true);
    expect(streamTestNotes(shaky)).toEqual([
      "The test reached its data limit early, so peers may deliver faster than shown.",
      "Still speeding up: more peers were joining as the test ended.",
      "Peers delivered faster than your last line reading. Measure the line to update it.",
    ]);
    const slow = finished({
      bitrate: 10,
      duration: 42 * 60,
      size: 3.1e9,
      rate: 6,
      line: 50,
      swarm: { stillSpeedingUp: true },
    });
    expect(streamTestNotes(slow)).toContain("Test longer for a firmer result.");
    expect(
      streamTestNotes({
        ...EPISODE,
        stoppedBy: "complete",
        verdict: {
          ...EPISODE.verdict,
          flags: { ...EPISODE.verdict.flags, sharedWithDiskCopy: true },
        },
      }),
    ).toEqual([
      "The whole file arrived during the test.",
      "A disk copy was downloading during the test and shared your line.",
    ]);
    expect(streamTestNotes({ phase: "measuring" })).toEqual([]);
  });

  it("notes playback that stopped or shared a test, and offers Test anyway", () => {
    const stopped = { ...EPISODE, stoppedBy: "stream" };
    expect(streamTestNotes(stopped)).toEqual([
      "Playback started, so the test stopped early.",
    ]);
    // The inconclusive summary already says so.
    expect(
      streamTestNotes({
        ...stopped,
        verdict: evaluateStreamTest({ streamStarted: true }),
      }),
    ).toEqual([]);
    expect(
      streamTestNotes({
        ...EPISODE,
        verdict: {
          ...EPISODE.verdict,
          flags: { ...EPISODE.verdict.flags, sharedWithPlayback: true },
        },
      }),
    ).toEqual([
      "Something was streaming during the test and shared your line.",
    ]);

    expect(streamTestStoppedByPlayback(stopped)).toBe(true);
    expect(
      streamTestStoppedByPlayback({
        phase: "failed",
        code: "streaming_active",
      }),
    ).toBe(true);
    expect(streamTestStoppedByPlayback(EPISODE)).toBe(false);
    expect(
      streamTestStoppedByPlayback({ phase: "failed", code: "probe_failed" }),
    ).toBe(false);
    expect(streamTestStoppedByPlayback(null)).toBe(false);
    expect(STREAM_TEST_ANYWAY_HINT).toMatch(/^Test anyway runs while/);
  });

  it("reports live progress only while measuring", () => {
    expect(
      streamTestProgress({
        phase: "measuring",
        elapsedSeconds: 34,
        budgetSeconds: 90,
        progress: { downloadMbps: 3.2, peers: 12, seeders: 4, bytes: 45e6 },
        bitrate: { mbps: 9.8 },
      }),
    ).toBe(
      "34 s of up to 90 s · 3.2 Mbps now · 12 peers, 4 seeding · 45 MB downloaded · needs 9.8 Mbps",
    );
    expect(
      streamTestProgress({
        phase: "metadata",
        elapsedSeconds: 3,
        budgetSeconds: 180,
      }),
    ).toBe("3 s of up to 180 s");
    expect(
      streamTestProgress({
        phase: "queued",
        elapsedSeconds: 0,
        budgetSeconds: 90,
      }),
    ).toBe("");
    expect(streamTestProgress(EPISODE)).toBe("");
  });

  it("lists the details of a finished test", () => {
    const rows = Object.fromEntries(streamTestRows(EPISODE, NOW));
    expect(rows).toMatchObject({
      File: "S01E01 · Show/Show.S01E01.mkv",
      "File size": "3.1 GB",
      "Average bitrate": "9.8 Mbps",
      Duration: "42 min",
      "Sustained swarm rate": "4.1 Mbps",
      Peers: "23 connected · 9 seeding",
      "Your line": "48 Mbps · measured 5 min ago",
      "Read-ahead cache": "3.2 GB",
      "Downloaded during the test": "40 MB",
      "Test length": "90 s of up to 90 s",
    });
    expect(rows).not.toHaveProperty("TorrServer download limit");
    expect(rows).not.toHaveProperty("TorrServer download rate");
    const capped = Object.fromEntries(
      streamTestRows(
        {
          ...EPISODE,
          swarm: { ...EPISODE.swarm, sustainedMbps: 0.5, downloadMbps: 0.8 },
          limitMbps: 0.8,
        },
        NOW,
      ),
    );
    expect(capped).toMatchObject({
      "Sustained swarm rate": "0.5 Mbps",
      "TorrServer download rate": "0.8 Mbps",
      "TorrServer download limit": "0.8 Mbps",
    });
    const same = Object.fromEntries(
      streamTestRows(
        { ...EPISODE, swarm: { ...EPISODE.swarm, downloadMbps: 4.1 } },
        NOW,
      ),
    );
    expect(same).not.toHaveProperty("TorrServer download rate");
    const configured = Object.fromEntries(
      streamTestRows(
        {
          ...EPISODE,
          mode: "extended",
          line: { mbps: 50, source: "configured" },
        },
        NOW,
      ),
    );
    expect(configured["Your line"]).toBe(
      "50 Mbps · configured, not yet measured",
    );
    expect(configured["Test length"]).toBe("90 s of up to 90 s · longer test");
    expect(streamTestRows(null)).toEqual([]);
  });
});

describe("stream test requests", () => {
  it("checks a pasted magnet before asking the server", () => {
    expect(magnetTestSource("  magnet:?xt=urn:btih:abc  ")).toEqual({
      magnetUri: "magnet:?xt=urn:btih:abc",
    });
    expect(() => magnetTestSource("")).toThrow("Paste a magnet link to test.");
    expect(() => magnetTestSource("https://example.test/file")).toThrow(
      "starts with magnet:?",
    );
  });

  it("sends numbering only for series, with the form's validation", () => {
    expect(
      streamTestFields({ type: "series", seasonHint: "1", episodeHint: "" }),
    ).toEqual({ type: "series", seasonHint: 1 });
    expect(
      streamTestFields({ type: "movie", seasonHint: "1", episodeHint: "2" }),
    ).toEqual({ type: "movie" });
    expect(() =>
      streamTestFields({ type: "series", seasonHint: "", episodeHint: "0" }),
    ).toThrow("Episode must be a whole number");
  });

  it("adds the mode and an optional file to the shared fields", () => {
    const base = {
      source: { magnetUri: "magnet:?xt=urn:btih:abc" },
      type: "movie",
    };
    expect(streamTestRequest(base)).toEqual({ ...base, mode: "basic" });
    expect(streamTestRequest(base, { mode: "extended", fileId: 0 })).toEqual({
      ...base,
      fileId: 0,
      mode: "extended",
    });
    expect(streamTestRequest(base, { allowPlayback: true })).toEqual({
      ...base,
      mode: "basic",
      allowPlayback: true,
    });
  });

  it("repeats the refused start or the shown test for Test anyway", () => {
    const last = { mode: "extended", fileId: 3 };
    expect(
      streamTestAnywayOptions(EPISODE, { blocked: true, last, shown: {} }),
    ).toEqual({ mode: "extended", fileId: 3, allowPlayback: true });
    expect(streamTestAnywayOptions(null, { blocked: true })).toEqual({
      allowPlayback: true,
    });
    expect(
      streamTestAnywayOptions(
        { ...EPISODE, mode: "extended", stoppedBy: "stream" },
        { last, shown: { fileId: 7 } },
      ),
    ).toEqual({
      mode: "extended",
      fileId: 1,
      reuse: true,
      allowPlayback: true,
    });
    // A test that failed in the queue never learned its file.
    const queued = {
      testId: "test-2",
      phase: "failed",
      mode: "basic",
      code: "streaming_active",
    };
    expect(streamTestAnywayOptions(queued, { shown: { fileId: 4 } })).toEqual({
      mode: "basic",
      fileId: 4,
      reuse: true,
      allowPlayback: true,
    });
    expect(streamTestAnywayOptions(queued)).toEqual({
      mode: "basic",
      fileId: undefined,
      reuse: true,
      allowPlayback: true,
    });
  });

  it("ends a test with a DELETE that never throws", async () => {
    const request = vi.fn().mockRejectedValue(new Error("offline"));
    await expect(
      releaseStreamTest("test 1", { keepalive: true, request }),
    ).resolves.toBeUndefined();
    expect(request).toHaveBeenCalledWith("stream-tests/test%201", {
      method: "DELETE",
      keepalive: true,
      signal: expect.any(AbortSignal),
    });
    await releaseStreamTest(undefined, { request });
    expect(request).toHaveBeenCalledTimes(1);
  });
});

describe("stream test controller", () => {
  type Scheduled = { callback: () => Promise<void>; delay: number };
  function harness(load: (testId: string) => Promise<unknown>) {
    const scheduled: Scheduled[] = [];
    const publish = vi.fn();
    const onError = vi.fn();
    const clear = vi.fn();
    const controller = createStreamTestController(load, publish, {
      schedule(callback: () => Promise<void>, delay: number) {
        scheduled.push({ callback, delay });
        return callback;
      },
      clear,
      onError,
    });
    return { controller, scheduled, publish, onError, clear };
  }

  it("polls an active test until it finishes", async () => {
    const load = vi
      .fn()
      .mockResolvedValueOnce({ testId: "a", phase: "measuring" })
      .mockResolvedValueOnce({ testId: "a", phase: "done" });
    const { controller, scheduled, publish } = harness(load);
    controller.update({ testId: "a", phase: "queued" });
    await scheduled.shift()!.callback();
    await scheduled.shift()!.callback();
    expect(load).toHaveBeenCalledTimes(2);
    expect(publish).toHaveBeenLastCalledWith({ testId: "a", phase: "done" });
    expect(scheduled).toHaveLength(0);
    controller.update({ testId: "a", phase: "done" });
    expect(scheduled).toHaveLength(0);
  });

  it("stops polling when stopped", async () => {
    const load = vi.fn();
    const { controller, scheduled, publish, clear } = harness(load);
    controller.update({ testId: "a", phase: "measuring" });
    controller.stop();
    expect(clear).toHaveBeenCalled();
    await Promise.all(scheduled.map(({ callback }) => callback()));
    expect(load).not.toHaveBeenCalled();
    expect(publish).not.toHaveBeenCalled();
  });

  it("gives up at once on a 404 and after three other failures", async () => {
    const gone = harness(() =>
      Promise.reject(Object.assign(new Error("expired"), { status: 404 })),
    );
    gone.controller.update({ testId: "a", phase: "measuring" });
    await gone.scheduled.shift()!.callback();
    expect(gone.onError).toHaveBeenCalledTimes(1);
    expect(gone.scheduled).toHaveLength(0);

    const offline = harness(() => Promise.reject(new Error("offline")));
    offline.controller.update({ testId: "a", phase: "measuring" });
    const delays: number[] = [];
    while (offline.scheduled.length) {
      const next = offline.scheduled.shift()!;
      delays.push(next.delay);
      await next.callback();
    }
    expect(delays).toEqual([2000, 4000, 8000]);
    expect(offline.onError).toHaveBeenCalledTimes(3);
  });

  it("drops a poll for a test that was replaced while it ran", async () => {
    let finishFirst: (value: unknown) => void = () => {};
    const load = vi.fn((testId: string) =>
      testId === "a"
        ? new Promise((resolve) => (finishFirst = resolve))
        : Promise.resolve({ testId: "b", phase: "done" }),
    );
    const { controller, scheduled, publish } = harness(load);
    controller.update({ testId: "a", phase: "measuring" });
    const first = scheduled.shift()!.callback();
    controller.update({ testId: "b", phase: "measuring" });
    finishFirst({ testId: "a", phase: "done" });
    await first;
    expect(publish).not.toHaveBeenCalled();
    await scheduled.shift()!.callback();
    expect(publish).toHaveBeenCalledWith({ testId: "b", phase: "done" });
    expect(scheduled).toHaveLength(0);
  });
});
