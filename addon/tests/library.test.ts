import {
  mkdtemp,
  readFile,
  readdir,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { Library, LibraryError } from "../src/library.ts";
import { createEntrySchema } from "../src/types.ts";

async function temporaryLibrary() {
  const directory = await mkdtemp(join(tmpdir(), "hoshistream-"));
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
    const directory = await mkdtemp(join(tmpdir(), "hoshistream-"));
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
