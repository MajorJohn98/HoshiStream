import { afterEach, describe, expect, it, vi } from "vitest";
import { markStreamActivity, recentEntryActivity } from "../src/activity.ts";
import {
  activeStreamTargets,
  bytesAhead,
  fileAtPiece,
  noteStreamTarget,
  PlaybackTelemetry,
  resetStreamTargets,
  sampleFrom,
} from "../src/playback-telemetry.ts";
import type {
  CacheState,
  TorrentStatus,
  TorrServerClient,
} from "../src/torrserver-client.ts";
import { libraryEntrySchema } from "../src/types.ts";

const PIECE = 4 * 1024 * 1024;

function cache(
  completedPieces: number[],
  readers: CacheState["readers"],
  extra: Partial<CacheState> = {},
): CacheState {
  return {
    hash: "a".repeat(40),
    capacity: 64 * PIECE,
    filled: completedPieces.length * PIECE,
    pieceLength: PIECE,
    pieceCount: 1000,
    completed: new Map(completedPieces.map((index) => [index, true])),
    readers,
    downloadSpeedBps: 0,
    activePeers: 0,
    connectedSeeders: 0,
    ...extra,
  };
}

afterEach(() => resetStreamTargets());

describe("bytesAhead", () => {
  it("counts contiguous completed pieces from the reader piece to the window end", () => {
    const state = cache(
      [10, 11, 12, 13, 15],
      [{ startPiece: 5, endPiece: 20, readerPiece: 10 }],
    );
    // 10..13 complete, 14 missing, so 15 does not count.
    expect(bytesAhead(state)).toBe(4 * PIECE);
  });

  it("stops at the read-ahead window end", () => {
    const state = cache(
      [10, 11, 12, 13, 14, 15],
      [{ startPiece: 5, endPiece: 12, readerPiece: 10 }],
    );
    expect(bytesAhead(state)).toBe(3 * PIECE);
  });

  it("is zero when the reader's own piece is missing or no reader exists", () => {
    expect(
      bytesAhead(
        cache([11, 12], [{ startPiece: 5, endPiece: 20, readerPiece: 10 }]),
      ),
    ).toBe(0);
    expect(bytesAhead(cache([10, 11], []))).toBe(0);
  });

  it("reports the shortest runway across readers", () => {
    const state = cache(
      [10, 11, 12, 50],
      [
        { startPiece: 5, endPiece: 20, readerPiece: 10 },
        { startPiece: 45, endPiece: 60, readerPiece: 50 },
      ],
    );
    expect(bytesAhead(state)).toBe(PIECE);
  });
});

describe("sampleFrom", () => {
  it("derives runway seconds and sustainability from bitrate and swarm speed", () => {
    // 8 pieces × 4 MiB = 32 MiB ahead; at 8 Mbps (1 MB/s) that is ~33.5 s.
    const state = cache(
      [0, 1, 2, 3, 4, 5, 6, 7],
      [{ startPiece: 0, endPiece: 30, readerPiece: 0 }],
      { downloadSpeedBps: 1_500_000, activePeers: 12 },
    );
    const sample = sampleFrom(state, 8, Date.UTC(2026, 8, 12, 18, 0, 0));
    expect(sample).toMatchObject({
      at: "2026-09-12T18:00:00.000Z",
      readers: 1,
      aheadBytes: 8 * PIECE,
      runwaySeconds: 33.6,
      downloadMbps: 12,
      bitrateMbps: 8,
      sustainable: true,
      activePeers: 12,
    });
    // 12 Mbps swarm vs 11 Mbps bitrate is under the 1.2× margin.
    expect(sampleFrom(state, 11, 0).sustainable).toBe(false);
  });

  it("leaves runway and sustainability unknown without a bitrate", () => {
    const sample = sampleFrom(
      cache([0], [{ startPiece: 0, endPiece: 5, readerPiece: 0 }]),
      undefined,
      0,
    );
    expect(sample.runwaySeconds).toBeNull();
    expect(sample.bitrateMbps).toBeNull();
    expect(sample.sustainable).toBeNull();
    expect(sample.aheadBytes).toBe(PIECE);
  });
});

describe("stream targets", () => {
  it("lists only entries with recent streaming activity and forgets the rest", () => {
    const now = 1_000_000_000;
    noteStreamTarget({
      entryId: "hoshi:fresh",
      hash: "f".repeat(40),
      fileId: 1,
      title: "Fresh",
    });
    noteStreamTarget({
      entryId: "hoshi:stale",
      hash: "e".repeat(40),
      fileId: 1,
      title: "Stale",
    });
    markStreamActivity(now, "hoshi:fresh");
    markStreamActivity(now - 600_000, "hoshi:stale");
    expect(activeStreamTargets(now).map((t) => t.entryId)).toEqual([
      "hoshi:fresh",
    ]);
    // Even once fresh again, the stale target is gone until re-noted.
    markStreamActivity(now, "hoshi:stale");
    expect(activeStreamTargets(now).map((t) => t.entryId)).toEqual([
      "hoshi:fresh",
    ]);
  });
});

describe("fileAtPiece", () => {
  const files = [
    { id: 0, path: "a", length: 10 * PIECE },
    { id: 1, path: "b", length: PIECE / 2 },
    { id: 2, path: "c", length: 5 * PIECE },
  ];
  it("finds the file whose byte range holds the piece", () => {
    expect(fileAtPiece(files, 0, PIECE)?.id).toBe(0);
    expect(fileAtPiece(files, 9, PIECE)?.id).toBe(0);
    expect(fileAtPiece(files, 10, PIECE)?.id).toBe(1);
    expect(fileAtPiece(files, 11, PIECE)?.id).toBe(2);
  });
  it("falls back to the last file past the end and to nothing when empty", () => {
    expect(fileAtPiece(files, 99, PIECE)?.id).toBe(2);
    expect(fileAtPiece([], 0, PIECE)).toBeUndefined();
  });
});

describe("PlaybackTelemetry", () => {
  function setup(states: (CacheState | undefined)[]) {
    const cacheState = vi.fn<TorrServerClient["cacheState"]>();
    for (const state of states) cacheState.mockResolvedValueOnce(state);
    const log = vi.fn<(line: string) => void>();
    let clock = 10_000_000;
    const telemetry = new PlaybackTelemetry(
      { cacheState } as unknown as TorrServerClient,
      { ringSize: 3, now: () => clock, log },
    );
    noteStreamTarget({
      entryId: "hoshi:a",
      hash: "a".repeat(40),
      fileId: 2,
      title: "A",
      bitrateMbps: 8,
    });
    markStreamActivity(clock, "hoshi:a");
    return {
      telemetry,
      cacheState,
      log,
      tick: async (ms = 2000) => {
        clock += ms;
        markStreamActivity(clock, "hoshi:a");
        await telemetry.sample(clock);
      },
    };
  }

  it("keeps a bounded ring per entry and reports the latest sample", async () => {
    const reader = [{ startPiece: 0, endPiece: 40, readerPiece: 0 }];
    const { telemetry, tick, cacheState } = setup([
      cache([0], reader),
      cache([0, 1], reader),
      cache([0, 1, 2], reader),
      cache([0, 1, 2, 3], reader),
    ]);
    for (let i = 0; i < 4; i += 1) await tick();
    const [stream] = telemetry.report();
    expect(stream.entryId).toBe("hoshi:a");
    expect(stream.samples).toHaveLength(3);
    expect(stream.samples.map((s) => s.aheadBytes / PIECE)).toEqual([2, 3, 4]);
    expect(stream.latest?.aheadBytes).toBe(4 * PIECE);
    expect(cacheState).toHaveBeenCalledWith("a".repeat(40));
  });

  it("warns once per 30 s while runway is low and a reader is attached", async () => {
    const reader = [{ startPiece: 0, endPiece: 40, readerPiece: 0 }];
    const low = cache([0], reader, { downloadSpeedBps: 200_000 });
    const { tick, log } = setup([
      low,
      low,
      low,
      low,
      low,
      low,
      low,
      low,
      low,
      low,
      low,
      low,
      low,
      low,
      low,
      low,
      low,
      low,
      low,
      low,
    ]);
    for (let i = 0; i < 20; i += 1) await tick(2000);
    // 40 s elapsed → first warn at t+2 s, second at t+32 s.
    expect(log).toHaveBeenCalledTimes(2);
    const line = JSON.parse(log.mock.calls[0][0]);
    expect(line).toMatchObject({
      level: "warn",
      event: "playback_sample",
      entryId: "hoshi:a",
      fileId: 2,
      readers: 1,
    });
    expect(line.runwaySeconds).toBeLessThan(10);
    expect(JSON.stringify(line)).not.toMatch(/magnet:|authorization/i);
  });

  it("stays quiet without a reader, with unknown bitrate, or with ample runway", async () => {
    const reader = [{ startPiece: 0, endPiece: 40, readerPiece: 0 }];
    const { tick, log, telemetry } = setup([
      cache([0], []),
      cache(
        Array.from({ length: 30 }, (_, i) => i),
        reader,
      ),
      undefined,
    ]);
    await tick();
    await tick();
    await tick();
    expect(log).not.toHaveBeenCalled();
    // The undefined cache (metadata pending) adds no sample.
    expect(telemetry.report()[0].samples).toHaveLength(2);
  });

  it("swallows TorrServer failures and drops entries once streaming stops", async () => {
    const cacheState = vi
      .fn<TorrServerClient["cacheState"]>()
      .mockRejectedValue(new Error("boom"));
    let clock = 5_000_000;
    const telemetry = new PlaybackTelemetry(
      { cacheState } as unknown as TorrServerClient,
      { now: () => clock },
    );
    noteStreamTarget({
      entryId: "hoshi:b",
      hash: "b".repeat(40),
      fileId: 1,
      title: "B",
    });
    markStreamActivity(clock, "hoshi:b");
    await expect(telemetry.sample(clock)).resolves.toBeUndefined();
    expect(telemetry.report(clock)).toHaveLength(1);
    clock += 400_000;
    await telemetry.sample(clock);
    expect(telemetry.report(clock)).toEqual([]);
  });

  it("keeps an entry streaming while a reader is open, then lets it age out", async () => {
    const reader = [{ startPiece: 0, endPiece: 40, readerPiece: 0 }];
    const cacheState = vi
      .fn<TorrServerClient["cacheState"]>()
      .mockResolvedValueOnce(cache([0, 1], reader))
      .mockResolvedValueOnce(cache([0, 1], reader))
      .mockResolvedValue(cache([0, 1], []));
    let clock = 30_000_000;
    const telemetry = new PlaybackTelemetry(
      { cacheState } as unknown as TorrServerClient,
      { now: () => clock },
    );
    noteStreamTarget({
      entryId: "hoshi:d",
      hash: "d".repeat(40),
      fileId: 1,
      title: "D",
      bitrateMbps: 8,
    });
    markStreamActivity(clock, "hoshi:d");
    // Well past the five-minute stream window on every step: only the open
    // reader observed in the previous sample keeps the entry alive.
    for (let step = 0; step < 2; step += 1) {
      await telemetry.sample(clock);
      clock += 240_000;
      expect(recentEntryActivity("hoshi:d", clock)).toBe("streaming");
    }
    // Reader gone: this sample still lands, but nothing refreshes activity.
    await telemetry.sample(clock);
    expect(telemetry.report(clock)).toHaveLength(1);
    clock += 400_000;
    expect(recentEntryActivity("hoshi:d", clock)).toBeUndefined();
    await telemetry.sample(clock);
    expect(telemetry.report(clock)).toEqual([]);
  });

  it("discovers a stream the player started straight from TorrServer", async () => {
    const hash = "e".repeat(40);
    const entry = libraryEntrySchema.parse({
      id: "hoshi:e",
      type: "series",
      name: "E",
      sourceHash: hash,
      magnetUri: `magnet:?xt=urn:btih:${hash}`,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      inspectionCache: {
        hash,
        inspectedAt: new Date().toISOString(),
        selectedFiles: [
          { id: 0, path: "S01E01.mkv", length: 10 * PIECE, episode: 1 },
          { id: 1, path: "S01E02.mkv", length: 10 * PIECE, episode: 2 },
        ],
      },
    });
    const torrent: TorrentStatus = {
      title: "E",
      hash,
      stat: 3,
      stat_string: "Torrent working",
      file_stats: [
        { id: 0, path: "S01E01.mkv", length: 10 * PIECE },
        { id: 1, path: "S01E02.mkv", length: 10 * PIECE },
      ],
    };
    const reader = { startPiece: 10, endPiece: 19, readerPiece: 13 };
    const list = vi
      .fn<TorrServerClient["list"]>()
      .mockResolvedValue([
        torrent,
        { ...torrent, hash: "f".repeat(40), title: "unowned" },
        { ...torrent, hash: "9".repeat(40), stat: 2 },
      ]);
    const cacheState = vi
      .fn<TorrServerClient["cacheState"]>()
      .mockResolvedValue(cache([13, 14], [reader], { hash }));
    const entries = vi.fn().mockResolvedValue([entry]);
    let clock = 40_000_000;
    const telemetry = new PlaybackTelemetry(
      { list, cacheState } as unknown as TorrServerClient,
      { now: () => clock, entries },
    );
    await telemetry.sample(clock);
    expect(recentEntryActivity("hoshi:e", clock)).toBe("streaming");
    const [target] = activeStreamTargets(clock);
    expect(target).toMatchObject({ entryId: "hoshi:e", hash, fileId: 1 });
    const [stream] = telemetry.report(clock);
    expect(stream.latest?.aheadBytes).toBe(2 * PIECE);
    // Only the owned, working torrent was probed for readers.
    expect(cacheState.mock.calls.map(([h]) => h)).toEqual([hash, hash]);
    // A known target is not rediscovered on the next tick.
    clock += 2000;
    await telemetry.sample(clock);
    expect(cacheState).toHaveBeenCalledTimes(3);
    expect(entries).toHaveBeenCalledTimes(1);
  });

  it("ignores working torrents without a reader", async () => {
    const hash = "e".repeat(40);
    const entry = libraryEntrySchema.parse({
      id: "hoshi:e",
      type: "movie",
      name: "E",
      sourceHash: hash,
      magnetUri: `magnet:?xt=urn:btih:${hash}`,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      inspectionCache: {
        hash,
        inspectedAt: new Date().toISOString(),
        selectedFiles: [{ id: 1, path: "E.mkv", length: PIECE }],
      },
    });
    const list = vi.fn<TorrServerClient["list"]>().mockResolvedValue([
      {
        title: "E",
        hash,
        stat: 3,
        stat_string: "Torrent working",
        file_stats: [{ id: 1, path: "E.mkv", length: PIECE }],
      },
    ]);
    const cacheState = vi
      .fn<TorrServerClient["cacheState"]>()
      .mockResolvedValue(cache([0], [], { hash }));
    const telemetry = new PlaybackTelemetry(
      { list, cacheState } as unknown as TorrServerClient,
      { entries: async () => [entry] },
    );
    await telemetry.sample(50_000_000);
    expect(activeStreamTargets(50_000_000)).toEqual([]);
    expect(recentEntryActivity("hoshi:e", 50_000_000)).toBeUndefined();
  });

  it("start() schedules sampling and stop() ends it", async () => {
    vi.useFakeTimers();
    try {
      const cacheState = vi
        .fn<TorrServerClient["cacheState"]>()
        .mockResolvedValue(undefined);
      const telemetry = new PlaybackTelemetry(
        { cacheState } as unknown as TorrServerClient,
        { intervalMs: 50 },
      );
      noteStreamTarget({
        entryId: "hoshi:c",
        hash: "c".repeat(40),
        fileId: 1,
        title: "C",
      });
      markStreamActivity(Date.now(), "hoshi:c");
      telemetry.start();
      telemetry.start();
      await vi.advanceTimersByTimeAsync(120);
      expect(cacheState).toHaveBeenCalledTimes(2);
      telemetry.stop();
      await vi.advanceTimersByTimeAsync(200);
      expect(cacheState).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });
});
