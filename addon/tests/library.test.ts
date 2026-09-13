import {
  mkdir,
  readFile,
  readdir,
  rm,
  utimes,
  writeFile,
} from "node:fs/promises";
import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { join, resolve } from "node:path";
import { Readable } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Library, LibraryError } from "../src/library.ts";
import * as localMedia from "../src/local-media.ts";
import {
  handleLibraryCollection,
  handleLibraryItem,
} from "../src/routes/library-api.ts";
import type { HandlerContext } from "../src/routes/context.ts";
import type { TorrServerClient } from "../src/torrserver-client.ts";
import {
  createEntrySchema,
  libraryEntrySchema,
  patchEntrySchema,
  searchImportSchema,
  type SeriesSource,
} from "../src/types.ts";

const directories: string[] = [];
async function testDirectory() {
  const directory = resolve(`.test-library-data-${randomUUID()}`);
  directories.push(directory);
  await mkdir(directory);
  return directory;
}
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function temporaryLibrary() {
  const directory = await testDirectory();
  const path = join(directory, "library.json");
  await writeFile(path, "[]\n");
  return { directory, path, library: new Library(path) };
}

describe("Library", () => {
  it("requires a magnet URI or mounted torrent path", () => {
    expect(
      createEntrySchema.safeParse({ type: "movie", name: "Missing source" })
        .success,
    ).toBe(false);
  });

  it("serializes concurrent atomic updates", async () => {
    const { directory, path, library } = await temporaryLibrary();
    await Promise.all([
      library.create({
        type: "movie",
        name: "One",
        magnetUri: "magnet:?xt=urn:btih:one",
      }),
      library.create({
        type: "series",
        name: "Two",
        magnetUri: "magnet:?xt=urn:btih:two",
      }),
    ]);

    expect(await library.list()).toHaveLength(2);
    expect(JSON.parse(await readFile(path, "utf8"))).toHaveLength(2);
    expect(
      (await readdir(directory)).filter((name) => name.endsWith(".tmp")),
    ).toEqual([]);
  });

  it("edits metadata and clears optional artwork", async () => {
    const { library } = await temporaryLibrary();
    const entry = await library.create({
      type: "movie",
      name: "Before",
      poster: "https://example.com/poster.jpg",
      magnetUri: "magnet:?xt=urn:btih:edit",
    });
    const updated = await library.patch(entry.id, {
      name: "After",
      poster: null,
    });
    expect(updated).toMatchObject({ name: "After" });
    expect(updated?.poster).toBeUndefined();
  });

  it("replaces a magnet URI", async () => {
    const { library } = await temporaryLibrary();
    const entry = await library.create({
      type: "movie",
      name: "Replace source",
      magnetUri: "magnet:?xt=urn:btih:before",
    });

    const updated = await library.patch(entry.id, {
      magnetUri: "magnet:?xt=urn:btih:after",
    });

    expect(updated?.magnetUri).toBe("magnet:?xt=urn:btih:after");
  });

  it("reports corrupt JSON when no backup exists", async () => {
    const { path, library } = await temporaryLibrary();
    await writeFile(path, "{");
    await expect(library.list()).rejects.toBeInstanceOf(LibraryError);
  });

  it("writes a backup and recovers from it after corruption", async () => {
    const { directory, path, library } = await temporaryLibrary();
    const entry = await library.create({
      type: "movie",
      name: "Survivor",
      magnetUri: "magnet:?xt=urn:btih:survive",
    });
    expect(JSON.parse(await readFile(`${path}.bak`, "utf8"))).toHaveLength(1);

    await writeFile(path, "not json");
    const entries = await new Library(path).list();
    expect(entries).toHaveLength(1);
    expect(entries[0].id).toBe(entry.id);
    expect(JSON.parse(await readFile(path, "utf8"))).toHaveLength(1);
    expect(
      (await readdir(directory)).some((name) => name.includes(".corrupt-")),
    ).toBe(true);
  });

  it("starts empty when neither library nor backup exists", async () => {
    const directory = await testDirectory();
    const library = new Library(join(directory, "library.json"));
    expect(await library.list()).toEqual([]);
  });

  it("serves repeat reads from cache without re-parsing the file", async () => {
    const { path, library } = await temporaryLibrary();
    await library.create({
      type: "movie",
      name: "Cached",
      magnetUri: "magnet:?xt=urn:btih:cached",
    });

    // Pin the timestamp to a whole millisecond so it round-trips through
    // utimes exactly; sub-millisecond precision does not survive.
    const pinned = new Date(Math.floor(Date.now() / 1000) * 1000);
    await utimes(path, pinned, pinned);
    expect((await library.list())[0].name).toBe("Cached");

    // Rewrite with different content of identical size and restore the
    // timestamp. A cache miss would surface the new name.
    const original = await readFile(path, "utf8");
    const tampered = original.replace('"Cached"', '"Xached"');
    expect(Buffer.byteLength(tampered)).toBe(Buffer.byteLength(original));
    await writeFile(path, tampered);
    await utimes(path, pinned, pinned);

    expect((await library.list())[0].name).toBe("Cached");
  });

  it("re-reads after the file changes underneath it", async () => {
    const { path, library } = await temporaryLibrary();
    await library.create({
      type: "movie",
      name: "First",
      magnetUri: "magnet:?xt=urn:btih:first",
    });
    expect(await library.list()).toHaveLength(1);

    const other = new Library(path);
    await other.create({
      type: "movie",
      name: "Second",
      magnetUri: "magnet:?xt=urn:btih:second",
    });

    expect(await library.list()).toHaveLength(2);
  });

  it("does not let callers mutate cached entries", async () => {
    const { library } = await temporaryLibrary();
    await library.create({
      type: "movie",
      name: "Original",
      magnetUri: "magnet:?xt=urn:btih:original",
    });

    const entries = await library.list();
    entries[0].name = "Tampered";
    const single = await library.get(entries[0].id);
    single!.name = "Tampered too";

    expect((await library.list())[0].name).toBe("Original");
    expect((await library.get(entries[0].id))?.name).toBe("Original");
  });

  it("throttles lastStreamedAt writes to one per window", async () => {
    const { path, library } = await temporaryLibrary();
    const entry = await library.create({
      type: "movie",
      name: "Streamed",
      magnetUri: "magnet:?xt=urn:btih:streamed",
    });

    await library.markStreamed(entry.id);
    const first = (await library.get(entry.id))?.lastStreamedAt;
    expect(first).toBeDefined();
    const written = await readFile(path, "utf8");

    await library.markStreamed(entry.id);
    await library.markStreamed("hoshi:unknown");
    expect((await library.get(entry.id))?.lastStreamedAt).toBe(first);
    expect(await readFile(path, "utf8")).toBe(written);
  });
});

describe("search source schema and ownership", () => {
  const imported = {
    providerId: "jackett" as const,
    sourceId: "local",
    indexerId: "public",
    hash: "b".repeat(40),
  };
  const source: SeriesSource = {
    torrentFilePath: "/owned/source.torrent",
    sourceHash: "b".repeat(40),
    seasonHint: 2,
    managedMedia: true,
    searchImport: imported,
  };

  it("preserves legacy curated records and requires provider-specific provenance", () => {
    const legacy = {
      providerId: "curated",
      catalogId: "open-film",
      hash: "a".repeat(40),
      rightsUrl: "https://example.org/rights",
      license: "CC-BY",
    };
    expect(searchImportSchema.parse(legacy)).toEqual(legacy);
    expect(searchImportSchema.parse(imported)).toEqual(imported);
    for (const providerId of ["curated", "prowlarr", "jackett"]) {
      expect(
        searchImportSchema.safeParse({ providerId, hash: "a".repeat(40) })
          .success,
      ).toBe(false);
    }
    const oldEntry = {
      id: "hoshi:legacy",
      type: "series",
      name: "Legacy",
      magnetUri: "magnet:?xt=urn:btih:legacy",
      extraSources: [{ magnetUri: "magnet:?xt=urn:btih:extra", seasonHint: 3 }],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    expect(libraryEntrySchema.parse(oldEntry)).toEqual(oldEntry);
  });

  it("strips nested server metadata from create and patch schemas", () => {
    const input = {
      type: "series" as const,
      name: "Show",
      magnetUri: "magnet:?xt=urn:btih:primary",
      extraSources: [source],
    };
    for (const schema of [createEntrySchema, patchEntrySchema]) {
      const parsed = schema.parse(input);
      expect(parsed.extraSources?.[0]).not.toHaveProperty("managedMedia");
      expect(parsed.extraSources?.[0]).not.toHaveProperty("sourceHash");
      expect(parsed.extraSources?.[0]).not.toHaveProperty("searchImport");
      expect(schema.safeParse({ ...input, extraSources: [{}] }).success).toBe(
        false,
      );
    }
  });

  it("preserves ownership and provenance on a reordered source with edited selection", async () => {
    const { library } = await temporaryLibrary();
    const extra = { magnetUri: "magnet:?xt=urn:btih:other" };
    const created = await library.create({
      type: "series",
      name: "Show",
      magnetUri: "magnet:?xt=urn:btih:primary",
      extraSources: [source, extra],
    });
    const updated = await library.patch(created.id, {
      extraSources: [
        extra,
        { torrentFilePath: source.torrentFilePath, seasonHint: 4 },
      ],
    });
    expect(updated?.extraSources?.[1]).toEqual({ ...source, seasonHint: 4 });
    const changed = await library.patch(created.id, {
      extraSources: [{ torrentFilePath: "/user/replacement.torrent" }],
    });
    expect(changed?.extraSources?.[0].searchImport).toBeUndefined();
    expect(changed?.extraSources?.[0].sourceHash).toBeUndefined();
    expect(changed?.extraSources?.[0].managedMedia).toBeUndefined();
  });

  it("does not transfer primary ownership or provenance to a replacement source", async () => {
    const { library } = await temporaryLibrary();
    const { entry } = await library.importSearch(
      {
        type: "movie",
        name: "Managed",
        torrentFilePath: "/owned/source.torrent",
        managedMedia: true,
      },
      imported,
      { key: randomUUID(), fingerprint: "c".repeat(64) },
    );
    const updated = await library.patch(entry.id, {
      torrentFilePath: "/user/new.torrent",
    });
    expect(updated?.managedMedia).toBeUndefined();
    expect(updated?.sourceHash).toBeUndefined();
    expect(updated?.searchImport).toBeUndefined();
  });

  it("deduplicates a new import against an attached torrent's provenance", async () => {
    const { library } = await temporaryLibrary();
    const entry = await library.create({
      type: "series",
      name: "Show",
      magnetUri: "magnet:?xt=urn:btih:primary",
      extraSources: [source],
    });
    const result = await library.importSearch(
      {
        type: "movie",
        name: "Duplicate",
        magnetUri: `magnet:?xt=urn:btih:${imported.hash}`,
      },
      imported,
      { key: randomUUID(), fingerprint: "c".repeat(64) },
    );
    expect(result).toMatchObject({
      outcome: "existing",
      entry: { id: entry.id },
    });
    expect(await library.list()).toHaveLength(1);
  });
});

describe("library HTTP source ownership boundary", () => {
  function route(method: string, pathname: string, input: unknown = {}) {
    return {
      method,
      url: new URL(pathname, "http://localhost"),
      request: Readable.from([
        Buffer.from(JSON.stringify(input)),
      ]) as IncomingMessage,
      response: {
        writeHead: vi.fn(),
        end: vi.fn(),
      } as unknown as ServerResponse,
    };
  }

  it("refills the inspection cache in the background after a source edit", async () => {
    const { library } = await temporaryLibrary();
    const entry = await library.create({
      type: "series",
      name: "Show",
      magnetUri: "magnet:?xt=urn:btih:primary",
    });
    await library.setInspectionCache(entry.id, {
      hash: "abc123",
      selectedFiles: [
        { id: 1, path: "S01E01.mkv", length: 100, season: 1, episode: 1 },
      ],
      inspectedAt: new Date().toISOString(),
    });
    const status = (hash: string, path: string) => ({
      title: "Show",
      hash,
      stat: 1,
      stat_string: "Torrent working",
      file_stats: [{ id: 1, path, length: 100 }],
    });
    const torrServer = {
      addMagnet: vi
        .fn()
        .mockResolvedValueOnce(status("abc123", "S01E01.mkv"))
        .mockResolvedValueOnce(status("def456", "S02E01.mkv")),
      waitForFiles: vi
        .fn()
        .mockResolvedValueOnce(status("abc123", "S01E01.mkv"))
        .mockResolvedValueOnce(status("def456", "S02E01.mkv")),
      get: vi.fn(),
    } as unknown as TorrServerClient;
    const context = { library, torrServer } as HandlerContext;
    await handleLibraryItem(
      context,
      route("PATCH", `/api/library/${entry.id}`, {
        extraSources: [{ magnetUri: "magnet:?xt=urn:btih:season2" }],
      }),
    );
    await vi.waitFor(async () => {
      const cache = (await library.get(entry.id))?.inspectionCache;
      expect(cache?.selectedFiles.map((file) => file.id)).toEqual([1, 100_001]);
    });
    expect(torrServer.addMagnet).toHaveBeenCalledTimes(2);
  });

  it.each(["managedMedia", "sourceHash", "searchImport", "searchReceipts"])(
    "rejects forged nested %s at create and patch boundaries",
    async (field) => {
      const { library } = await temporaryLibrary();
      const context = { library } as HandlerContext;
      const input = {
        type: "series",
        name: "Show",
        magnetUri: "magnet:?xt=urn:btih:primary",
        extraSources: [
          { magnetUri: "magnet:?xt=urn:btih:extra", [field]: true },
        ],
      };
      await expect(
        handleLibraryCollection(context, route("POST", "/api/library", input)),
      ).rejects.toThrow("server-owned");
      await expect(
        handleLibraryItem(
          context,
          route("PATCH", "/api/library/missing", input),
        ),
      ).rejects.toThrow("server-owned");
      expect(await library.list()).toHaveLength(0);
    },
  );

  it("cleans removed extras but keeps reordered and shared files, then cleans a deleted entry", async () => {
    const { directory, library } = await temporaryLibrary();
    const root = join(directory, "uploads");
    const paths = await Promise.all(
      [1, 2].map(() =>
        localMedia.saveTorrentBytes(
          Buffer.from("synthetic"),
          randomUUID(),
          "source.torrent",
          root,
        ),
      ),
    );
    const extras: SeriesSource[] = paths.map((torrentFilePath) => ({
      torrentFilePath,
      managedMedia: true,
    }));
    const entry = await library.create({
      type: "series",
      name: "Show",
      magnetUri: "magnet:?xt=urn:btih:primary",
      extraSources: extras,
    });
    const shared = await library.create({
      type: "movie",
      name: "Referenced",
      torrentFilePath: paths[0],
    });
    const remove = localMedia.removeManagedMedia;
    vi.spyOn(localMedia, "removeManagedMedia").mockImplementation(
      (previous, references) => remove(previous, references, root),
    );
    const context = { library } as HandlerContext;
    await handleLibraryItem(
      context,
      route("PATCH", `/api/library/${entry.id}`, {
        extraSources: [
          { torrentFilePath: paths[1] },
          { torrentFilePath: paths[0] },
        ],
      }),
    );
    expect(
      (await library.get(entry.id))?.extraSources?.every(
        (source) => source.managedMedia,
      ),
    ).toBe(true);
    await expect(readFile(paths[1], "utf8")).resolves.toBe("synthetic");
    await handleLibraryItem(
      context,
      route("PATCH", `/api/library/${entry.id}`, {
        extraSources: [{ torrentFilePath: paths[0] }],
      }),
    );
    await expect(readFile(paths[1])).rejects.toMatchObject({ code: "ENOENT" });
    await handleLibraryItem(
      context,
      route("DELETE", `/api/library/${entry.id}`),
    );
    await expect(readFile(paths[0], "utf8")).resolves.toBe("synthetic");
    expect((await library.get(shared.id))?.torrentFilePath).toBe(paths[0]);

    // Once the last owner is removed, its own managed file is cleaned.
    const another = await library.create({
      type: "series",
      name: "Another",
      magnetUri: "magnet:?xt=urn:btih:other",
      extraSources: [extras[0]],
    });
    await library.remove(shared.id);
    await handleLibraryItem(
      context,
      route("DELETE", `/api/library/${another.id}`),
    );
    await expect(readFile(paths[0])).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("reports failed managed cleanup without skipping deferred disk-copy cleanup", async () => {
    const { library } = await temporaryLibrary();
    const entry = await library.create({
      type: "series",
      name: "Show",
      magnetUri: "magnet:?xt=urn:btih:primary",
    });
    await library.setDiskCopy(entry.id, {
      desired: "keep",
      volumeId: "offline",
      relativeDir: "show",
      sourceRevision: "revision",
      scope: "all",
      files: [],
      updatedAt: new Date().toISOString(),
    });
    const failure = new Error("Permission denied");
    vi.spyOn(localMedia, "removeManagedMedia").mockRejectedValue(failure);
    const warning = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    const add = vi.fn().mockResolvedValue(undefined);
    const cancel = vi.fn();
    const context = {
      library,
      volumes: { resolve: vi.fn().mockResolvedValue({ state: "offline" }) },
      diskCleanup: { add },
      archiver: { cancel },
    } as unknown as HandlerContext;
    await expect(
      handleLibraryItem(context, route("DELETE", `/api/library/${entry.id}`)),
    ).rejects.toBe(failure);
    expect(add).toHaveBeenCalledWith({
      volumeId: "offline",
      relativeDir: "show",
    });
    expect(cancel).toHaveBeenCalledWith(entry.id);
    expect(warning).toHaveBeenCalledWith(
      expect.stringContaining("managed_media_cleanup_failed"),
    );
    expect(await library.get(entry.id)).toBeUndefined();
  });

  it("reports failed managed cleanup even when there is no disk copy", async () => {
    const { library } = await temporaryLibrary();
    const entry = await library.create({
      type: "movie",
      name: "Show",
      magnetUri: "magnet:?xt=urn:btih:primary",
    });
    const failure = new Error("Permission denied");
    vi.spyOn(localMedia, "removeManagedMedia").mockRejectedValue(failure);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    await expect(
      handleLibraryItem(
        { library } as HandlerContext,
        route("DELETE", `/api/library/${entry.id}`),
      ),
    ).rejects.toBe(failure);
  });
});
