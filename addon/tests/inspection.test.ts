import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  inspectEntry,
  resolveStreamSource,
  warmStreamSource,
} from "../src/inspection.js";
import { Library } from "../src/library.js";
import { getMetadata } from "../src/metadata.js";
import type { TorrServerClient } from "../src/torrserver-client.js";
import type { LibraryEntry } from "../src/types.js";

async function temporaryLibrary() {
  const directory = await mkdtemp(join(tmpdir(), "hoshistream-"));
  const path = join(directory, "library.json");
  await writeFile(path, "[]\n");
  return new Library(path);
}

const status = {
  title: "Test",
  hash: "abc123",
  stat: 1,
  stat_string: "Torrent working",
  file_stats: [{ id: 1, path: "Movie.mkv", length: 100 }],
};

function fakeTorrServer(known = true) {
  return {
    addMagnet: vi.fn().mockResolvedValue(status),
    waitForFiles: vi.fn().mockResolvedValue(status),
    get: vi
      .fn()
      .mockImplementation(() =>
        known ? Promise.resolve(status) : Promise.reject(new Error("404")),
      ),
  } as unknown as TorrServerClient;
}

describe("inspection cache", () => {
  it("persists the cache after a full inspection", async () => {
    const library = await temporaryLibrary();
    const entry = await library.create({
      type: "movie",
      name: "Cached",
      magnetUri: "magnet:?xt=urn:btih:cached",
    });

    await inspectEntry(entry, fakeTorrServer(), library);

    const stored = await library.get(entry.id);
    expect(stored?.inspectionCache).toMatchObject({
      hash: "abc123",
      selectedFiles: [{ id: 1, path: "Movie.mkv", length: 100 }],
    });
  });

  it("serves streams from the cache without re-registering a known torrent", async () => {
    const library = await temporaryLibrary();
    const created = await library.create({
      type: "movie",
      name: "Cached",
      magnetUri: "magnet:?xt=urn:btih:cached",
    });
    await library.setInspectionCache(created.id, {
      hash: "abc123",
      selectedFiles: [{ id: 1, path: "Movie.mkv", length: 100 }],
      inspectedAt: new Date().toISOString(),
    });
    const torrServer = fakeTorrServer();

    const entry = (await library.get(created.id)) as LibraryEntry;
    const source = await resolveStreamSource(entry, torrServer, library);

    expect(source.hash).toBe("abc123");
    expect(source.selectedFiles).toHaveLength(1);
    expect(torrServer.get).toHaveBeenCalledWith("abc123");
    expect(torrServer.addMagnet).not.toHaveBeenCalled();
    expect(torrServer.waitForFiles).not.toHaveBeenCalled();
  });

  it("re-registers a cached torrent TorrServer no longer knows", async () => {
    const library = await temporaryLibrary();
    const created = await library.create({
      type: "movie",
      name: "Cached",
      magnetUri: "magnet:?xt=urn:btih:cached",
    });
    await library.setInspectionCache(created.id, {
      hash: "abc123",
      selectedFiles: [{ id: 1, path: "Movie.mkv", length: 100 }],
      inspectedAt: new Date().toISOString(),
    });
    const torrServer = fakeTorrServer(false);

    const entry = (await library.get(created.id)) as LibraryEntry;
    const source = await resolveStreamSource(entry, torrServer, library);

    expect(source.hash).toBe("abc123");
    expect(torrServer.addMagnet).toHaveBeenCalledOnce();
    expect(torrServer.waitForFiles).not.toHaveBeenCalled();
  });

  it("invalidates the cache when the source or selection changes", async () => {
    const library = await temporaryLibrary();
    const entry = await library.create({
      type: "movie",
      name: "Cached",
      magnetUri: "magnet:?xt=urn:btih:cached",
    });
    await library.setInspectionCache(entry.id, {
      hash: "abc123",
      selectedFiles: [{ id: 1, path: "Movie.mkv", length: 100 }],
      inspectedAt: new Date().toISOString(),
    });

    const renamed = await library.patch(entry.id, { name: "Still cached" });
    expect(renamed?.inspectionCache).toBeDefined();

    const replaced = await library.patch(entry.id, {
      magnetUri: "magnet:?xt=urn:btih:other",
    });
    expect(replaced?.inspectionCache).toBeUndefined();
  });
});

describe("stream prewarming", () => {
  it("registers a movie torrent when its detail page is opened", async () => {
    const library = await temporaryLibrary();
    const entry = await library.create({
      type: "movie",
      name: "Warm",
      magnetUri: "magnet:?xt=urn:btih:warm",
    });
    const torrServer = fakeTorrServer();

    await getMetadata(library, torrServer, "movie", entry.id);
    await vi.waitFor(() => expect(torrServer.addMagnet).toHaveBeenCalledOnce());
  });

  it("does not touch TorrServer for local entries", async () => {
    const library = await temporaryLibrary();
    const entry = await library.create({
      type: "movie",
      name: "Local",
      localFilePath: "/data/media/Local.mkv",
    });
    const torrServer = fakeTorrServer();

    warmStreamSource(
      (await library.get(entry.id)) as LibraryEntry,
      torrServer,
      library,
    );

    expect(torrServer.addMagnet).not.toHaveBeenCalled();
    expect(torrServer.get).not.toHaveBeenCalled();
  });
});

describe("multi-torrent series", () => {
  const packStatus = {
    title: "Pack",
    hash: "hash-pack",
    stat: 1,
    stat_string: "Torrent working",
    file_stats: [
      { id: 1, path: "Show S01E01.mkv", length: 100 },
      { id: 2, path: "Show S01E02.mkv", length: 100 },
    ],
  };
  const extraStatus = {
    title: "Extra",
    hash: "hash-extra",
    stat: 1,
    stat_string: "Torrent working",
    file_stats: [{ id: 1, path: "Show Episode Special.mkv", length: 100 }],
  };

  function multiSourceTorrServer(knownHashes = new Set<string>()) {
    const byLink = (link: string) =>
      link.includes("extra") ? extraStatus : packStatus;
    return {
      addMagnet: vi
        .fn()
        .mockImplementation((link: string) => Promise.resolve(byLink(link))),
      waitForFiles: vi
        .fn()
        .mockImplementation((hash: string) =>
          Promise.resolve(hash === "hash-extra" ? extraStatus : packStatus),
        ),
      get: vi
        .fn()
        .mockImplementation((hash: string) =>
          knownHashes.has(hash)
            ? Promise.resolve(hash === "hash-extra" ? extraStatus : packStatus)
            : Promise.reject(new Error("404")),
        ),
    } as unknown as TorrServerClient;
  }

  async function multiSourceEntry(library: Library): Promise<LibraryEntry> {
    return library.create({
      type: "series",
      name: "Multi",
      magnetUri: "magnet:?xt=urn:btih:pack",
      extraSources: [{ magnetUri: "magnet:?xt=urn:btih:extra", seasonHint: 2 }],
    });
  }

  it("inspects every source and merges episodes with composite ids", async () => {
    const library = await temporaryLibrary();
    const entry = await multiSourceEntry(library);
    const torrServer = multiSourceTorrServer();

    const inspection = await inspectEntry(entry, torrServer, library);

    expect(inspection.selectedFiles).toEqual([
      { id: 1, path: "Show S01E01.mkv", length: 100, season: 1, episode: 1 },
      { id: 2, path: "Show S01E02.mkv", length: 100, season: 1, episode: 2 },
      {
        id: 100_001,
        path: "Show Episode Special.mkv",
        length: 100,
        season: 2,
        episode: 1,
        hash: "hash-extra",
      },
    ]);
    const stored = await library.get(entry.id);
    expect(stored?.inspectionCache?.hash).toBe("hash-pack");
    expect(stored?.inspectionCache?.selectedFiles).toHaveLength(3);
  });

  it("re-registers only the missing source when serving from cache", async () => {
    const library = await temporaryLibrary();
    const entry = await multiSourceEntry(library);
    const seeded = multiSourceTorrServer();
    await inspectEntry(entry, seeded, library);
    const cached = (await library.get(entry.id))!;

    // Pack still registered, extra dropped.
    const torrServer = multiSourceTorrServer(new Set(["hash-pack"]));
    const resolved = await resolveStreamSource(cached, torrServer, library);

    expect(resolved.selectedFiles).toHaveLength(3);
    const addMagnet = (
      torrServer as unknown as { addMagnet: ReturnType<typeof vi.fn> }
    ).addMagnet;
    expect(addMagnet).toHaveBeenCalledTimes(1);
    expect(addMagnet).toHaveBeenCalledWith(
      "magnet:?xt=urn:btih:extra",
      "Multi",
    );
  });

  it("rejects extraSources on movies and local entries", async () => {
    const library = await temporaryLibrary();
    await expect(
      library.create({
        type: "movie",
        name: "Bad",
        magnetUri: "magnet:?xt=urn:btih:x",
        extraSources: [{ magnetUri: "magnet:?xt=urn:btih:y" }],
      }),
    ).rejects.toThrow();
    await expect(
      library.create({
        type: "series",
        name: "Bad local",
        localFolderPath: "/tmp/media",
        extraSources: [{ magnetUri: "magnet:?xt=urn:btih:y" }],
      }),
    ).rejects.toThrow();
  });
});
