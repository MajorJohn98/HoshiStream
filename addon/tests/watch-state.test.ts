import { mkdir, rm, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Library } from "../src/library.ts";
import type { SelectedFile } from "../src/media-file-selection.ts";
import type { TorrServerClient } from "../src/torrserver-client.ts";
import { libraryEntrySchema } from "../src/types.ts";
import {
  lastWatchActivity,
  OBSERVATION_TTL_MS,
  rangeFraction,
  resumeFile,
  WATCHED_MIN_ELAPSED_MS,
  WatchProgress,
  WatchStates,
  watchStateFor,
} from "../src/watch-state.ts";

const directories: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function temporaryLibrary() {
  const directory = resolve(`.test-watch-state-${randomUUID()}`);
  directories.push(directory);
  await mkdir(directory);
  const path = join(directory, "library.json");
  await writeFile(path, "[]\n");
  return new Library(path);
}

const files: SelectedFile[] = [
  { id: 1, path: "S01E01.mkv", length: 100, season: 1, episode: 1 },
  { id: 2, path: "S01E02.mkv", length: 100, season: 1, episode: 2 },
  { id: 3, path: "S01E03.mkv", length: 100, season: 1, episode: 3 },
  {
    id: 100_001,
    path: "S02E01.mkv",
    length: 100,
    season: 2,
    episode: 1,
    hash: "b".repeat(40),
  },
];

function sink() {
  return {
    started: vi.fn(async () => true),
    watched: vi.fn(async () => true),
  };
}

describe("WatchProgress", () => {
  it("reports started on the first observation and watched only after a late deep read", () => {
    const events = sink();
    const progress = new WatchProgress(events);
    const t0 = 1_000_000;
    // Open-time tail read (MKV cues) must not count as watched.
    progress.observe("hoshi:a", 1, 0.99, t0);
    expect(events.started).toHaveBeenCalledWith("hoshi:a", 1);
    expect(events.watched).not.toHaveBeenCalled();
    progress.observe("hoshi:a", 1, 0.5, t0 + WATCHED_MIN_ELAPSED_MS);
    expect(events.watched).not.toHaveBeenCalled();
    progress.observe("hoshi:a", 1, 0.9, t0 + WATCHED_MIN_ELAPSED_MS);
    expect(events.watched).toHaveBeenCalledTimes(1);
    // Repeated deep reads do not re-fire; started fires once per file.
    progress.observe("hoshi:a", 1, 0.95, t0 + WATCHED_MIN_ELAPSED_MS + 5000);
    expect(events.watched).toHaveBeenCalledTimes(1);
    expect(events.started).toHaveBeenCalledTimes(1);
  });

  it("tracks files independently and forgets idle observations after the TTL", () => {
    const events = sink();
    const progress = new WatchProgress(events);
    const t0 = 5_000_000;
    progress.observe("hoshi:a", 1, 0.1, t0);
    progress.observe("hoshi:a", 2, 0.1, t0);
    expect(events.started).toHaveBeenCalledTimes(2);
    // A replay much later starts the clock again: the first read after the
    // TTL is a fresh "started", and a deep read right then is not watched.
    const later = t0 + OBSERVATION_TTL_MS + 1;
    progress.observe("hoshi:a", 1, 0.95, later);
    expect(events.started).toHaveBeenCalledTimes(3);
    expect(events.watched).not.toHaveBeenCalled();
  });

  it("ignores non-finite fractions and swallows sink failures", () => {
    const events = {
      started: vi.fn(async () => {
        throw new Error("disk");
      }),
      watched: vi.fn(async () => true),
    };
    const progress = new WatchProgress(events);
    progress.observe("hoshi:a", 1, Number.NaN, 1);
    expect(events.started).not.toHaveBeenCalled();
    expect(() => progress.observe("hoshi:a", 1, 0.2, 1)).not.toThrow();
  });
});

describe("rangeFraction", () => {
  it("maps the Range start onto the file and rejects whole-file or odd headers", () => {
    expect(rangeFraction("bytes=50-", 200)).toBe(0.25);
    expect(rangeFraction("bytes=180-199", 200)).toBe(0.9);
    expect(rangeFraction("bytes=500-", 200)).toBe(1);
    expect(rangeFraction(undefined, 200)).toBeUndefined();
    expect(rangeFraction("bytes=-100", 200)).toBeUndefined();
    expect(rangeFraction("items=0-", 200)).toBeUndefined();
    expect(rangeFraction("bytes=0-", 0)).toBeUndefined();
  });
});

describe("resumeFile", () => {
  const at = "2026-09-13T10:00:00.000Z";

  it("is empty without history and when everything is watched", () => {
    expect(resumeFile({}, files)).toBeUndefined();
    expect(resumeFile({ watchStates: [] }, files)).toBeUndefined();
    expect(
      resumeFile(
        {
          watchStates: files.map((f) => ({
            fileId: f.id,
            state: "watched" as const,
            at,
          })),
        },
        files,
      ),
    ).toBeUndefined();
  });

  it("prefers the most recently started file", () => {
    const entry = {
      watchStates: [
        { fileId: 1, state: "watched" as const, at },
        { fileId: 2, state: "started" as const, at: "2026-09-13T11:00:00Z" },
        { fileId: 3, state: "started" as const, at: "2026-09-13T12:00:00Z" },
      ],
    };
    expect(resumeFile(entry, files)?.id).toBe(3);
  });

  it("otherwise picks the next unwatched episode after the last watched one, wrapping to earlier gaps", () => {
    const watched = (fileId: number) => ({
      fileId,
      state: "watched" as const,
      at,
    });
    expect(resumeFile({ watchStates: [watched(1)] }, files)?.id).toBe(2);
    expect(resumeFile({ watchStates: [watched(3)] }, files)?.id).toBe(100_001);
    // Everything after the last watched file is done: fall back to the gap.
    expect(
      resumeFile(
        { watchStates: [watched(1), watched(3), watched(100_001)] },
        files,
      )?.id,
    ).toBe(2);
  });

  it("ignores states whose file is no longer selected", () => {
    const entry = {
      watchStates: [{ fileId: 42, state: "started" as const, at }],
    };
    expect(resumeFile(entry, files)).toBeUndefined();
  });

  it("reports the latest activity timestamp", () => {
    expect(lastWatchActivity({})).toBe(0);
    expect(
      lastWatchActivity({
        watchStates: [
          { fileId: 1, state: "watched", at: "2026-09-13T10:00:00.000Z" },
          { fileId: 2, state: "started", at: "2026-09-13T12:00:00.000Z" },
        ],
      }),
    ).toBe(Date.parse("2026-09-13T12:00:00.000Z"));
  });
});

describe("library watch state", () => {
  it("keeps watched sticky, clears per file, and drops the field when empty", async () => {
    const library = await temporaryLibrary();
    const entry = await library.create({
      type: "series",
      name: "Show",
      magnetUri: "magnet:?xt=urn:btih:show",
    });
    expect(await library.setWatchState(entry.id, 1, "started")).toBe(true);
    expect(await library.setWatchState(entry.id, 1, "started")).toBe(false);
    expect(await library.setWatchState(entry.id, 1, "watched")).toBe(true);
    // A later "started" (e.g. a rewatch) never demotes a watched file.
    expect(await library.setWatchState(entry.id, 1, "started")).toBe(false);
    expect(await library.setWatchState(entry.id, 2, "started")).toBe(true);
    const stored = await library.get(entry.id);
    expect(watchStateFor(stored!, 1)?.state).toBe("watched");
    expect(watchStateFor(stored!, 2)?.state).toBe("started");
    expect(await library.clearWatchState(entry.id, 1)).toBe(true);
    expect(await library.clearWatchState(entry.id, 1)).toBe(false);
    expect(await library.clearWatchState(entry.id, 2)).toBe(true);
    expect((await library.get(entry.id))?.watchStates).toBeUndefined();
    expect(await library.setWatchState("hoshi:missing", 1, "watched")).toBe(
      false,
    );
  });

  it("parses legacy records without the field and rejects client-supplied values", async () => {
    const now = new Date().toISOString();
    const legacy = libraryEntrySchema.parse({
      id: "hoshi:legacy",
      type: "movie",
      name: "Old",
      magnetUri: "magnet:?xt=urn:btih:old",
      createdAt: now,
      updatedAt: now,
    });
    expect(legacy.watchStates).toBeUndefined();
    expect(
      libraryEntrySchema.safeParse({
        ...legacy,
        watchStates: [{ fileId: 1, state: "seen", at: now }],
      }).success,
    ).toBe(false);
  });

  it("forgets watch state when the source changes", async () => {
    const library = await temporaryLibrary();
    const entry = await library.create({
      type: "movie",
      name: "Film",
      magnetUri: "magnet:?xt=urn:btih:one",
    });
    await library.setWatchState(entry.id, 1, "watched");
    await library.patch(entry.id, { name: "Film (renamed)" });
    expect((await library.get(entry.id))?.watchStates).toHaveLength(1);
    await library.patch(entry.id, { magnetUri: "magnet:?xt=urn:btih:two" });
    expect((await library.get(entry.id))?.watchStates).toBeUndefined();
  });
});

describe("WatchStates", () => {
  async function seeded() {
    const library = await temporaryLibrary();
    const entry = await library.create({
      type: "series",
      name: "Show",
      magnetUri: "magnet:?xt=urn:btih:show",
    });
    // The inspection cache is server-owned; write it through update().
    await library.update((entries) => {
      const target = entries.find((item) => item.id === entry.id)!;
      target.inspectionCache = {
        hash: "a".repeat(40),
        inspectedAt: new Date().toISOString(),
        selectedFiles: files,
      };
    });
    const torrServer = {
      setViewed: vi.fn(async () => undefined),
      removeViewed: vi.fn(async () => undefined),
    };
    const log = vi.fn<(line: string) => void>();
    const watch = new WatchStates(
      library,
      torrServer as unknown as TorrServerClient,
      log,
    );
    return { library, entry, torrServer, log, watch };
  }

  it("mirrors watched marks to TorrServer using the owning torrent's hash and raw file id", async () => {
    const { entry, torrServer, watch, library } = await seeded();
    await watch.started(entry.id, 1);
    expect(torrServer.setViewed).not.toHaveBeenCalled();
    await watch.watched(entry.id, 1);
    expect(torrServer.setViewed).toHaveBeenCalledWith("a".repeat(40), 1);
    await watch.watched(entry.id, 100_001);
    expect(torrServer.setViewed).toHaveBeenLastCalledWith("b".repeat(40), 1);
    // Already watched: no library change, no second TorrServer call.
    await watch.watched(entry.id, 1);
    expect(torrServer.setViewed).toHaveBeenCalledTimes(2);
    await watch.clear(entry.id, 1);
    expect(torrServer.removeViewed).toHaveBeenCalledWith("a".repeat(40), 1);
    expect(watchStateFor((await library.get(entry.id))!, 1)).toBeUndefined();
  });

  it("keeps the library authoritative when TorrServer rejects the sync", async () => {
    const { entry, torrServer, watch, log, library } = await seeded();
    torrServer.setViewed.mockRejectedValueOnce(new Error("boom"));
    await expect(watch.watched(entry.id, 2)).resolves.toBe(true);
    expect(watchStateFor((await library.get(entry.id))!, 2)?.state).toBe(
      "watched",
    );
    expect(log).toHaveBeenCalledTimes(1);
    expect(JSON.parse(log.mock.calls[0][0])).toMatchObject({
      level: "warn",
      event: "viewed_sync_failed",
      entryId: entry.id,
      fileId: 2,
      action: "set",
    });
  });

  it("skips the TorrServer sync for files outside the cached selection", async () => {
    const { entry, torrServer, watch } = await seeded();
    await watch.watched(entry.id, 999);
    expect(torrServer.setViewed).not.toHaveBeenCalled();
  });
});
