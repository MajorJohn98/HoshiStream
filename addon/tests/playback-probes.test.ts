import { afterEach, describe, expect, it, vi } from "vitest";
import { entrySourceDefinitionRevision } from "../src/imports/source-identity.ts";
import { PlaybackProbes } from "../src/playback-probes.ts";
import {
  activeStreamTargets,
  noteStreamTarget,
  PlaybackTelemetry,
  resetStreamTargets,
  setStreamTargetBitrate,
  type StreamTarget,
} from "../src/playback-telemetry.ts";
import { markStreamActivity } from "../src/activity.ts";
import type { SourceChecks } from "../src/source-checks.ts";
import type { TorrServerClient } from "../src/torrserver-client.ts";
import { libraryEntrySchema, type LibraryEntry } from "../src/types.ts";

const hash = "a".repeat(40);
const stamp = "2026-09-13T00:00:00.000Z";

function entry(overrides: Partial<LibraryEntry> = {}): LibraryEntry {
  return libraryEntrySchema.parse({
    id: "hoshi:series",
    type: "series",
    name: "Series",
    sourceHash: hash,
    magnetUri: `magnet:?xt=urn:btih:${hash}`,
    createdAt: stamp,
    updatedAt: stamp,
    inspectionCache: {
      hash,
      inspectedAt: stamp,
      selectedFiles: [
        { id: 1, path: "S01E01.mkv", length: 1000, episode: 1 },
        { id: 2, path: "S01E02.mkv", length: 1000, episode: 2 },
      ],
    },
    ...overrides,
  });
}

const target: StreamTarget = {
  entryId: "hoshi:series",
  hash,
  fileId: 2,
  title: "Series",
};

function completed(bitrateMbps?: number) {
  return {
    check: {
      entryId: "hoshi:series",
      jobId: "11111111-1111-4111-8111-111111111111",
      revision: "0".repeat(64),
      phase: "complete" as const,
      outcome: "observed" as const,
      updatedAt: stamp,
      message: "ok",
      technical: { sizeBytes: 1000, bitrateMbps },
    },
  };
}

function harness(
  current: LibraryEntry,
  checkResult: ReturnType<typeof completed> | Error = completed(4.2),
  status: { phase: string } = { phase: "unchecked" },
) {
  const library = { get: vi.fn().mockResolvedValue(current) };
  const check = vi.fn<SourceChecks["check"]>();
  if (checkResult instanceof Error) check.mockRejectedValue(checkResult);
  else check.mockResolvedValue(checkResult as never);
  const get = vi.fn().mockResolvedValue({ entryId: current.id, ...status });
  const onBitrate = vi.fn();
  const log = vi.fn();
  let clock = 1_000_000;
  const probes = new PlaybackProbes(
    library,
    { check, get } as unknown as SourceChecks,
    { onBitrate, log, now: () => clock, cooldownMs: 60_000 },
  );
  const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
  return {
    probes,
    check,
    get,
    onBitrate,
    log,
    settle,
    advance: (ms: number) => {
      clock += ms;
    },
  };
}

afterEach(() => {
  resetStreamTargets();
});

describe("PlaybackProbes", () => {
  it("probes the played file once and reports its bitrate", async () => {
    const h = harness(entry());
    h.probes.ensure(target);
    expect(h.probes.pending(target)).toBe(true);
    h.probes.ensure(target);
    await h.settle();
    expect(h.check).toHaveBeenCalledTimes(1);
    expect(h.check).toHaveBeenCalledWith("hoshi:series", {
      probe: true,
      fileId: 2,
      mode: "extended",
    });
    expect(h.onBitrate).toHaveBeenCalledWith(target, 4.2);
    expect(h.probes.pending(target)).toBe(false);
    const logged = JSON.parse(h.log.mock.calls[0][0]);
    expect(logged).toMatchObject({
      event: "playback_probe_finished",
      fileId: 2,
      outcome: "observed",
      bitrateMbps: 4.2,
    });
  });

  it("skips files that already carry a media fact", async () => {
    const base = entry();
    const analyzed = entry({
      mediaFacts: [
        {
          revision: entrySourceDefinitionRevision(base),
          jobId: "11111111-1111-4111-8111-111111111111",
          fileId: 2,
          sourceHash: hash,
          filePath: "S01E02.mkv",
          fileLength: 1000,
          technical: { sizeBytes: 1000, bitrateMbps: 3 },
          observedAt: stamp,
        },
      ],
    });
    const h = harness(analyzed);
    h.probes.ensure(target);
    await h.settle();
    expect(h.check).not.toHaveBeenCalled();
    expect(h.onBitrate).toHaveBeenCalledWith(target, 3);
    // A different, unprobed file of the same entry is still probed.
    h.probes.ensure({ ...target, fileId: 1 });
    await h.settle();
    expect(h.check).toHaveBeenCalledWith(
      "hoshi:series",
      expect.objectContaining({ fileId: 1 }),
    );
  });

  it("leaves a check the user started alone and retries later", async () => {
    const h = harness(entry(), completed(4.2), { phase: "probing" });
    h.probes.ensure(target);
    await h.settle();
    expect(h.check).not.toHaveBeenCalled();
    h.get.mockResolvedValue({ entryId: "hoshi:series", phase: "complete" });
    h.probes.ensure(target);
    await h.settle();
    expect(h.check).toHaveBeenCalledTimes(1);
  });

  it("cools down after a failed, inconclusive, or bitrate-less probe", async () => {
    const h = harness(entry(), new Error("check_in_progress"));
    h.probes.ensure(target);
    await h.settle();
    h.probes.ensure(target);
    await h.settle();
    expect(h.check).toHaveBeenCalledTimes(1);
    h.advance(60_000);
    h.check.mockResolvedValue(completed(undefined) as never);
    h.probes.ensure(target);
    await h.settle();
    expect(h.check).toHaveBeenCalledTimes(2);
    expect(h.onBitrate).not.toHaveBeenCalled();
    h.probes.ensure(target);
    await h.settle();
    expect(h.check).toHaveBeenCalledTimes(2);
  });

  it("ignores unknown entries and files without re-reading every tick", async () => {
    const h = harness(entry());
    h.probes.ensure({ ...target, fileId: 9 });
    await h.settle();
    h.probes.ensure({ ...target, fileId: 9 });
    await h.settle();
    expect(h.check).not.toHaveBeenCalled();
    expect(h.get).not.toHaveBeenCalled();
  });
});

describe("PlaybackTelemetry with probes", () => {
  it("asks for a probe only while a target's bitrate is unknown", async () => {
    const ensure = vi.fn();
    const pending = vi.fn().mockReturnValue(true);
    const cacheState = vi.fn().mockResolvedValue({
      hash,
      capacityBytes: 0,
      filledBytes: 0,
      pieceLength: 1,
      piecesCount: 1,
      readers: [],
      pieces: new Map(),
    });
    const telemetry = new PlaybackTelemetry(
      { cacheState, list: async () => [] } as unknown as TorrServerClient,
      { probes: { ensure, pending } },
    );
    const now = 5_000_000;
    markStreamActivity(now, target.entryId);
    noteStreamTarget({ ...target });
    await telemetry.sample(now);
    expect(ensure).toHaveBeenCalledWith(
      expect.objectContaining({ entryId: target.entryId, fileId: 2 }),
    );
    expect(telemetry.report(now)[0]?.probing).toBe(true);

    setStreamTargetBitrate({ entryId: target.entryId, fileId: 1 }, 9);
    expect(activeStreamTargets(now)[0]?.bitrateMbps).toBeUndefined();
    setStreamTargetBitrate(target, 4.2);
    expect(activeStreamTargets(now)[0]?.bitrateMbps).toBe(4.2);
    await telemetry.sample(now + 2000);
    expect(ensure).toHaveBeenCalledTimes(1);
  });
});
