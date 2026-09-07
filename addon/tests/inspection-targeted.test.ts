import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { inspectEntry } from "../src/inspection.ts";
import { Library } from "../src/library.ts";
import { SourceChecks } from "../src/source-checks.ts";
import { TorrServerClient } from "../src/torrserver-client.ts";

const directories: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    directories
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

async function fixture(cached = true) {
  const directory = await mkdtemp(
    join(process.cwd(), ".test-targeted-inspection-"),
  );
  directories.push(directory);
  const library = new Library(join(directory, "library.json"));
  const entry = await library.create({
    name: "Authorized series",
    type: "series",
    magnetUri: `magnet:?xt=urn:btih:${"a".repeat(40)}`,
    extraSources: [
      { magnetUri: `magnet:?xt=urn:btih:${"b".repeat(40)}`, seasonHint: 2 },
    ],
  });
  const cache = {
    hash: "a".repeat(40),
    inspectedAt: new Date().toISOString(),
    selectedFiles: [
      { id: 1, path: "S01E01.mp4", length: 100, season: 1, episode: 1 },
      {
        id: 100_001,
        path: "S02E01.mp4",
        length: 200,
        season: 2,
        episode: 1,
        hash: "b".repeat(40),
      },
    ],
  };
  if (cached) await library.setInspectionCache(entry.id, cache);
  const torrServer = new TorrServerClient("http://127.0.0.1:1");
  const status = {
    title: "Second source",
    hash: "b".repeat(40),
    stat: 1,
    stat_string: "Ready",
    file_stats: [{ id: 1, path: "S02E01.mp4", length: 200 }],
  };
  vi.spyOn(torrServer, "addMagnet").mockImplementation(async (magnet) => {
    if (magnet !== entry.extraSources![0].magnetUri)
      throw new Error("Unrelated source is offline");
    return status;
  });
  vi.spyOn(torrServer, "waitForFiles").mockResolvedValue(status);
  return {
    library,
    entry: (await library.get(entry.id))!,
    torrServer,
    cache,
    status,
  };
}

describe("file-targeted source inspection", () => {
  it("inspects only the requested source and never replaces the full cache", async () => {
    const { library, entry, torrServer, cache } = await fixture();
    const inspection = await inspectEntry(entry, torrServer, library, {
      fileId: 100_001,
    });
    expect(torrServer.addMagnet).toHaveBeenCalledOnce();
    expect(inspection.hash).toBe("b".repeat(40));
    expect(inspection.files).toEqual([
      { id: 100_001, path: "S02E01.mp4", length: 200 },
    ]);
    expect(inspection.selectedFiles).toMatchObject([
      { id: 100_001, season: 2, episode: 1 },
    ]);
    expect(inspection).toMatchObject({ partial: true, totalSelectedFiles: 2 });
    expect((await library.get(entry.id))?.inspectionCache).toEqual(cache);
  });

  it("keeps full inspection behavior when no file was requested", async () => {
    const { library, entry, torrServer } = await fixture();
    await expect(inspectEntry(entry, torrServer, library)).rejects.toThrow(
      "Unrelated source is offline",
    );
  });

  it("does not claim full selection coverage without a full cache", async () => {
    const { library, entry, torrServer } = await fixture(false);
    const inspection = await inspectEntry(entry, torrServer, library, {
      fileId: 100_001,
    });
    expect(inspection).toMatchObject({
      partial: true,
      totalSelectedFiles: undefined,
    });
    expect((await library.get(entry.id))?.inspectionCache).toBeUndefined();
  });

  it("rejects a requested file excluded by the selected source", async () => {
    const { entry, torrServer } = await fixture(false);
    entry.extraSources![0].fileOverrides = [{ id: 1, included: false }];
    await expect(
      inspectEntry(entry, torrServer, undefined, { fileId: 100_001 }),
    ).rejects.toThrow("no playable video");
  });

  it("rejects an episode superseded by a known later source without contacting it", async () => {
    const { entry, torrServer, status } = await fixture();
    entry.inspectionCache!.selectedFiles = [
      {
        id: 100_001,
        path: "S01E01.mp4",
        length: 200,
        season: 1,
        episode: 1,
        hash: status.hash,
      },
    ];
    await expect(
      inspectEntry(entry, torrServer, undefined, { fileId: 1 }),
    ).rejects.toThrow("no longer selected");
    expect(torrServer.addMagnet).not.toHaveBeenCalled();
  });

  it("honors explicit later-source episode overrides without querying unrelated torrents", async () => {
    const { entry, torrServer, status } = await fixture(false);
    entry.extraSources![0].fileOverrides = [
      { id: 1, included: true, season: 1, episode: 1 },
    ];
    vi.mocked(torrServer.addMagnet).mockResolvedValue({
      ...status,
      hash: "a".repeat(40),
    });
    vi.mocked(torrServer.waitForFiles).mockResolvedValue({
      ...status,
      hash: "a".repeat(40),
      file_stats: [{ id: 1, path: "S01E01.mp4", length: 100 }],
    });
    await expect(
      inspectEntry(entry, torrServer, undefined, { fileId: 1 }),
    ).rejects.toThrow("later source");
    expect(torrServer.addMagnet).toHaveBeenCalledOnce();
    expect(torrServer.addMagnet).toHaveBeenCalledWith(
      entry.magnetUri,
      entry.name,
    );
  });

  it("records only the targeted source's sampled identity and preserves episode coverage", async () => {
    const { library, entry, torrServer, cache } = await fixture();
    const probe = vi.fn().mockResolvedValue({
      sizeBytes: 200,
      container: "matroska",
      videoCodec: "hevc",
      decodedVideoFrames: 1,
    });
    const checks = new SourceChecks(library, torrServer, { probe });
    try {
      const { check } = await checks.check(entry.id, { fileId: 100_001 });
      expect(check).toMatchObject({
        outcome: "observed",
        checkedFiles: 1,
        totalFiles: 2,
        fileId: 100_001,
        sourceHash: "b".repeat(40),
        filePath: "S02E01.mp4",
        fileLength: 200,
      });
      expect(probe.mock.calls[0][0]).toContain(`/${"b".repeat(40)}/1`);
      expect((await library.get(entry.id))?.mediaFacts).toMatchObject([
        { fileId: 100_001, technical: { videoCodec: "hevc" } },
      ]);
      expect((await library.get(entry.id))?.inspectionCache).toEqual(cache);
    } finally {
      await checks.close();
    }
  });
});
