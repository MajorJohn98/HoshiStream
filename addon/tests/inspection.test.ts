import { randomUUID } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  inspectEntry,
  resolveStreamSource,
  sharedInspection,
  warmStreamSource,
} from "../src/inspection.ts";
import { Library } from "../src/library.ts";
import { getMetadata } from "../src/metadata.ts";
import {
  TorrServerError,
  type TorrServerClient,
  type TorrentStatus,
} from "../src/torrserver-client.ts";
import type { LibraryEntry } from "../src/types.ts";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function temporaryLibrary() {
  const directory = resolve(`.test-inspection-data-${randomUUID()}`);
  directories.push(directory);
  await mkdir(directory);
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
        known
          ? Promise.resolve(status)
          : Promise.reject(
              new TorrServerError("Missing torrent", "not_found", 404),
            ),
      ),
  } as unknown as TorrServerClient;
}

describe("inspection cache", () => {
  it("does not overwrite a newer series cache when an old inspection finishes late", async () => {
    const library = await temporaryLibrary();
    const entry = await library.create({
      type: "series",
      name: "Series",
      magnetUri: "magnet:?xt=urn:btih:old",
    });
    const torrServer = fakeTorrServer();
    let finish!: (value: TorrentStatus) => void;
    vi.mocked(torrServer.waitForFiles).mockReturnValue(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    const inspecting = inspectEntry(entry, torrServer, library);
    await vi.waitFor(() => expect(torrServer.waitForFiles).toHaveBeenCalled());
    await library.patch(entry.id, {
      extraSources: [{ magnetUri: "magnet:?xt=urn:btih:new" }],
    });
    const newer = {
      hash: status.hash,
      selectedFiles: [
        {
          id: 100_001,
          hash: "new",
          path: "S02E01.mkv",
          length: 100,
          season: 2,
          episode: 1,
        },
      ],
      inspectedAt: new Date().toISOString(),
    };
    await library.setInspectionCache(entry.id, newer);
    finish(status);
    await inspecting;
    expect((await library.get(entry.id))?.inspectionCache).toEqual(newer);
  });

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

describe("reviewed catalog film selection", () => {
  const hash = "a".repeat(40);
  const files = [
    { id: 1, path: "bundle/sintel-2048-surround.mp4", length: 100 },
    { id: 2, path: "bundle/documentary.avi", length: 500 },
  ];

  async function fixture() {
    const library = await temporaryLibrary();
    const created = await library.create({
      type: "movie",
      name: "Reviewed film",
      magnetUri: `magnet:?xt=urn:btih:${hash}`,
    });
    const entry: LibraryEntry = {
      ...created,
      searchImport: {
        providerId: "curated",
        catalogId: "sintel",
        hash,
        rightsUrl: "https://durian.blender.org/sharing/",
        license: "CC-BY-3.0",
        filmPath: "sintel-2048-surround.mp4",
        filmSizeBytes: 100,
      },
    };
    const torrServer = fakeTorrServer();
    vi.mocked(torrServer.waitForFiles).mockResolvedValue({
      ...status,
      hash,
      file_stats: files,
    });
    return { entry, torrServer };
  }

  it("selects the reviewed film rather than the largest video in the bundle", async () => {
    const { entry, torrServer } = await fixture();
    const inspected = await inspectEntry(entry, torrServer);
    expect(inspected.selectedFiles.map((file) => file.id)).toEqual([1]);
    expect(inspected.files).toHaveLength(2);
  });

  it("maps a catalog film to one episode when the user chooses Series", async () => {
    const { entry, torrServer } = await fixture();
    const inspected = await inspectEntry(
      { ...entry, type: "series" },
      torrServer,
    );
    expect(inspected.selectedFiles).toMatchObject([
      { id: 1, season: 1, episode: 1 },
    ]);
  });

  it("also honors reviewed-file pins on imported extra sources", async () => {
    const { entry, torrServer } = await fixture();
    const inspected = await inspectEntry(
      {
        ...entry,
        type: "series",
        extraSources: [
          {
            magnetUri: `magnet:?xt=urn:btih:${hash}`,
            seasonHint: 2,
            searchImport: entry.searchImport,
          },
        ],
      },
      torrServer,
    );
    expect(inspected.selectedFiles).toMatchObject([
      { id: 1, season: 1, episode: 1 },
      { id: 100_001, season: 2, episode: 1, hash },
    ]);
    expect(
      inspected.selectedFiles.every((file) =>
        file.path.endsWith("sintel-2048-surround.mp4"),
      ),
    ).toBe(true);
  });

  it("honors explicit file selection rather than forcing the catalog default", async () => {
    const { entry, torrServer } = await fixture();
    const inspected = await inspectEntry(
      { ...entry, preferredFileIndex: 2 },
      torrServer,
    );
    expect(inspected.selectedFiles.map((file) => file.id)).toEqual([2]);
  });

  it("fails closed if the expected reviewed file is missing or ambiguous", async () => {
    const { entry, torrServer } = await fixture();
    for (const file_stats of [[files[1]], [files[0], { ...files[0], id: 3 }]]) {
      vi.mocked(torrServer.waitForFiles).mockResolvedValue({
        ...status,
        hash,
        file_stats,
      });
      await expect(inspectEntry(entry, torrServer)).rejects.toThrow(
        "reviewed film file",
      );
    }
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
    await vi.waitFor(async () => {
      expect((await library.get(entry.id))?.inspectionCache).toBeDefined();
    });
  });

  it("keeps the episode list for a series with history", async () => {
    const library = await temporaryLibrary();
    const entry = await library.create({
      type: "series",
      name: "Show",
      magnetUri: "magnet:?xt=urn:btih:show",
    });
    const torrServer = fakeTorrServer();
    vi.mocked(torrServer.waitForFiles).mockResolvedValue({
      ...status,
      file_stats: [
        { id: 1, path: "Show/S01E01.mkv", length: 100 },
        { id: 2, path: "Show/S01E02.mkv", length: 100 },
      ],
    });
    const fresh = await getMetadata(library, torrServer, "series", entry.id);
    expect(fresh.meta).not.toHaveProperty("behaviorHints");
    await library.setWatchState(entry.id, 1, "watched");
    // defaultVideoId on a meta makes Stremio hide the episode list, so the
    // resume hint belongs to the Continue Watching rows only.
    const resumed = await getMetadata(library, torrServer, "series", entry.id);
    expect(resumed.meta).not.toHaveProperty("behaviorHints");
    expect(resumed.meta?.videos).toHaveLength(2);
  });

  it("answers a cached series meta without waiting on TorrServer", async () => {
    const library = await temporaryLibrary();
    const entry = await library.create({
      type: "series",
      name: "Show",
      magnetUri: "magnet:?xt=urn:btih:show",
      extraSources: [{ magnetUri: "magnet:?xt=urn:btih:season2" }],
    });
    await library.setInspectionCache(entry.id, {
      hash: "abc123",
      selectedFiles: [
        { id: 1, path: "S01E01.mkv", length: 100, season: 1, episode: 1 },
        {
          id: 100_001,
          hash: "def456",
          path: "S02E01.mkv",
          length: 100,
          season: 2,
          episode: 1,
        },
      ],
      inspectedAt: new Date().toISOString(),
    });
    // TorrServer lost both torrents and is slow to answer.
    const torrServer = fakeTorrServer(false);
    vi.mocked(torrServer.get).mockReturnValue(new Promise(() => undefined));

    const result = await getMetadata(library, torrServer, "series", entry.id);
    expect(result.meta?.videos.map((video) => video.id)).toEqual([
      `${entry.id}:1:1`,
      `${entry.id}:2:1`,
    ]);
    // Re-registration still happens, in the background.
    await vi.waitFor(() => expect(torrServer.get).toHaveBeenCalled());
    expect(torrServer.waitForFiles).not.toHaveBeenCalled();
  });

  it("shares one inspection between concurrent uncached callers", async () => {
    const library = await temporaryLibrary();
    const entry = await library.create({
      type: "series",
      name: "Show",
      magnetUri: "magnet:?xt=urn:btih:show",
    });
    const torrServer = fakeTorrServer();
    let finish!: (value: TorrentStatus) => void;
    vi.mocked(torrServer.waitForFiles).mockReturnValue(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    const fresh = (await library.get(entry.id)) as LibraryEntry;
    warmStreamSource(fresh, torrServer, library);
    const meta = getMetadata(library, torrServer, "series", entry.id);
    const shared = sharedInspection(fresh, torrServer, library);
    await vi.waitFor(() => expect(torrServer.waitForFiles).toHaveBeenCalled());
    finish({
      ...status,
      file_stats: [{ id: 1, path: "Show/S01E01.mkv", length: 100 }],
    });
    await Promise.all([meta, shared]);
    expect(torrServer.addMagnet).toHaveBeenCalledOnce();
    expect(torrServer.waitForFiles).toHaveBeenCalledOnce();
    expect((await library.get(entry.id))?.inspectionCache).toBeDefined();
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
            : Promise.reject(
                new TorrServerError("Missing torrent", "not_found", 404),
              ),
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
