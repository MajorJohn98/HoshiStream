import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  clearLocalInspectionCache,
  inspectLocalEntry,
  mediaHeaders,
  parseRange,
} from "../src/local-media.ts";
import { createEntrySchema, type LibraryEntry } from "../src/types.ts";

describe("local media ranges", () => {
  it("parses normal and suffix ranges and rejects invalid ranges", () => {
    expect(parseRange("bytes=10-19", 100)).toEqual({ start: 10, end: 19 });
    expect(parseRange("bytes=-10", 100)).toEqual({ start: 90, end: 99 });
    expect(parseRange("bytes=100-101", 100)).toBeUndefined();
  });

  it("accepts a managed series folder", () => {
    expect(
      createEntrySchema.parse({
        type: "series",
        name: "Show",
        localFolderPath: "/data/media/batch/Show",
      }).localFolderPath,
    ).toBe("/data/media/batch/Show");
  });

  it("only sends Content-Range for partial responses", () => {
    const range = { start: 0, end: 99 };
    expect(mediaHeaders(100, range, false, "video/mp4")).not.toHaveProperty(
      "content-range",
    );
    expect(mediaHeaders(100, range, true, "video/mp4")).toHaveProperty(
      "content-range",
      "bytes 0-99/100",
    );
  });
});

describe("local inspection cache", () => {
  async function temporaryEntry() {
    const directory = await mkdtemp(join(tmpdir(), "hoshistream-media-"));
    await writeFile(join(directory, "Movie.mkv"), "x".repeat(64));
    return {
      directory,
      entry: {
        id: "hoshi:local-cache-test",
        type: "movie",
        name: "Local",
        localFolderPath: directory,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      } as LibraryEntry,
    };
  }

  afterEach(() => clearLocalInspectionCache());

  it("reuses the walk instead of re-scanning on every call", async () => {
    const { entry } = await temporaryEntry();
    const first = await inspectLocalEntry(entry);
    expect(first?.files).toHaveLength(1);

    // Identity proves the cached value was returned rather than rebuilt.
    expect(await inspectLocalEntry(entry)).toBe(first);
  });

  it("re-scans when the directory changes", async () => {
    const { directory, entry } = await temporaryEntry();
    expect((await inspectLocalEntry(entry))?.files).toHaveLength(1);

    await writeFile(join(directory, "Extra.mkv"), "y".repeat(64));

    expect((await inspectLocalEntry(entry))?.files).toHaveLength(2);
  });

  it("re-scans when the file selection changes", async () => {
    const { entry } = await temporaryEntry();
    expect((await inspectLocalEntry(entry))?.selectedFiles).toHaveLength(1);

    const reselected = { ...entry, type: "series" as const };

    expect((await inspectLocalEntry(reselected))?.selectedFiles).toHaveLength(
      1,
    );
    expect(
      (await inspectLocalEntry(reselected))?.selectedFiles[0],
    ).toHaveProperty("episode");
  });
});
