import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Library } from "../src/library.ts";
import { defaultAnalyzer, LibraryAnalysis } from "../src/library-analysis.ts";
import { SourceChecks } from "../src/source-checks.ts";
import { TorrServerClient } from "../src/torrserver-client.ts";
import { entrySourceDefinitionRevision } from "../src/imports/source-identity.ts";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

async function seededLibrary() {
  const directory = await mkdtemp(
    join(process.cwd(), ".test-hoshistream-analysis-"),
  );
  directories.push(directory);
  const path = join(directory, "library.json");
  await writeFile(path, "[]\n");
  const library = new Library(path);
  const first = await library.create({
    type: "movie",
    name: "One",
    magnetUri: "magnet:?xt=urn:btih:one",
  });
  const second = await library.create({
    type: "movie",
    name: "Two",
    magnetUri: "magnet:?xt=urn:btih:two",
  });
  return { library, first, second };
}

async function settle(analysis: LibraryAnalysis): Promise<void> {
  await vi.waitFor(() => expect(analysis.status().running).toBe(false));
}

describe("LibraryAnalysis", () => {
  it("visits entries sequentially and records failures", async () => {
    const { library } = await seededLibrary();
    const visited: string[] = [];
    let concurrent = 0;
    const analysis = new LibraryAnalysis(library, async (entry) => {
      concurrent += 1;
      expect(concurrent).toBe(1);
      await new Promise((resolve) => setTimeout(resolve, 5));
      concurrent -= 1;
      visited.push(entry.name);
      if (entry.name === "Two") throw new Error("probe failed");
    });

    await expect(analysis.start(false)).resolves.toBe(true);
    // A second start while running is refused.
    await expect(analysis.start(false)).resolves.toBe(false);
    await settle(analysis);

    const status = analysis.status();
    expect(visited).toEqual(["One", "Two"]);
    expect(status).toMatchObject({
      running: false,
      total: 2,
      done: 2,
      cancelled: false,
    });
    expect(status.failed).toEqual([
      expect.objectContaining({ name: "Two", error: "probe failed" }),
    ]);
  });

  it("skips already-analyzed entries unless forced", async () => {
    const { library, first } = await seededLibrary();
    const revision = entrySourceDefinitionRevision(first);
    await library.setSourceCheck(
      first.id,
      {
        jobId: randomUUID(),
        revision,
        phase: "complete",
        outcome: "inconclusive",
        probe: true,
        mode: "basic",
        updatedAt: new Date().toISOString(),
        message: "No sample arrived within this attempt's budget.",
      },
      revision,
    );
    const visited: string[] = [];
    const analysis = new LibraryAnalysis(library, async (entry) => {
      visited.push(entry.name);
    });

    await analysis.start(false);
    await settle(analysis);
    expect(visited).toEqual(["Two"]);

    await analysis.start(true);
    await settle(analysis);
    expect(visited).toEqual(["Two", "One", "Two"]);
  });

  it("does not treat unscoped legacy direct-play metadata as a current check", async () => {
    const { library, first } = await seededLibrary();
    await library.setDirectPlay(first.id, {
      compatibility: "direct",
      warnings: [],
      probedAt: new Date().toISOString(),
    });
    const visited: string[] = [];
    const analysis = new LibraryAnalysis(library, async (entry) => {
      visited.push(entry.name);
    });
    await analysis.start(false);
    await settle(analysis);
    expect(visited).toEqual(["One", "Two"]);
  });

  it("cancel stops the run between entries", async () => {
    const { library } = await seededLibrary();
    const visited: string[] = [];
    const analysis = new LibraryAnalysis(library, async (entry) => {
      visited.push(entry.name);
      if (visited.length === 1) analysis.cancel();
    });

    await analysis.start(false);
    await settle(analysis);

    expect(visited).toEqual(["One"]);
    expect(analysis.status()).toMatchObject({
      running: false,
      cancelled: true,
    });
  });

  it("reserves the slot across concurrent starts and awaits cancellation drain", async () => {
    const { library } = await seededLibrary();
    let finish!: () => void;
    let signal!: AbortSignal;
    const analyze = vi.fn((_entry, activeSignal) => {
      signal = activeSignal;
      return new Promise<void>((resolve) => {
        finish = resolve;
      });
    });
    const analysis = new LibraryAnalysis(library, analyze);
    expect(
      await Promise.all([analysis.start(false), analysis.start(false)]),
    ).toEqual([true, false]);
    await vi.waitFor(() => expect(analyze).toHaveBeenCalledOnce());
    const cancelled = analysis.cancel();
    expect(signal.aborted).toBe(true);
    expect(analysis.status()).toMatchObject({
      running: true,
      cancelled: true,
    });
    expect(await analysis.start(true)).toBe(false);
    finish();
    await cancelled;
    expect(analysis.status()).toMatchObject({
      running: false,
      cancelled: true,
      done: 0,
      failed: [],
    });
    analyze.mockResolvedValue(undefined);
    expect(await analysis.start(true)).toBe(true);
    await settle(analysis);
    expect(analysis.status()).toMatchObject({
      done: 2,
      cancelled: false,
      failed: [],
    });
  });

  it("does not let a cancelled rejection contaminate the next run", async () => {
    const { library } = await seededLibrary();
    let reject!: (reason: Error) => void;
    const analyze = vi.fn(
      () =>
        new Promise<void>((_resolve, fail) => {
          reject = fail;
        }),
    );
    const analysis = new LibraryAnalysis(library, analyze);
    await analysis.start(false);
    await vi.waitFor(() => expect(analyze).toHaveBeenCalledOnce());
    const cancelled = analysis.cancel();
    reject(new Error("Old failure"));
    await cancelled;
    analyze.mockResolvedValue(undefined);
    await analysis.start(true);
    await settle(analysis);
    expect(analysis.status()).toMatchObject({
      done: 2,
      cancelled: false,
      failed: [],
    });
  });

  it("shares the check coordinator and drains a cancelled probe before restarting", async () => {
    const { library, first } = await seededLibrary();
    const file = { id: 1, path: "fixture.mp4", length: 100 };
    const technical = {
      sizeBytes: 100,
      container: "mov",
      videoCodec: "h264",
      videoProfile: "Main",
      pixelFormat: "yuv420p",
      decodedVideoFrames: 1,
    };
    let finish!: () => void;
    const probe = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finish = () => resolve(technical);
          }),
      )
      .mockResolvedValue(technical);
    const checks = new SourceChecks(
      library,
      new TorrServerClient("http://127.0.0.1:1"),
      {
        inspect: vi.fn().mockResolvedValue({
          hash: "a".repeat(40),
          name: "Fixture",
          files: [file],
          selectedFiles: [file],
        }),
        probe,
      },
    );
    const analysis = new LibraryAnalysis(library, defaultAnalyzer(checks));
    try {
      await analysis.start(false);
      await vi.waitFor(() => expect(probe).toHaveBeenCalledOnce());
      const started = await checks.start(first.id);
      expect(started.phase).toBe("probing");
      expect(probe).toHaveBeenCalledOnce();
      const cancelled = analysis.cancel();
      await vi.waitFor(async () =>
        expect((await checks.get(first.id)).phase).toBe("cancelled"),
      );
      expect(await analysis.start(true)).toBe(false);
      finish();
      await cancelled;
      await analysis.start(true);
      await settle(analysis);
      expect(probe).toHaveBeenCalledTimes(3);
      expect(analysis.status()).toMatchObject({
        done: 2,
        failed: [],
        cancelled: false,
      });
    } finally {
      finish?.();
      await checks.close();
      await analysis.cancel();
    }
  });
});
