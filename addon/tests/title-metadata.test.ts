import { randomUUID } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { derivedRuntime, toMetaPreview } from "../src/catalog.ts";
import { entrySourceDefinitionRevision } from "../src/imports/source-identity.ts";
import { Library } from "../src/library.ts";
import {
  libraryEntrySchema,
  patchEntrySchema,
  type LibraryEntry,
} from "../src/types.ts";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function temporaryLibrary() {
  const directory = resolve(`.test-title-metadata-${randomUUID()}`);
  directories.push(directory);
  await mkdir(directory);
  const path = join(directory, "library.json");
  await writeFile(path, "[]\n");
  return new Library(path);
}

const base: LibraryEntry = {
  id: "hoshi:1",
  type: "movie",
  name: "Film",
  magnetUri: "magnet:?xt=urn:btih:film",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};

describe("title metadata schema", () => {
  it("accepts the documented shapes", () => {
    const entry = libraryEntrySchema.parse({
      ...base,
      releaseInfo: "2019-2021",
      runtime: "1h 52m",
      imdbRating: "7.8",
      cast: ["Ada Lovelace", "Alan Turing"],
      director: ["Someone"],
      trailers: [{ source: "dQw4w9WgXcQ", type: "Trailer" }],
      posterShape: "landscape",
    });
    expect(entry.imdbRating).toBe("7.8");
    expect(entry.posterShape).toBe("landscape");
  });

  it.each([
    ["imdbRating", "11"],
    ["imdbRating", "7.85"],
    ["releaseInfo", "nineteen"],
    ["trailers", [{ source: "too-short", type: "Trailer" }]],
    ["trailers", [{ source: "dQw4w9WgXcQ", type: "Clip" }]],
    ["cast", Array.from({ length: 51 }, (_, i) => `Person ${i}`)],
    ["cast", [""]],
    ["posterShape", "circle"],
    ["logo", "not a url"],
  ])("rejects %s = %j", (field, value) => {
    expect(
      libraryEntrySchema.safeParse({ ...base, [field]: value }).success,
    ).toBe(false);
  });

  it("lets a PATCH clear any metadata field with null", () => {
    const patch = patchEntrySchema.parse({
      cast: null,
      trailers: null,
      posterShape: null,
      imdbRating: null,
    });
    expect(patch).toEqual({
      cast: null,
      trailers: null,
      posterShape: null,
      imdbRating: null,
    });
  });
});

describe("toMetaPreview", () => {
  it("emits the rich fields, search links, and defaultVideoId for movies", () => {
    const meta = toMetaPreview({
      ...base,
      tags: ["Drama"],
      releaseInfo: "2019",
      runtime: "1h 52m",
      imdbRating: "7.8",
      cast: ["Ada Lovelace"],
      director: ["Someone"],
      writer: ["Else"],
      country: "UK",
      language: "English",
      logo: "https://example.com/logo.png",
      awards: "1 win",
      trailers: [{ source: "dQw4w9WgXcQ", type: "Trailer" }],
      posterShape: "square",
    });
    expect(meta).toMatchObject({
      posterShape: "square",
      genres: ["Drama"],
      releaseInfo: "2019",
      runtime: "1h 52m",
      imdbRating: "7.8",
      cast: ["Ada Lovelace"],
      director: ["Someone"],
      writer: ["Else"],
      country: "UK",
      language: "English",
      logo: "https://example.com/logo.png",
      awards: "1 win",
      trailers: [{ source: "dQw4w9WgXcQ", type: "Trailer" }],
      behaviorHints: { defaultVideoId: "hoshi:1" },
    });
    expect(meta.links).toEqual([
      {
        name: "Drama",
        category: "Genres",
        url: "stremio:///search?search=Drama",
      },
      {
        name: "Ada Lovelace",
        category: "Cast",
        url: "stremio:///search?search=Ada%20Lovelace",
      },
    ]);
  });

  it("keeps the old shape for a bare entry and skips defaultVideoId on series", () => {
    const movie = toMetaPreview(base);
    expect(movie.posterShape).toBe("poster");
    expect(movie.links).toBeUndefined();
    expect(JSON.parse(JSON.stringify(movie))).toEqual({
      id: "hoshi:1",
      type: "movie",
      name: "Film",
      posterShape: "poster",
      behaviorHints: { defaultVideoId: "hoshi:1" },
    });
    const series = toMetaPreview({ ...base, type: "series" });
    expect(series.behaviorHints).toBeUndefined();
  });

  it("derives a movie runtime from the current source's probe", () => {
    const fact = {
      revision: entrySourceDefinitionRevision(base),
      jobId: randomUUID(),
      fileId: 1,
      sourceHash: "abc",
      filePath: "Film.mkv",
      fileLength: 100,
      technical: { sizeBytes: 100, durationSeconds: 112 * 60 + 20 },
      observedAt: "2026-01-01T00:00:00.000Z",
    };
    const entry: LibraryEntry = { ...base, mediaFacts: [fact] };
    expect(derivedRuntime(entry)).toBe("1h 52m");
    expect(toMetaPreview(entry).runtime).toBe("1h 52m");
    expect(toMetaPreview({ ...entry, runtime: "2h" }).runtime).toBe("2h");
    // Stale facts (different source definition) and series are ignored.
    expect(
      derivedRuntime({ ...entry, magnetUri: "magnet:?xt=urn:btih:other" }),
    ).toBeUndefined();
    expect(derivedRuntime({ ...entry, type: "series" })).toBeUndefined();
    expect(
      derivedRuntime({
        ...entry,
        mediaFacts: [
          { ...fact, technical: { sizeBytes: 1, durationSeconds: 45 * 60 } },
        ],
      }),
    ).toBe("45m");
  });
});

describe("Library.patch round-trip", () => {
  it("stores, replaces, and clears metadata without touching caches", async () => {
    const library = await temporaryLibrary();
    const created = await library.create({
      type: "movie",
      name: "Film",
      magnetUri: "magnet:?xt=urn:btih:film",
    });
    await library.setInspectionCache(created.id, {
      hash: "abc",
      selectedFiles: [{ id: 1, path: "Film.mkv", length: 100 }],
      inspectedAt: new Date().toISOString(),
    });
    const withMeta = (await library.patch(created.id, {
      cast: ["Ada Lovelace"],
      imdbRating: "8.0",
      trailers: [{ source: "dQw4w9WgXcQ", type: "Trailer" }],
      posterShape: "landscape",
    }))!;
    expect(withMeta.cast).toEqual(["Ada Lovelace"]);
    expect(withMeta.inspectionCache).toBeDefined();

    const cleared = (await library.patch(created.id, {
      cast: null,
      trailers: null,
      posterShape: null,
    }))!;
    expect(cleared.cast).toBeUndefined();
    expect(cleared.trailers).toBeUndefined();
    expect(cleared.posterShape).toBeUndefined();
    expect(cleared.imdbRating).toBe("8.0");
    const reloaded = await new Library(
      (library as unknown as { path: string }).path,
    )
      .list()
      .catch(() => undefined);
    if (reloaded) expect(reloaded[0]?.imdbRating).toBe("8.0");
  });
});
