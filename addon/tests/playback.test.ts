import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { Library } from "../src/library.js";
import { Playback } from "../src/playback.js";
import { clearLocalInspectionCache } from "../src/local-media.js";
import type { TorrServerClient } from "../src/torrserver-client.js";

async function seriesLibrary() {
  const directory = await mkdtemp(join(tmpdir(), "hoshistream-pb-"));
  const media = join(directory, "Show");
  const { mkdir } = await import("node:fs/promises");
  await mkdir(media, { recursive: true });
  for (const name of ["S01E01.mkv", "S01E02.mkv", "S01E03.mkv"])
    await writeFile(join(media, name), "x".repeat(32));
  const library = new Library(join(directory, "library.json"));
  const entry = await library.create({
    type: "series",
    name: "Show",
    localFolderPath: media,
  });
  clearLocalInspectionCache();
  return { library, entry, media };
}

const torrServer = {} as TorrServerClient;

describe("series playback", () => {
  it("queues the following episodes so playback keeps going", async () => {
    const { library, entry } = await seriesLibrary();
    const playback = new Playback(library, torrServer);
    const calls: Array<{ target: string; queue: string[] }> = [];
    // Stand in for a resolved mpv so the queue can be observed.
    (playback as unknown as { player: unknown }).player = {
      running: true,
      play: (target: string, _c: unknown, queue: string[]) => {
        calls.push({ target, queue });
        return Promise.resolve();
      },
      command: () => Promise.resolve(),
    };
    vi.spyOn(
      playback as unknown as { ensurePlayer: () => Promise<unknown> },
      "ensurePlayer",
    ).mockResolvedValue(
      (playback as unknown as { player: unknown }).player as object,
    );

    const result = await playback.play(entry.id);

    expect(result.title).toBe("S01E01.mkv");
    expect(result.queued).toBe(2);
    expect(calls[0].queue).toHaveLength(2);
    expect(calls[0].target).toContain("S01E01.mkv");
  });

  it("starts from the requested episode and queues only what follows", async () => {
    const { library, entry } = await seriesLibrary();
    const playback = new Playback(library, torrServer);
    const calls: Array<{ target: string; queue: string[] }> = [];
    const fake = {
      running: true,
      play: (target: string, _c: unknown, queue: string[]) => {
        calls.push({ target, queue });
        return Promise.resolve();
      },
      command: () => Promise.resolve(),
    };
    vi.spyOn(
      playback as unknown as { ensurePlayer: () => Promise<unknown> },
      "ensurePlayer",
    ).mockResolvedValue(fake);

    const result = await playback.play(entry.id, 1);

    expect(result.title).toBe("S01E02.mkv");
    expect(result.queued).toBe(1);
  });

  it("resumes the last played episode instead of the first", async () => {
    const { library, entry } = await seriesLibrary();
    await library.setPlayback(entry.id, {
      positionSeconds: 300,
      fileId: 2,
      updatedAt: new Date().toISOString(),
    });
    const playback = new Playback(library, torrServer);
    const fake = {
      running: true,
      play: () => Promise.resolve(),
      command: () => Promise.resolve(),
    };
    vi.spyOn(
      playback as unknown as { ensurePlayer: () => Promise<unknown> },
      "ensurePlayer",
    ).mockResolvedValue(fake);

    const result = await playback.play(entry.id);

    expect(result.title).toBe("S01E03.mkv");
    expect(result.resumedAt).toBe(300);
  });

  it("ignores a stored position that belongs to another episode", async () => {
    const { library, entry } = await seriesLibrary();
    await library.setPlayback(entry.id, {
      positionSeconds: 300,
      fileId: 2,
      updatedAt: new Date().toISOString(),
    });
    const playback = new Playback(library, torrServer);
    const fake = {
      running: true,
      play: () => Promise.resolve(),
      command: () => Promise.resolve(),
    };
    vi.spyOn(
      playback as unknown as { ensurePlayer: () => Promise<unknown> },
      "ensurePlayer",
    ).mockResolvedValue(fake);

    const result = await playback.play(entry.id, 0);

    expect(result.title).toBe("S01E01.mkv");
    expect(result.resumedAt).toBeUndefined();
  });
});
