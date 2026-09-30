import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import bencode from "bencode";
import { afterEach, describe, expect, it, vi } from "vitest";
import { isStreamTestHash } from "../src/activity.ts";
import { AnalysisSlot } from "../src/analysis-slot.ts";
import { ImportError } from "../src/imports/errors.ts";
import { magnetHash } from "../src/imports/source-identity.ts";
import type { TorrentFile } from "../src/media-file-selection.ts";
import type { probeMedia } from "../src/media-probe.ts";
import {
  StreamTests,
  type StreamTestDependencies,
  type StreamTestDrafts,
  type StreamTestLimits,
  type StreamTestRequest,
  type StreamTestState,
} from "../src/stream-tests.ts";
import { TorrServerError } from "../src/torrserver-client.ts";
import type { LibraryEntry } from "../src/types.ts";

const HASH = "a".repeat(40);
const OTHER = "b".repeat(40);
const MAGNET = `magnet:?xt=urn:btih:${HASH}&dn=Secret.Movie.2024&tr=udp%3A%2F%2Ftracker.example%3A80`;
const MOVIE = {
  id: 1,
  path: "Secret.Movie.2024/Secret.Movie.2024.mkv",
  length: 4_000_000_000,
};
const SAMPLE = {
  id: 2,
  path: "Secret.Movie.2024/Sample/sample.mkv",
  length: 20_000_000,
};
const NFO = { id: 3, path: "Secret.Movie.2024/info.nfo", length: 2_000 };
const FILES = [MOVIE, SAMPLE, NFO];
const CHUNK = new Uint8Array(1 << 20);

const services: StreamTests[] = [];
const directories: string[] = [];

afterEach(async () => {
  await Promise.all(services.splice(0).map((service) => service.close()));
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
  vi.restoreAllMocks();
});

/**
 * Virtual time: the service's sleeps advance it and wake the fake stream,
 * then let pending promise work settle before the service continues.
 */
function fakeClock() {
  const origin = 1_790_000_000_000;
  let now = origin;
  const waiters = new Set<() => void>();
  const events: { at: number; run: () => void }[] = [];
  const advance = (ms: number) => {
    now += ms;
    for (const event of events.filter((item) => now - origin >= item.at)) {
      events.splice(events.indexOf(event), 1);
      event.run();
    }
    for (const wake of [...waiters]) {
      waiters.delete(wake);
      wake();
    }
  };
  return {
    now: () => now,
    advance,
    /** Runs `run` once, when virtual time passes `ms` after the start. */
    at(ms: number, run: () => void) {
      events.push({ at: ms, run });
    },
    tick: () => new Promise<void>((resolve) => waiters.add(resolve)),
    sleep: async (ms: number, signal: AbortSignal) => {
      signal.throwIfAborted();
      advance(ms);
      await new Promise((resolve) => setImmediate(resolve));
      signal.throwIfAborted();
    },
  };
}

type Clock = ReturnType<typeof fakeClock>;
type Swarm = { rateBps: number; peers: number; seeders: number };

type TorrOptions = {
  files?: TorrentFile[];
  known?: string[];
  swarm?: Partial<Swarm>;
  metadata?: "timeout" | Promise<unknown>;
  reportHash?: string;
  torrentHash?: string;
  settings?: Record<string, number>;
  addError?: Error;
};

function abortable<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const cancelled = () =>
      reject(
        new TorrServerError("Torrent inspection was cancelled", "cancelled"),
      );
    if (signal?.aborted) return cancelled();
    signal?.addEventListener("abort", cancelled, { once: true });
    promise.then(resolve, reject);
  });
}

function fakeTorrServer(clock: Clock, options: TorrOptions = {}) {
  const known = new Set(options.known ?? []);
  const swarm: Swarm = {
    rateBps: 500_000,
    peers: 12,
    seeders: 4,
    ...options.swarm,
  };
  const counters = { served: 0 };
  const status = (hash: string) => ({
    hash,
    title: "",
    stat: 3,
    stat_string: "Torrent working",
    file_stats: options.files ?? FILES,
  });
  const register = (hash: string) => {
    known.add(hash);
    return status(hash);
  };
  const torrServer = {
    get: vi.fn(async (hash: string) => {
      if (!known.has(hash))
        throw new TorrServerError("Torrent not found", "not_found", 404);
      return status(hash);
    }),
    addMagnet: vi.fn(async (link: string) => {
      if (options.addError) throw options.addError;
      return register(options.reportHash ?? magnetHash(link)!);
    }),
    addTorrentFile: vi.fn(async () => {
      if (options.addError) throw options.addError;
      return register(options.reportHash ?? options.torrentHash!);
    }),
    waitForFiles: vi.fn(
      async (hash: string, timeoutMs: number, signal?: AbortSignal) => {
        if (options.metadata === "timeout") {
          clock.advance(timeoutMs);
          throw new TorrServerError(
            "Timed out waiting for torrent metadata",
            "metadata_timeout",
          );
        }
        if (options.metadata) await abortable(options.metadata, signal);
        return status(hash);
      },
    ),
    cacheState: vi.fn(async (hash: string) => ({
      hash,
      filled: counters.served,
      downloadSpeedBps: swarm.rateBps,
      activePeers: swarm.peers,
      connectedSeeders: swarm.seeders,
    })),
    settings: vi.fn(async () => ({
      CacheSize: 64 * 1024 ** 2,
      ReaderReadAHead: 95,
      DownloadRateLimit: 0,
      ...options.settings,
    })),
    remove: vi.fn(async (hash: string) => {
      known.delete(hash);
    }),
    streamUrl: (hash: string, file: { id: number }) =>
      `http://torrserver.test/play/${hash}/${file.id}`,
  };
  return { torrServer, known, swarm, counters };
}

type FakeTorr = ReturnType<typeof fakeTorrServer>;

/** Serves the file at the swarm's rate as virtual time passes. */
function fakeFetch(
  clock: Clock,
  torr: FakeTorr,
  options: { status?: number; length?: number } = {},
) {
  return vi.fn(async () => {
    if (options.status && options.status !== 200)
      return {
        ok: false,
        status: options.status,
        body: null,
      } as unknown as Response;
    const length = options.length ?? MOVIE.length;
    let last = clock.now();
    let sent = 0;
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      async pull(controller) {
        await clock.tick();
        if (cancelled) return;
        const now = clock.now();
        let bytes = Math.min(
          length - sent,
          Math.floor((torr.swarm.rateBps * (now - last)) / 1000),
        );
        last = now;
        sent += bytes;
        torr.counters.served += bytes;
        while (bytes > 0) {
          const size = Math.min(bytes, CHUNK.length);
          controller.enqueue(CHUNK.subarray(0, size));
          bytes -= size;
        }
        if (sent >= length) controller.close();
      },
      cancel() {
        cancelled = true;
      },
    });
    return { ok: true, status: 200, body } as unknown as Response;
  });
}

type HarnessOptions = {
  torr?: TorrOptions;
  fetch?: { status?: number; length?: number };
  slot?: AnalysisSlot;
  drafts?: StreamTestDrafts;
  limits?: Partial<StreamTestLimits>;
  bitrateMbps?: number;
  lineMbps?: number;
  diskCopyActive?: () => boolean;
  managedRoot?: string;
};

function harness(options: HarnessOptions = {}) {
  const clock = fakeClock();
  const torr = fakeTorrServer(clock, options.torr);
  const slot = options.slot ?? new AnalysisSlot();
  const entries: LibraryEntry[] = [];
  let lastStream = 0;
  const probe = vi.fn(async () => ({
    bitrateMbps: options.bitrateMbps ?? 2,
    durationSeconds: 3600,
  }));
  const fetch = fakeFetch(clock, torr, options.fetch);
  const service = new StreamTests({
    torrServer:
      torr.torrServer as unknown as StreamTestDependencies["torrServer"],
    library: { list: async () => entries },
    slot,
    ...(options.drafts ? { drafts: options.drafts } : {}),
    probe: probe as unknown as typeof probeMedia,
    fetch: fetch as unknown as typeof globalThis.fetch,
    now: clock.now,
    sleep: clock.sleep,
    lastStreamActivity: () => lastStream,
    lineSpeed: () => ({
      mbps: options.lineMbps ?? 100,
      source: "measured",
      measuredAt: "2026-09-30T08:00:00.000Z",
    }),
    ...(options.diskCopyActive
      ? { diskCopyActive: options.diskCopyActive }
      : {}),
    isManagedPath: async (path) =>
      options.managedRoot !== undefined && path.startsWith(options.managedRoot),
    ...(options.limits ? { limits: options.limits } : {}),
  });
  services.push(service);
  return {
    clock,
    torr,
    slot,
    service,
    entries,
    probe,
    fetch,
    streamAt: (at: number) => {
      lastStream = at;
    },
  };
}

type Harness = ReturnType<typeof harness>;

const FINISHED = new Set(["done", "cancelled", "failed"]);

async function finished(h: Harness, testId: string): Promise<StreamTestState> {
  await vi.waitFor(
    () => {
      const state = h.service.get(testId);
      if (!FINISHED.has(state.phase)) throw new Error(state.phase);
    },
    { timeout: 5_000, interval: 2 },
  );
  return h.service.get(testId);
}

async function run(h: Harness, request: Partial<StreamTestRequest> = {}) {
  const started = await h.service.start({
    source: { magnetUri: MAGNET },
    ...request,
  });
  return finished(h, started.testId);
}

function importError(code: string, status: number) {
  return expect.objectContaining({ code, status });
}

function holdSlot(slot: AnalysisSlot) {
  let release = () => {};
  slot.request("source-check", (done) => {
    release = done;
  });
  return () => release();
}

function entry(fields: Partial<LibraryEntry>): LibraryEntry {
  return {
    id: "entry-1",
    name: "Saved",
    type: "movie",
    ...fields,
  } as LibraryEntry;
}

describe("stream tests", () => {
  it("measures a torrent whose peers keep up and calls it smooth", async () => {
    const h = harness();
    const started = await h.service.start({ source: { magnetUri: MAGNET } });
    expect(started).toMatchObject({
      mode: "basic",
      hash: HASH,
      budgetSeconds: 90,
    });
    const state = await finished(h, started.testId);
    expect(state).toMatchObject({
      phase: "done",
      message: "Test finished.",
      stoppedBy: "time",
      elapsedSeconds: 90,
      file: { id: 1, name: MOVIE.path, size: MOVIE.length },
      bitrate: { mbps: 2, durationSeconds: 3600 },
      swarm: {
        sustainedMbps: 4,
        peakMbps: 4,
        atLeast: false,
        stillSpeedingUp: false,
        peers: 12,
        seeders: 4,
        samples: 41,
      },
      line: { mbps: 100, source: "measured" },
      cacheWindowBytes: Math.floor((64 * 1024 ** 2 * 95) / 100),
      verdict: {
        level: "smooth",
        lineStale: false,
        suggestTestLonger: false,
        flags: { atLeast: false, sharedWithDiskCopy: false },
      },
    });
    // Playable files only, by path, so the owner can test another one.
    expect(state.files?.map((file) => file.id)).toEqual([2, 1]);
    expect(state).not.toHaveProperty("progress");
    expect(state).not.toHaveProperty("limitMbps");
    expect(h.torr.torrServer.addMagnet).toHaveBeenCalledWith(
      MAGNET,
      undefined,
      expect.any(AbortSignal),
    );
    expect(h.probe).toHaveBeenCalledWith(
      `http://torrserver.test/play/${HASH}/1`,
      { id: 1, length: MOVIE.length },
      expect.objectContaining({ bounded: true, timeoutMs: 20_000 }),
    );
    // Kept registered until the result expires, so playing it starts warm.
    expect(h.torr.torrServer.remove).not.toHaveBeenCalled();
    expect(isStreamTestHash(HASH)).toBe(false);
  });

  it("names the swarm as the bottleneck when the file outruns its peers", async () => {
    const h = harness({ bitrateMbps: 8 });
    const state = await run(h);
    expect(state.verdict).toMatchObject({
      level: "too_slow",
      bottleneck: "swarm",
      suggestTestLonger: false,
      remedies: {
        waitSeconds: 3600,
        bufferBytes: 1_800_000_000,
        fitsCache: false,
        copySeconds: 8000,
        betterSeeded: true,
      },
    });
    expect(state.verdict?.remedies).not.toHaveProperty("targetMbps");
  });

  it("blames TorrServer's rate limit and a stale line reading", async () => {
    const limited = harness({
      bitrateMbps: 8,
      torr: { settings: { DownloadRateLimit: 500 } },
    });
    const capped = await run(limited);
    expect(capped.limitMbps).toBe(4.1);
    expect(capped.verdict).toMatchObject({
      bottleneck: "limit",
      remedies: { targetMbps: 3.3, betterSeeded: false },
    });

    const stale = harness({ bitrateMbps: 8, lineMbps: 3 });
    const line = await run(stale);
    expect(line.verdict).toMatchObject({
      bottleneck: "line",
      lineStale: true,
    });
  });

  it("reports when no peer sends the file list and removes the torrent", async () => {
    const h = harness({ torr: { metadata: "timeout" } });
    const state = await run(h);
    expect(state).toMatchObject({
      phase: "done",
      message: "No peers sent the torrent's file list in time.",
      verdict: {
        level: "inconclusive",
        reason: "no_metadata",
        suggestTestLonger: true,
      },
    });
    expect(h.torr.torrServer.waitForFiles).toHaveBeenCalledWith(
      HASH,
      30_000,
      expect.any(AbortSignal),
    );
    await vi.waitFor(() =>
      expect(h.torr.torrServer.remove).toHaveBeenCalledWith(HASH),
    );

    const longer = harness({ torr: { metadata: "timeout" } });
    await run(longer, { mode: "extended" });
    expect(longer.torr.torrServer.waitForFiles).toHaveBeenCalledWith(
      HASH,
      60_000,
      expect.any(AbortSignal),
    );
  });

  it("stops at the byte cap and reports the rate as a lower bound", async () => {
    const h = harness({
      bitrateMbps: 8,
      limits: { capBytes: { basic: 3_000_000, extended: 3_000_000 } },
    });
    const state = await run(h);
    expect(state).toMatchObject({
      phase: "done",
      stoppedBy: "cap",
      message: "Test finished at its data limit.",
      elapsedSeconds: 6,
      swarm: { sustainedMbps: 4, atLeast: true, samples: 0 },
      verdict: {
        level: "too_slow",
        flags: { atLeast: true },
        suggestTestLonger: true,
      },
    });
  });

  it("finishes early when the whole file arrives", async () => {
    const small = { id: 1, path: "clip.mkv", length: 3_000_000 };
    const h = harness({
      torr: { files: [small] },
      fetch: { length: small.length },
    });
    const state = await run(h);
    expect(state).toMatchObject({
      stoppedBy: "complete",
      message: "Test finished: the whole file arrived.",
      elapsedSeconds: 6,
      swarm: { sustainedMbps: 4, atLeast: true },
      verdict: { level: "smooth" },
    });
  });

  it("tests another file on request, and series episodes by hint", async () => {
    const h = harness();
    const sample = await run(h, { fileId: 2 });
    expect(sample.file).toMatchObject({ id: 2, name: SAMPLE.path });

    const episodes = [
      { id: 4, path: "Show/Show.S02E01.mkv", length: 900_000_000 },
      { id: 5, path: "Show/Show.S02E02.mkv", length: 900_000_000 },
    ];
    const series = harness({ torr: { files: episodes } });
    const first = await run(series, { type: "series" });
    expect(first.file).toEqual({
      id: 4,
      name: "Show/Show.S02E01.mkv",
      size: 900_000_000,
      season: 2,
      episode: 1,
    });
    const second = await run(series, { type: "series", fileId: 5 });
    expect(second.file).toMatchObject({ id: 5, season: 2, episode: 2 });
  });

  it("runs longer in extended mode", async () => {
    const h = harness();
    const state = await run(h, { mode: "extended" });
    expect(state).toMatchObject({
      mode: "extended",
      budgetSeconds: 180,
      elapsedSeconds: 180,
    });
    expect(h.probe).toHaveBeenCalledWith(
      expect.any(String),
      expect.anything(),
      expect.objectContaining({ timeoutMs: 60_000 }),
    );
  });

  it("marks the torrent as a test while it runs and flags a shared line", async () => {
    let during: boolean | undefined;
    const h = harness({ diskCopyActive: () => true });
    h.clock.at(20_000, () => {
      during = isStreamTestHash(HASH);
    });
    const state = await run(h);
    expect(during).toBe(true);
    expect(isStreamTestHash(HASH)).toBe(false);
    expect(state.verdict?.flags.sharedWithDiskCopy).toBe(true);
  });

  it("shows live progress while measuring", async () => {
    const h = harness();
    let seen: StreamTestState | undefined;
    const started = await h.service.start({ source: { magnetUri: MAGNET } });
    h.clock.at(20_000, () => {
      seen = h.service.get(started.testId);
    });
    await finished(h, started.testId);
    expect(seen).toMatchObject({
      phase: "measuring",
      message: "Measuring how fast peers deliver this file…",
      progress: { downloadMbps: 4, peers: 12, seeders: 4 },
    });
    expect(seen?.progress?.bytes).toBeGreaterThan(0);
  });

  it("stops early when playback starts", async () => {
    const h = harness();
    h.clock.at(30_000, () => h.streamAt(h.clock.now()));
    const state = await run(h);
    expect(state).toMatchObject({
      phase: "done",
      stoppedBy: "stream",
      message: "Playback started, so the test stopped early.",
      elapsedSeconds: 30,
    });
  });

  it("refuses to start while something streams", async () => {
    const h = harness();
    h.streamAt(h.clock.now() - 5_000);
    await expect(
      h.service.start({ source: { magnetUri: MAGNET } }),
    ).rejects.toEqual(importError("streaming_active", 409));
    h.streamAt(h.clock.now() - 10_000);
    await expect(run(h)).resolves.toMatchObject({ phase: "done" });
  });

  it("fails a queued test when playback started before its turn", async () => {
    const h = harness();
    const releaseCheck = holdSlot(h.slot);
    const started = await h.service.start({ source: { magnetUri: MAGNET } });
    h.streamAt(h.clock.now());
    releaseCheck();
    const state = await finished(h, started.testId);
    expect(state).toMatchObject({ phase: "failed", code: "streaming_active" });
    expect(h.torr.torrServer.addMagnet).not.toHaveBeenCalled();
  });

  it("waits for a running source check, and a check waits for the test", async () => {
    const h = harness();
    const releaseCheck = holdSlot(h.slot);
    const queued = await h.service.start({ source: { magnetUri: MAGNET } });
    expect(queued).toMatchObject({
      phase: "queued",
      message: "Waiting for a source check to finish…",
      elapsedSeconds: 0,
    });
    releaseCheck();
    await expect(finished(h, queued.testId)).resolves.toMatchObject({
      phase: "done",
    });

    const files = Promise.withResolvers<void>();
    const gated = harness({ torr: { metadata: files.promise } });
    const running = await gated.service.start({
      source: { magnetUri: MAGNET },
    });
    let granted = false;
    gated.slot.request("source-check", (release) => {
      granted = true;
      release();
    });
    const second = await gated.service.start({ source: { magnetUri: MAGNET } });
    expect(second.message).toBe("Waiting for another stream test to finish…");
    expect(granted).toBe(false);
    files.resolve();
    await finished(gated, running.testId);
    expect(granted).toBe(true);
    // The check asked first, so the second test waited for it.
    await expect(finished(gated, second.testId)).resolves.toMatchObject({
      phase: "done",
    });
  });

  it("cancels a running test and removes the torrent it added", async () => {
    const files = Promise.withResolvers<void>();
    const h = harness({ torr: { metadata: files.promise } });
    const started = await h.service.start({ source: { magnetUri: MAGNET } });
    h.clock.at(20_000, () => void h.service.delete(started.testId));
    files.resolve();
    await vi.waitFor(() =>
      expect(h.torr.torrServer.remove).toHaveBeenCalledWith(HASH),
    );
    expect(() => h.service.get(started.testId)).toThrow(
      expect.objectContaining({ code: "not_found", status: 404 }),
    );
    expect(isStreamTestHash(HASH)).toBe(false);
  });

  it("cancels during metadata and forgets a queued test", async () => {
    const h = harness({ torr: { metadata: new Promise(() => {}) } });
    const running = await h.service.start({ source: { magnetUri: MAGNET } });
    const queued = await h.service.start({ source: { magnetUri: MAGNET } });
    await h.service.delete(queued.testId);
    await h.service.delete(running.testId);
    await vi.waitFor(() =>
      expect(h.torr.torrServer.remove).toHaveBeenCalledWith(HASH),
    );
    expect(h.torr.torrServer.remove).toHaveBeenCalledTimes(1);
    expect(h.slot.holder()).toBeUndefined();
    await expect(h.service.delete(queued.testId)).rejects.toEqual(
      importError("not_found", 404),
    );
  });

  it("withdraws its turn when the only queued test is cancelled", async () => {
    const h = harness();
    const releaseCheck = holdSlot(h.slot);
    const queued = await h.service.start({ source: { magnetUri: MAGNET } });
    await h.service.delete(queued.testId);
    releaseCheck();
    expect(h.slot.holder()).toBeUndefined();
    expect(h.torr.torrServer.addMagnet).not.toHaveBeenCalled();
    expect(h.torr.torrServer.remove).not.toHaveBeenCalled();
  });

  describe("cleanup", () => {
    it("never removes a torrent TorrServer already had", async () => {
      const h = harness({ torr: { known: [HASH] } });
      const state = await run(h);
      await h.service.delete(state.testId);
      expect(h.torr.torrServer.addMagnet).not.toHaveBeenCalled();
      expect(h.torr.torrServer.remove).not.toHaveBeenCalled();
    });

    it("removes its torrent once the result is dismissed", async () => {
      const h = harness();
      const state = await run(h);
      expect(h.torr.torrServer.remove).not.toHaveBeenCalled();
      await h.service.delete(state.testId);
      expect(h.torr.torrServer.remove).toHaveBeenCalledWith(HASH);
    });

    it("keeps a torrent the owner saved to the library", async () => {
      const h = harness();
      const state = await run(h);
      h.entries.push(entry({ magnetUri: MAGNET }));
      await h.service.delete(state.testId);
      expect(h.torr.torrServer.remove).not.toHaveBeenCalled();
    });

    it("keeps a torrent while another test still holds it", async () => {
      const h = harness();
      const first = await run(h);
      const second = await run(h);
      expect(h.torr.torrServer.addMagnet).toHaveBeenCalledTimes(1);
      await h.service.delete(first.testId);
      expect(h.torr.torrServer.remove).not.toHaveBeenCalled();
      await h.service.delete(second.testId);
      expect(h.torr.torrServer.remove).toHaveBeenCalledWith(HASH);
    });

    it("keeps a torrent a draft uses until the draft is dropped", async () => {
      let inUse = true;
      const listeners = new Set<(draftId: string) => void>();
      const drafts: StreamTestDrafts = {
        draftSource: () => ({ source: { magnetUri: MAGNET }, hash: HASH }),
        hashInUse: (hash) => inUse && hash === HASH,
        onDraftDropped: (listener) => {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
      };
      const h = harness({ drafts });
      const state = await run(h, { source: { draftId: "draft-1" } });
      await h.service.delete(state.testId);
      expect(h.torr.torrServer.remove).not.toHaveBeenCalled();
      inUse = false;
      for (const listener of listeners) listener("draft-1");
      await vi.waitFor(() =>
        expect(h.torr.torrServer.remove).toHaveBeenCalledWith(HASH),
      );
    });

    it("removes the result and the torrent when the result expires", async () => {
      const h = harness();
      const state = await run(h);
      h.clock.advance(10 * 60_000);
      expect(() => h.service.get(state.testId)).toThrow(
        expect.objectContaining({ code: "not_found" }),
      );
      await vi.waitFor(() =>
        expect(h.torr.torrServer.remove).toHaveBeenCalledWith(HASH),
      );
    });

    it("keeps only the newest results", async () => {
      const h = harness({ limits: { maxRecords: 2 } });
      const first = await run(h);
      const second = await run(h);
      const third = await run(h);
      expect(() => h.service.get(first.testId)).toThrow(
        expect.objectContaining({ code: "not_found" }),
      );
      expect(h.service.get(second.testId).phase).toBe("done");
      expect(h.service.get(third.testId).phase).toBe("done");
      expect(h.torr.torrServer.remove).not.toHaveBeenCalled();
    });
  });

  describe("drafts", () => {
    function draftFixture() {
      const listeners = new Set<(draftId: string) => void>();
      const drafts: StreamTestDrafts = {
        draftSource: (draftId) => {
          if (draftId !== "draft-1")
            throw new ImportError(
              "draft_expired",
              "This import draft expired.",
              410,
            );
          return { source: { magnetUri: MAGNET }, hash: HASH };
        },
        hashInUse: () => false,
        onDraftDropped: (listener) => {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
      };
      return {
        drafts,
        drop: (draftId: string) => {
          for (const listener of listeners) listener(draftId);
        },
        listeners,
      };
    }

    it("tests a prepared draft and refuses an expired one", async () => {
      const { drafts } = draftFixture();
      const h = harness({ drafts });
      await expect(
        run(h, { source: { draftId: "draft-1" } }),
      ).resolves.toMatchObject({ phase: "done", hash: HASH });
      await expect(
        h.service.start({ source: { draftId: "draft-2" } }),
      ).rejects.toEqual(importError("draft_expired", 410));
      const without = harness();
      await expect(
        without.service.start({ source: { draftId: "draft-1" } }),
      ).rejects.toEqual(importError("draft_expired", 410));
    });

    it("stops tests of a discarded draft but keeps their results visible", async () => {
      const fixture = draftFixture();
      const files = Promise.withResolvers<void>();
      const h = harness({
        drafts: fixture.drafts,
        torr: { metadata: files.promise },
      });
      const running = await h.service.start({ source: { draftId: "draft-1" } });
      const queued = await h.service.start({ source: { draftId: "draft-1" } });
      fixture.drop("draft-1");
      const discarded = {
        phase: "cancelled",
        code: "draft_discarded",
        message: "The import draft was discarded, so the test stopped.",
      };
      await expect(finished(h, running.testId)).resolves.toMatchObject(
        discarded,
      );
      expect(h.service.get(queued.testId)).toMatchObject(discarded);
      await vi.waitFor(() =>
        expect(h.torr.torrServer.remove).toHaveBeenCalledWith(HASH),
      );
    });

    it("stops listening to drafts when closed", async () => {
      const fixture = draftFixture();
      const h = harness({ drafts: fixture.drafts });
      expect(fixture.listeners.size).toBe(1);
      await h.service.close();
      expect(fixture.listeners.size).toBe(0);
    });
  });

  describe(".torrent sources", () => {
    async function torrentFixture(size = 100) {
      const root = await mkdtemp(join(process.cwd(), ".test-stream-tests-"));
      directories.push(root);
      const info = {
        length: 100,
        name: Buffer.from("Secret.Movie.2024.mkv"),
        "piece length": 16_384,
        pieces: Buffer.alloc(20, 1),
      };
      const bytes = Buffer.from(bencode.encode({ info }));
      const path = join(root, "Secret.Movie.2024.torrent");
      await writeFile(
        path,
        size > bytes.length
          ? Buffer.concat([bytes, Buffer.alloc(size)])
          : bytes,
      );
      const hash = createHash("sha1")
        .update(bencode.encode(info))
        .digest("hex");
      return { root, path, hash };
    }

    it("tests an uploaded .torrent and keeps it once saved by path", async () => {
      const torrent = await torrentFixture();
      const h = harness({
        managedRoot: torrent.root,
        torr: { torrentHash: torrent.hash },
      });
      const state = await run(h, {
        source: { torrentFilePath: torrent.path },
      });
      expect(state).toMatchObject({ phase: "done", hash: torrent.hash });
      expect(h.torr.torrServer.addTorrentFile).toHaveBeenCalledWith(
        torrent.path,
        undefined,
        expect.any(AbortSignal),
      );
      expect(JSON.stringify(state)).not.toContain(torrent.root);
      // A manual save records the path; its hash comes later, on inspection.
      h.entries.push(entry({ torrentFilePath: torrent.path }));
      await h.service.delete(state.testId);
      expect(h.torr.torrServer.remove).not.toHaveBeenCalled();
    });

    it("rejects paths outside the upload area and unreadable files", async () => {
      const torrent = await torrentFixture();
      const outside = harness();
      await expect(
        outside.service.start({ source: { torrentFilePath: torrent.path } }),
      ).rejects.toEqual(importError("invalid_source", 400));
      const h = harness({ managedRoot: torrent.root });
      await expect(
        h.service.start({
          source: { torrentFilePath: join(torrent.root, "missing.torrent") },
        }),
      ).rejects.toEqual(importError("invalid_source", 400));
      await expect(
        h.service.start({
          source: { torrentFilePath: join(torrent.root, "movie.mkv") },
        }),
      ).rejects.toEqual(importError("invalid_source", 400));
      const large = await torrentFixture(1_100_000);
      const big = harness({ managedRoot: large.root });
      await expect(
        big.service.start({ source: { torrentFilePath: large.path } }),
      ).rejects.toMatchObject({
        code: "invalid_source",
        message: "Torrent metadata must be at most 1 MB.",
      });
    });
  });

  describe("failures", () => {
    it("rejects a malformed magnet", async () => {
      const h = harness();
      await expect(
        h.service.start({ source: { magnetUri: "magnet:?xt=urn:btih:zz" } }),
      ).rejects.toMatchObject({
        code: "invalid_source",
        status: 400,
        message: "Choose a valid BitTorrent v1 magnet link.",
      });
    });

    it("fails when TorrServer stops serving the file", async () => {
      const h = harness({ fetch: { status: 500 } });
      const state = await run(h);
      expect(state).toMatchObject({
        phase: "failed",
        code: "read_failed",
        message:
          "TorrServer stopped serving the file during the test. Test again.",
      });
      expect(state).not.toHaveProperty("verdict");
      await vi.waitFor(() =>
        expect(h.torr.torrServer.remove).toHaveBeenCalledWith(HASH),
      );
    });

    it("refuses files that are not playable videos", async () => {
      const h = harness();
      await expect(run(h, { fileId: 3 })).resolves.toMatchObject({
        phase: "failed",
        code: "invalid_file",
      });
      await expect(run(h, { fileId: 99 })).resolves.toMatchObject({
        phase: "failed",
        code: "invalid_file",
      });
      const none = harness({ torr: { files: [NFO] } });
      await expect(run(none)).resolves.toMatchObject({
        phase: "failed",
        code: "no_playable_file",
      });
    });

    it("reports TorrServer outages and mismatched torrents", async () => {
      const down = harness({
        torr: { addError: new TorrServerError("offline", "unavailable") },
      });
      await expect(run(down)).resolves.toMatchObject({
        phase: "failed",
        code: "torrserver_unavailable",
      });

      const other = harness({ torr: { reportHash: OTHER } });
      await expect(run(other)).resolves.toMatchObject({
        phase: "failed",
        code: "source_mismatch",
      });
      await vi.waitFor(() =>
        expect(other.torr.torrServer.remove).toHaveBeenCalledWith(OTHER),
      );
    });
  });

  describe("limits", () => {
    it("refuses a fourth waiting test", async () => {
      const h = harness();
      holdSlot(h.slot);
      for (let index = 0; index < 3; index += 1)
        await h.service.start({ source: { magnetUri: MAGNET } });
      await expect(
        h.service.start({ source: { magnetUri: MAGNET } }),
      ).rejects.toEqual(importError("stream_test_busy", 429));
    });

    it("answers 404 for unknown tests", async () => {
      const h = harness();
      expect(() => h.service.get("missing")).toThrow(
        expect.objectContaining({ code: "not_found", status: 404 }),
      );
    });

    it("cancels everything on close and refuses new tests", async () => {
      const h = harness({ torr: { metadata: new Promise(() => {}) } });
      const running = await h.service.start({ source: { magnetUri: MAGNET } });
      const queued = await h.service.start({ source: { magnetUri: MAGNET } });
      await h.service.close();
      const shutdown = { phase: "cancelled", code: "stream_test_unavailable" };
      expect(h.service.get(running.testId)).toMatchObject(shutdown);
      expect(h.service.get(queued.testId)).toMatchObject(shutdown);
      expect(h.torr.torrServer.remove).toHaveBeenCalledWith(HASH);
      await expect(
        h.service.start({ source: { magnetUri: MAGNET } }),
      ).rejects.toEqual(importError("stream_test_unavailable", 503));
      await h.service.close();
    });
  });

  it("never logs hashes, magnets, paths or file names", async () => {
    const lines: string[] = [];
    const record = (...values: unknown[]) => {
      lines.push(values.map(String).join(" "));
    };
    vi.spyOn(console, "log").mockImplementation(record);
    vi.spyOn(console, "error").mockImplementation(record);
    const h = harness({ bitrateMbps: 8 });
    await run(h);
    const failing = harness({ fetch: { status: 500 } });
    await run(failing);
    const output = lines.join("\n");
    expect(output).toContain("stream_test_started");
    expect(output).toContain("stream_test_finished");
    expect(output).toContain("stream_test_failed");
    for (const secret of [HASH, "magnet:", "Secret.Movie", "tracker.example"])
      expect(output).not.toContain(secret);
  });
});
