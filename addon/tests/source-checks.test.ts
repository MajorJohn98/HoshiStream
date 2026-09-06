import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
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
  root = await mkdtemp(join(tmpdir(), "hoshi-checks-"));
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
  it("enforces an overall deadline even if an inspection dependency stalls", async () => {
    checks = new SourceChecks(library, torrServer, {
      inspect: vi.fn(() => new Promise(() => {})),
      probe,
      timeoutMs: 20,
    });
    await checks.start(entry.id);
    await phase("failed");
    expect(await checks.get(entry.id)).toMatchObject({ code: "check_timeout" });
    expect(probe).not.toHaveBeenCalled();
  });

  it("separates saved, inspecting and bounded probe completion", async () => {
    expect((await checks.get(entry.id)).phase).toBe("unchecked");
    const started = await checks.start(entry.id);
    expect(started.phase).toBe("queued");
    await phase("complete");
    const saved = await library.get(entry.id);
    expect(saved?.sourceCheck).toMatchObject({
      phase: "complete",
      checkedFiles: 1,
      totalFiles: 1,
      browserSupport: "likely",
      technical: { videoCodec: "h264" },
    });
    expect(saved?.directPlay?.videoCodec).toBe("h264");
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
    await phase("failed");
    expect((await library.get(entry.id))?.name).toBe(entry.name);
    expect((await checks.get(entry.id)).message).toContain("swarm");
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
});
