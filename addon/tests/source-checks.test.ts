import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Library } from "../src/library.ts";
import { SourceChecks, browserSupport } from "../src/source-checks.ts";
import { TorrServerClient, TorrServerError } from "../src/torrserver-client.ts";
import { MediaProbeError } from "../src/media-probe.ts";
import { entrySourceDefinitionRevision } from "../src/imports/source-identity.ts";
import type { LibraryEntry } from "../src/types.ts";

const technical = {
  sizeBytes: 100,
  durationSeconds: 10,
  container: "mov",
  videoCodec: "h264",
  videoProfile: "Main",
  pixelFormat: "yuv420p",
  decodedVideoFrames: 1,
  audioCodec: "aac",
  width: 640,
  height: 360,
};
let root: string;
let library: Library;
let checks: SourceChecks;
let torrServer: TorrServerClient;
let entry: LibraryEntry;
let probe: ReturnType<typeof vi.fn>;

beforeEach(async () => {
  root = await mkdtemp(join(process.cwd(), ".test-hoshi-checks-"));
  library = new Library(join(root, "library.json"));
  entry = await library.create({
    name: "Authorized fixture",
    type: "movie",
    magnetUri: `magnet:?xt=urn:btih:${"a".repeat(40)}`,
  });
  torrServer = new TorrServerClient("http://127.0.0.1:1");
  const status = {
    hash: "a".repeat(40),
    title: "Fixture",
    stat: 1,
    stat_string: "Ready",
    file_stats: [{ id: 1, path: "fixture.mp4", length: 100 }],
  };
  vi.spyOn(torrServer, "addMagnet").mockResolvedValue(status);
  vi.spyOn(torrServer, "waitForFiles").mockResolvedValue(status);
  probe = vi.fn().mockResolvedValue(technical);
  checks = new SourceChecks(library, torrServer, { probe });
});

afterEach(async () => {
  await checks.close();
  await rm(root, { recursive: true });
  vi.restoreAllMocks();
});

async function phase(expected: string, id = entry.id) {
  await vi.waitFor(async () =>
    expect((await checks.get(id)).phase).toBe(expected),
  );
}

describe("persisted source checks", () => {
  it("does not report a storage failure as a source-change cancellation", async () => {
    probe.mockImplementationOnce(async () => {
      vi.spyOn(library, "setSourceCheck").mockRejectedValue(
        new Error("Private disk error"),
      );
      return technical;
    });
    const result = await checks.check(entry.id);
    expect(result.check).toMatchObject({
      phase: "failed",
      outcome: "unavailable",
      code: "check_state_failed",
    });
    expect(result.check.message).not.toContain("Private disk error");
  });
  it("enforces an overall deadline even if an inspection dependency stalls", async () => {
    let finish!: (
      value: Awaited<
        ReturnType<typeof import("../src/inspection.ts").inspectEntry>
      >,
    ) => void;
    const inspect = vi.fn(
      () =>
        new Promise<
          Awaited<
            ReturnType<typeof import("../src/inspection.ts").inspectEntry>
          >
        >((resolve) => {
          finish = resolve;
        }),
    );
    checks = new SourceChecks(library, torrServer, {
      inspect,
      probe,
      timeoutMs: 100,
    });
    await checks.start(entry.id);
    await phase("inspecting");
    await phase("complete");
    expect(await checks.get(entry.id)).toMatchObject({
      outcome: "inconclusive",
      stage: "metadata",
      code: expect.stringMatching(/check_timeout|metadata_timeout/),
    });
    expect(probe).not.toHaveBeenCalled();
    const second = await checks.start(entry.id);
    expect(second.phase).toBe("queued");
    expect(inspect).toHaveBeenCalledTimes(1);
    await phase("complete");
    expect(inspect).toHaveBeenCalledTimes(1);
    finish({ hash: "", name: "", files: [], selectedFiles: [] });
  });

  it("separates saved, inspecting and bounded probe completion", async () => {
    expect((await checks.get(entry.id)).phase).toBe("unchecked");
    const started = await checks.start(entry.id);
    expect(started.phase).toBe("queued");
    await phase("complete");
    const saved = await library.get(entry.id);
    expect(saved?.sourceCheck).toMatchObject({
      phase: "complete",
      mode: "basic",
      outcome: "observed",
      stage: "sample",
      filePath: "fixture.mp4",
      fileLength: 100,
      sourceHash: "a".repeat(40),
      checkedFiles: 1,
      totalFiles: 1,
      browserSupport: "likely",
      technical: { videoCodec: "h264" },
    });
    expect(saved?.directPlay?.videoCodec).toBe("h264");
    expect(saved?.mediaFacts?.[0]).toMatchObject({
      fileId: 1,
      technical: { decodedVideoFrames: 1 },
    });
    expect(probe.mock.calls[0][2]).toMatchObject({
      bounded: true,
      timeoutMs: 20_000,
    });
    const reopened = new Library(join(root, "library.json"));
    expect((await reopened.get(entry.id))?.sourceCheck?.phase).toBe("complete");
  });

  it("supports metadata-only checks without claiming playback was checked", async () => {
    await checks.start(entry.id, { probe: false });
    await phase("complete");
    expect(probe).not.toHaveBeenCalled();
    expect((await checks.get(entry.id)).message).toContain(
      "has not been checked",
    );
  });

  it("keeps the saved entry after metadata or sample failures", async () => {
    vi.mocked(torrServer.waitForFiles).mockRejectedValue(
      new TorrServerError("timeout", "metadata_timeout"),
    );
    await checks.start(entry.id);
    await phase("complete");
    expect((await library.get(entry.id))?.name).toBe(entry.name);
    expect((await checks.get(entry.id)).message).toContain("swarm");
    expect(await checks.get(entry.id)).toMatchObject({
      outcome: "inconclusive",
      code: "metadata_timeout",
    });
    expect(probe).not.toHaveBeenCalled();
  });

  it("does not label an unsupported browser format universally ready", async () => {
    probe.mockResolvedValue({
      ...technical,
      container: "avi",
      videoCodec: "hevc",
      audioCodec: "dts",
    });
    await checks.start(entry.id);
    await phase("complete");
    expect(await checks.get(entry.id)).toMatchObject({
      browserSupport: "limited",
    });
    expect((await checks.get(entry.id)).message).toContain("native player");
    expect(browserSupport({ sizeBytes: 1 })).toBe("unknown");
  });

  it("coalesces concurrent starts and allows cancellation without deleting media", async () => {
    probe.mockImplementation(
      (_input, _file, options) =>
        new Promise((_resolve, reject) => {
          options.signal.addEventListener(
            "abort",
            () => reject(new MediaProbeError("cancelled", "cancelled")),
            { once: true },
          );
        }),
    );
    const [a, b] = await Promise.all([
      checks.start(entry.id),
      checks.start(entry.id),
    ]);
    expect(a.jobId).toBe(b.jobId);
    await phase("probing");
    await expect(
      checks.start(entry.id, { probe: false }),
    ).rejects.toMatchObject({ code: "check_in_progress" });
    await expect(
      checks.start(entry.id, { mode: "extended" }),
    ).rejects.toMatchObject({ code: "check_in_progress" });
    await checks.cancel(entry.id);
    await phase("cancelled");
    expect(await library.list()).toHaveLength(1);
    expect(probe).toHaveBeenCalledTimes(1);
  });

  it("shuts down cleanly when a queued source was edited", async () => {
    probe.mockImplementation(
      (_input, _file, options) =>
        new Promise((_resolve, reject) => {
          options.signal.addEventListener(
            "abort",
            () => reject(new Error("cancelled")),
            { once: true },
          );
        }),
    );
    await checks.start(entry.id);
    await phase("probing");
    const queued = await library.create({
      name: "Queued",
      type: "movie",
      magnetUri: "magnet:?xt=urn:btih:" + "b".repeat(40),
    });
    await checks.start(queued.id);
    await library.patch(queued.id, {
      magnetUri: "magnet:?xt=urn:btih:" + "c".repeat(40),
    });
    await expect(checks.close()).resolves.toBeUndefined();
    expect((await checks.get(entry.id)).phase).toBe("interrupted");
    expect((await checks.get(queued.id)).phase).toBe("unchecked");
  });

  it("discards late results after source edits", async () => {
    let finish!: () => void;
    probe.mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = () => resolve(technical);
        }),
    );
    await checks.start(entry.id);
    await phase("probing");
    await library.patch(entry.id, {
      magnetUri: `magnet:?xt=urn:btih:${"b".repeat(40)}`,
    });
    finish();
    await vi.waitFor(async () => {
      expect((await checks.get(entry.id)).phase).toBe("unchecked");
      expect((await library.get(entry.id))?.directPlay).toBeUndefined();
    });
  });

  it("marks interrupted checks on restart without contacting peers", async () => {
    const revision = entrySourceDefinitionRevision(entry);
    await library.setSourceCheck(
      entry.id,
      {
        jobId: randomUUID(),
        revision,
        phase: "probing",
        probe: true,
        message: "In progress",
        updatedAt: new Date().toISOString(),
      },
      revision,
    );
    await checks.initialize();
    expect((await checks.get(entry.id)).phase).toBe("interrupted");
    expect(torrServer.addMagnet).not.toHaveBeenCalled();
    expect(probe).not.toHaveBeenCalled();
  });

  it("preserves check validity across metadata edits, not source changes", async () => {
    await checks.start(entry.id);
    await phase("complete");
    await library.patch(entry.id, { name: "Renamed" });
    expect((await checks.get(entry.id)).phase).toBe("complete");
    await library.patch(entry.id, { preferredFileIndex: 2 });
    expect((await checks.get(entry.id)).phase).toBe("unchecked");
  });

  it("checks only the requested selected episode", async () => {
    entry = (await library.patch(entry.id, { type: "series" })) ?? entry;
    vi.mocked(torrServer.waitForFiles).mockResolvedValue({
      hash: "a".repeat(40),
      title: "Series",
      stat: 1,
      stat_string: "Ready",
      file_stats: [
        { id: 1, path: "Show S01E01.mp4", length: 100 },
        { id: 2, path: "Show S01E02.mp4", length: 100 },
      ],
    });
    await checks.start(entry.id, { fileId: 2 });
    await phase("complete");
    expect(probe.mock.calls[0][0]).toContain("/2");
    expect(await checks.get(entry.id)).toMatchObject({
      checkedFiles: 1,
      totalFiles: 2,
      fileId: 2,
    });
  });

  it.each([
    [{ ...technical, decodedVideoFrames: 0 }, "sample_unreadable"],
    [{ sizeBytes: 100 }, "no_video"],
  ])(
    "does not certify metadata without sampled video frames",
    async (result, code) => {
      probe.mockResolvedValue(result);
      const { check } = await checks.check(entry.id);
      expect(check).toMatchObject({
        phase: "complete",
        outcome: "inconclusive",
        code,
        checkedFiles: 0,
      });
      expect((await library.get(entry.id))?.mediaFacts).toBeUndefined();
      expect((await library.get(entry.id))?.directPlay).toBeUndefined();
    },
  );

  it.each([
    ["probe_unavailable", "failed", "unavailable"],
    ["probe_timeout", "complete", "inconclusive"],
    ["sample_unreadable", "complete", "inconclusive"],
    ["no_video", "complete", "inconclusive"],
    ["probe_failed", "complete", "inconclusive"],
    ["probe_response", "failed", "unavailable"],
  ])(
    "classifies %s without claiming a successful sample",
    async (code, phase, outcome) => {
      probe.mockRejectedValue(
        new MediaProbeError("Fixture failure", code, {
          ...technical,
          decodedVideoFrames: 0,
        }),
      );
      const { check } = await checks.check(entry.id);
      expect(check).toMatchObject({
        phase,
        outcome,
        code,
        stage: "sample",
        checkedFiles: 0,
      });
      expect(check.technical?.videoCodec).toBe("h264");
    },
  );

  it("classifies a missing source and offline engine distinctly", async () => {
    vi.mocked(torrServer.addMagnet).mockRejectedValue(
      new TorrServerError("Offline", "network"),
    );
    expect((await checks.check(entry.id)).check).toMatchObject({
      phase: "failed",
      outcome: "unavailable",
      code: "network",
    });
    vi.mocked(torrServer.addMagnet).mockRejectedValue(
      Object.assign(new Error("Missing"), { code: "ENOENT" }),
    );
    expect((await checks.check(entry.id)).check).toMatchObject({
      phase: "failed",
      outcome: "unavailable",
      code: "source_missing",
    });
  });

  it("retains observed facts but makes a transient recheck inconclusive", async () => {
    await checks.check(entry.id);
    const previous = (await library.get(entry.id))?.mediaFacts;
    probe.mockRejectedValue(new MediaProbeError("Timeout", "probe_timeout"));
    const { check } = await checks.check(entry.id);
    expect(check).toMatchObject({
      phase: "complete",
      outcome: "inconclusive",
      checkedFiles: 0,
    });
    expect((await library.get(entry.id))?.mediaFacts).toEqual(previous);
  });

  it("uses the explicit extended budget without automatic escalation", async () => {
    probe.mockRejectedValueOnce(
      new MediaProbeError("Basic timeout", "probe_timeout"),
    );
    expect((await checks.check(entry.id)).check.outcome).toBe("inconclusive");
    expect(probe).toHaveBeenCalledTimes(1);
    expect(probe.mock.calls[0][2].timeoutMs).toBe(20_000);
    const result = await checks.check(entry.id, { mode: "extended" });
    expect(result.check).toMatchObject({
      mode: "extended",
      outcome: "observed",
    });
    expect(probe.mock.calls[1][2].timeoutMs).toBe(120_000);
    expect(vi.mocked(torrServer.waitForFiles).mock.calls[1][1]).toBe(60_000);
  });

  it.each([
    ["metadata", 45_000, 30_001, "metadata_timeout"],
    ["sample", 25_000, 20_001, "probe_timeout"],
  ] as const)(
    "lets an explicit extended retry observe delayed %s",
    async (stage, delayMs, basicLimit, code) => {
      vi.useFakeTimers();
      const file = { id: 1, path: "fixture.mp4", length: 100 };
      const inspected = {
        hash: "a".repeat(40),
        name: "Fixture",
        files: [file],
        selectedFiles: [file],
      };
      const delayed = <T>(value: T, signal: AbortSignal, timeoutMs: number) =>
        new Promise<T>((resolve, reject) => {
          const abort = () => {
            clearTimeout(timer);
            reject(signal.reason);
          };
          const timer = setTimeout(
            () => {
              signal.removeEventListener("abort", abort);
              if (delayMs <= timeoutMs) resolve(value);
              else
                reject(
                  stage === "metadata"
                    ? new TorrServerError(
                        "Metadata timeout",
                        "metadata_timeout",
                      )
                    : new MediaProbeError("Sample timeout", "probe_timeout"),
                );
            },
            Math.min(delayMs, timeoutMs),
          );
          signal.addEventListener("abort", abort, { once: true });
        });
      const inspect = vi.fn((_entry, _torrServer, _library, options) =>
        stage === "metadata"
          ? delayed(inspected, options.signal, options.timeoutMs)
          : Promise.resolve(inspected),
      );
      probe.mockImplementation((_input, _file, options) =>
        stage === "sample"
          ? delayed(technical, options.signal, options.timeoutMs)
          : Promise.resolve(technical),
      );
      checks = new SourceChecks(library, torrServer, { inspect, probe });
      try {
        const basic = checks.check(entry.id);
        await vi.waitFor(() =>
          expect(stage === "metadata" ? inspect : probe).toHaveBeenCalledOnce(),
        );
        await vi.advanceTimersByTimeAsync(basicLimit);
        expect((await basic).check).toMatchObject({
          mode: "basic",
          outcome: "inconclusive",
          stage,
          code,
        });
        const extended = checks.check(entry.id, { mode: "extended" });
        await vi.waitFor(() =>
          expect(stage === "metadata" ? inspect : probe).toHaveBeenCalledTimes(
            2,
          ),
        );
        await vi.advanceTimersByTimeAsync(delayMs);
        expect((await extended).check).toMatchObject({
          mode: "extended",
          outcome: "observed",
          checkedFiles: 1,
        });
      } finally {
        await checks.close();
        vi.useRealTimers();
      }
    },
  );

  it("caps the sample process by the remaining shared total budget", async () => {
    const inspect = vi.fn(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
      const file = { id: 1, path: "fixture.mp4", length: 100 };
      return {
        hash: "a".repeat(40),
        name: "Fixture",
        files: [file],
        selectedFiles: [file],
      };
    });
    checks = new SourceChecks(library, torrServer, {
      inspect,
      probe,
      timeoutMs: 500,
      probeTimeoutMs: 1_000,
    });
    expect(
      (await checks.check(entry.id, { mode: "extended" })).check.outcome,
    ).toBe("observed");
    expect(probe.mock.calls[0][2].timeoutMs).toBeLessThan(475);
    expect(probe.mock.calls[0][2].timeoutMs).toBeGreaterThan(0);
  });

  it("drains an abort-ignoring probe before a cancelled job's replacement starts", async () => {
    let finish!: () => void;
    probe.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = () => resolve(technical);
        }),
    );
    await checks.start(entry.id);
    await phase("probing");
    const oldId = ((await checks.get(entry.id)) as { jobId: string }).jobId;
    await checks.cancel(entry.id);
    const next = await checks.start(entry.id);
    expect(next.jobId).not.toBe(oldId);
    expect(next.phase).toBe("queued");
    expect(probe).toHaveBeenCalledTimes(1);
    expect((await library.get(entry.id))?.mediaFacts).toBeUndefined();
    finish();
    await phase("complete");
    expect(probe).toHaveBeenCalledTimes(2);
    expect((await library.get(entry.id))?.mediaFacts?.[0].jobId).toBe(
      next.jobId,
    );
  });

  it("holds the queue after a sample timeout until the actual probe settles", async () => {
    let finish!: () => void;
    let settled = false;
    probe
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finish = () => {
              settled = true;
              resolve(technical);
            };
          }),
      )
      .mockImplementation(() => {
        expect(settled).toBe(true);
        return Promise.resolve(technical);
      });
    checks = new SourceChecks(library, torrServer, {
      probe,
      probeTimeoutMs: 50,
    });
    expect((await checks.check(entry.id)).check).toMatchObject({
      outcome: "inconclusive",
      code: "probe_timeout",
    });
    const second = checks.check(entry.id);
    await phase("queued");
    expect(probe).toHaveBeenCalledTimes(1);
    finish();
    expect((await second).check.outcome).toBe("observed");
  });

  it("rejects an older job's persistence after a newer job replaces it", async () => {
    let finish!: () => void;
    probe.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = () => resolve(technical);
        }),
    );
    const old = checks.check(entry.id);
    await phase("probing");
    const revision = entrySourceDefinitionRevision(entry);
    const jobId = randomUUID();
    await library.setSourceCheck(
      entry.id,
      {
        jobId,
        revision,
        probe: true,
        mode: "basic",
        phase: "queued",
        message: "Newer job",
        updatedAt: new Date().toISOString(),
      },
      revision,
    );
    expect(await checks.get(entry.id)).toMatchObject({ jobId });
    finish();
    expect((await old).check).toMatchObject({
      phase: "cancelled",
      code: "source_changed",
    });
    const saved = await library.get(entry.id);
    expect(saved?.sourceCheck?.jobId).toBe(jobId);
    expect(saved?.mediaFacts).toBeUndefined();
    expect(saved?.directPlay).toBeUndefined();
  });

  it("drains a superseded source revision before checking its replacement", async () => {
    let finish!: () => void;
    probe.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = () => resolve({ ...technical, videoCodec: "hevc" });
        }),
    );
    const old = checks.check(entry.id);
    await phase("probing");
    await library.patch(entry.id, {
      magnetUri: `magnet:?xt=urn:btih:${"b".repeat(40)}`,
    });
    const replacement = checks.check(entry.id);
    await phase("queued");
    expect(probe).toHaveBeenCalledOnce();
    finish();
    expect((await old).check.code).toBe("source_changed");
    const { check } = await replacement;
    expect(check).toMatchObject({
      outcome: "observed",
      technical: { videoCodec: "h264" },
    });
    const saved = await library.get(entry.id);
    expect(saved?.mediaFacts).toHaveLength(1);
    expect(saved?.mediaFacts?.[0]).toMatchObject({
      revision: check.revision,
      jobId: check.jobId,
      technical: { videoCodec: "h264" },
    });
  });
});
