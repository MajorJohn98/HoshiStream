import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Library } from "../src/library.ts";
import { entrySourceDefinitionRevision } from "../src/imports/source-identity.ts";
import { directPlayForFile, mediaFactForFile } from "../src/media-facts.ts";
import { getStreams } from "../src/streams.ts";
import { TorrServerClient } from "../src/torrserver-client.ts";
import type { ProbeSummary, SourceCheck } from "../src/source-check-types.ts";
import type { LibraryEntry } from "../src/types.ts";

const hash = "a".repeat(40);
const file = {
  id: 1,
  path: "Fixture.S01E01.mkv",
  length: 1000,
  season: 1,
  episode: 1,
};
const second = { ...file, id: 2, path: "Fixture.S01E02.mp4", episode: 2 };
const technical: ProbeSummary = {
  sizeBytes: file.length,
  container: "matroska",
  videoCodec: "h264",
  audioCodec: "dts",
  videoProfile: "Main",
  pixelFormat: "yuv420p",
  decodedVideoFrames: 1,
};
let root: string;
let library: Library;
let entry: LibraryEntry;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "hoshi-media-facts-"));
  library = new Library(join(root, "library.json"));
  entry = await library.create({
    name: "Authorized fixtures",
    type: "series",
    magnetUri: `magnet:?xt=urn:btih:${hash}`,
  });
  await library.setInspectionCache(entry.id, {
    hash,
    selectedFiles: [file, second],
    inspectedAt: new Date().toISOString(),
  });
});

afterEach(async () => {
  await rm(root, { recursive: true });
  vi.restoreAllMocks();
});

async function startCheck() {
  const revision = entrySourceDefinitionRevision(entry);
  const check: SourceCheck = {
    revision,
    jobId: randomUUID(),
    phase: "queued",
    probe: true,
    mode: "basic",
    message: "Waiting",
    updatedAt: new Date().toISOString(),
  };
  await library.setSourceCheck(entry.id, check, revision);
  return check;
}

async function observe(overrides: Partial<SourceCheck> = {}) {
  const check = await startCheck();
  await library.setSourceCheck(
    entry.id,
    {
      ...check,
      phase: "complete",
      outcome: "observed",
      fileId: file.id,
      sourceHash: hash,
      filePath: file.path,
      fileLength: file.length,
      technical,
      ...overrides,
    },
    check.revision,
    check.jobId,
  );
}

describe("scoped media facts", () => {
  it("atomically stores observed facts and never applies them to another episode", async () => {
    await observe();
    const saved = await library.get(entry.id);
    expect(saved?.mediaFacts).toHaveLength(1);
    expect(saved && directPlayForFile(saved, file)?.audioCodec).toBe("dts");
    expect(saved && directPlayForFile(saved, second)).toBeUndefined();
    expect(
      saved && mediaFactForFile(saved, { ...file, length: 2000 }),
    ).toBeUndefined();
    expect(
      saved && mediaFactForFile(saved, { ...file, path: "changed.mkv" }),
    ).toBeUndefined();
    expect(
      saved && mediaFactForFile(saved, { ...file, hash: "b".repeat(40) }),
    ).toBeUndefined();
  });

  it("uses the freshly resolved hash before a full inspection cache exists", async () => {
    await observe();
    const saved = await library.get(entry.id);
    if (!saved) throw new Error("Fixture disappeared");
    const uncached = { ...saved, inspectionCache: undefined };
    expect(mediaFactForFile(uncached, file)).toBeUndefined();
    expect(mediaFactForFile(uncached, file, hash)?.technical.audioCodec).toBe(
      "dts",
    );
    expect(mediaFactForFile(uncached, file, "b".repeat(40))).toBeUndefined();
  });

  it("keeps previous codec facts after an inconclusive attempt without a new positive result", async () => {
    await observe();
    const previous = (await library.get(entry.id))?.mediaFacts;
    await observe({
      outcome: "inconclusive",
      code: "probe_timeout",
      technical: { ...technical, decodedVideoFrames: 0 },
    });
    const saved = await library.get(entry.id);
    expect(saved?.sourceCheck?.outcome).toBe("inconclusive");
    expect(saved?.mediaFacts).toEqual(previous);
  });

  it("does not persist a header-only or legacy unscoped result as sampled evidence", async () => {
    await observe({ technical: { ...technical, decodedVideoFrames: 0 } });
    expect((await library.get(entry.id))?.mediaFacts).toBeUndefined();
    await library.setDirectPlay(entry.id, {
      container: "matroska",
      audioCodec: "dts",
      compatibility: "risky",
      warnings: [],
      probedAt: new Date().toISOString(),
    });
    const reopened = await new Library(join(root, "library.json")).get(
      entry.id,
    );
    expect(reopened?.directPlay?.audioCodec).toBe("dts");
    expect(reopened && directPlayForFile(reopened, file)).toBeUndefined();
  });

  it("rejects a late job at the same boundary that stores technical evidence", async () => {
    const old = await startCheck();
    const current = await startCheck();
    await expect(
      library.setSourceCheck(
        entry.id,
        {
          ...old,
          phase: "complete",
          outcome: "observed",
          fileId: 1,
          filePath: file.path,
          fileLength: file.length,
          sourceHash: hash,
          technical,
        },
        old.revision,
        old.jobId,
      ),
    ).resolves.toBe(false);
    expect((await library.get(entry.id))?.sourceCheck?.jobId).toBe(
      current.jobId,
    );
    expect((await library.get(entry.id))?.mediaFacts).toBeUndefined();
  });

  it("invalidates scoped evidence on source edits without deleting legacy entries", async () => {
    await observe();
    await library.patch(entry.id, {
      magnetUri: `magnet:?xt=urn:btih:${"b".repeat(40)}`,
    });
    const saved = await library.get(entry.id);
    expect(saved?.mediaFacts).toBeUndefined();
    expect(saved?.sourceCheck).toBeUndefined();
    expect(saved?.name).toBe(entry.name);
  });

  it("offers existing repair only for the episode whose codecs were observed", async () => {
    await observe();
    const torrServer = new TorrServerClient("http://127.0.0.1:1");
    vi.spyOn(torrServer, "get").mockResolvedValue({
      hash,
      title: "Fixture",
      stat: 3,
      stat_string: "Working",
      file_stats: [file, second],
    });
    const streams = (episode: number) =>
      getStreams(
        library,
        torrServer,
        "http://localhost:8090",
        "http://localhost:7001",
        "fixture-private-access-token",
        "series",
        `${entry.id}:1:${episode}`,
        { remoteClient: false, videoBitrateMbps: 8 },
      );
    const first = await streams(1);
    const next = await streams(2);
    expect(first.streams).toHaveLength(2);
    expect(first.streams[1].description).toContain("AC3");
    expect(next.streams).toHaveLength(1);
    expect(next.streams[0].description).not.toContain("dts");
  });
});
