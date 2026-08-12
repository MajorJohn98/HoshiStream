import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { inspectEntry, resolveStreamSource } from "../src/inspection.js";
import { Library } from "../src/library.js";
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

function fakeTorrServer() {
  return {
    addMagnet: vi.fn().mockResolvedValue(status),
    waitForFiles: vi.fn().mockResolvedValue(status),
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

  it("serves streams from the cache without metadata polling", async () => {
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
