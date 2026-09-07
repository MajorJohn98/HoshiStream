import { randomUUID } from "node:crypto";
import {
  mkdir,
  readFile,
  rm,
  realpath,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, join, resolve, sep } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  clearLocalInspectionCache,
  inspectLocalEntry,
  mediaHeaders,
  parseRange,
  removeManagedMedia,
  saveTorrentBytes,
} from "../src/local-media.ts";
import { createEntrySchema, type LibraryEntry } from "../src/types.ts";

const directories: string[] = [];
async function testDirectory() {
  const directory = resolve(`.test-media-data-${randomUUID()}`);
  directories.push(directory);
  await mkdir(directory);
  return directory;
}
afterEach(async () => {
  clearLocalInspectionCache();
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

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
    const directory = await testDirectory();
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

  describe("managed extra torrent cleanup", () => {
    function entry(torrentFilePath: string): LibraryEntry {
      return {
        id: "hoshi:owned-extra",
        type: "series",
        name: "Synthetic show",
        magnetUri: "magnet:?xt=urn:btih:primary",
        extraSources: [{ torrentFilePath, managedMedia: true }],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
    }
    async function fixture() {
      const directory = await testDirectory();
      const root = join(directory, "uploads");
      const path = await saveTorrentBytes(
        Buffer.from("synthetic"),
        randomUUID(),
        "source.torrent",
        root,
      );
      return { directory, root, path, owned: entry(path) };
    }

    it("removes an owned extra without requiring primary managedMedia", async () => {
      const { root, path, owned } = await fixture();
      await removeManagedMedia(owned, [], root);
      await expect(stat(path)).rejects.toMatchObject({ code: "ENOENT" });
      await expect(stat(dirname(path))).rejects.toMatchObject({
        code: "ENOENT",
      });
      await expect(stat(root)).resolves.toBeDefined();
      await removeManagedMedia(owned, [], root);
    });

    it("does not remove non-managed user files or other files in the same batch", async () => {
      const { root, path, owned } = await fixture();
      const userPath = join(dirname(path), "user.torrent");
      await writeFile(userPath, "user-owned");
      await removeManagedMedia(
        { ...owned, extraSources: [{ torrentFilePath: userPath }] },
        [],
        root,
      );
      await removeManagedMedia(owned, [], root);
      await expect(readFile(userPath, "utf8")).resolves.toBe("user-owned");
    });

    it("protects files referenced by any primary, extra source, or local folder", async () => {
      const { root, path, owned } = await fixture();
      const primaryReference: LibraryEntry = {
        ...owned,
        id: "primary-reference",
        torrentFilePath: path,
        extraSources: [],
      };
      const extraReference: LibraryEntry = {
        ...owned,
        id: "extra-reference",
        extraSources: [{ torrentFilePath: path }],
      };
      const folderReference: LibraryEntry = {
        ...owned,
        id: "folder-reference",
        magnetUri: undefined,
        localFolderPath: dirname(path),
        extraSources: [],
      };
      for (const reference of [
        primaryReference,
        extraReference,
        folderReference,
      ]) {
        await removeManagedMedia(owned, [reference], root);
        await expect(stat(path)).resolves.toBeDefined();
      }
      await removeManagedMedia(owned, [], root);
      await expect(stat(path)).rejects.toMatchObject({ code: "ENOENT" });
    });

    it("protects an owned folder while another entry references one of its files", async () => {
      const { root, path, owned } = await fixture();
      const folder: LibraryEntry = {
        ...owned,
        magnetUri: undefined,
        extraSources: [],
        localFolderPath: `${dirname(path)}${sep}`,
        managedMedia: true,
      };
      await removeManagedMedia(folder, [owned], root);
      await expect(stat(path)).resolves.toBeDefined();
      await removeManagedMedia(folder, [], root);
      await expect(stat(path)).rejects.toMatchObject({ code: "ENOENT" });
    });

    it("never follows forged outside paths, non-upload batches, or source symlinks", async () => {
      const { directory, root, owned } = await fixture();
      const outsideDirectory = join(directory, "outside");
      await mkdir(outsideDirectory);
      const outside = join(outsideDirectory, "user.torrent");
      await writeFile(outside, "do-not-delete");
      await removeManagedMedia(entry(outside), [], root);
      const nonBatch = join(root, "user.torrent");
      await writeFile(nonBatch, "do-not-delete");
      await removeManagedMedia(entry(nonBatch), [], root);
      const link = join(
        dirname(owned.extraSources![0].torrentFilePath!),
        "linked",
      );
      await symlink(outsideDirectory, link, "junction");
      const linkedFile = join(link, "user.torrent");
      await removeManagedMedia(entry(linkedFile), [], root);
      await expect(readFile(outside, "utf8")).resolves.toBe("do-not-delete");
      await expect(readFile(nonBatch, "utf8")).resolves.toBe("do-not-delete");
      await expect(readFile(linkedFile, "utf8")).resolves.toBe("do-not-delete");
    });

    it("protects a managed path referenced through a different symlink", async () => {
      const { directory, root, path, owned } = await fixture();
      const alias = join(directory, "alias");
      await symlink(dirname(path), alias, "junction");
      await removeManagedMedia(
        owned,
        [entry(join(alias, basename(path)))],
        root,
      );
      await expect(stat(path)).resolves.toBeDefined();
    });
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

  it("links and relinks a Unicode folder without copying or deleting the source", async () => {
    const directory = await testDirectory();
    const first = join(directory, "M\u00e9dia with spaces");
    const second = join(directory, "Relinked");
    await mkdir(first);
    await mkdir(second);
    const original = join(first, "Show.S01E01.mkv");
    const replacement = join(second, "Show.S01E01.mkv");
    await writeFile(original, "original");
    await writeFile(replacement, "replacement");
    const entry: LibraryEntry = {
      id: "hoshi:relink",
      type: "series",
      name: "Show",
      localFolderPath: first,
      managedMedia: false,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    expect((await inspectLocalEntry(entry))?.files[0].localPath).toBe(
      await realpath(original),
    );
    entry.localFolderPath = second;
    expect((await inspectLocalEntry(entry))?.files[0].localPath).toBe(
      await realpath(replacement),
    );
    await removeManagedMedia(entry, [], directory);
    expect(await readFile(original, "utf8")).toBe("original");
    expect(await readFile(replacement, "utf8")).toBe("replacement");
  });

  it("normalizes nested series paths so Windows extras cannot shadow episodes", async () => {
    const directory = await testDirectory();
    await mkdir(join(directory, "Season 1"));
    await mkdir(join(directory, "Extras"));
    await writeFile(join(directory, "Season 1", "Show.S01E01.mkv"), "episode");
    await writeFile(join(directory, "Extras", "Show.S01E01.mkv"), "extra");
    const inspection = await inspectLocalEntry({
      id: "hoshi:windows-extras",
      type: "series",
      name: "Show",
      localFolderPath: directory,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    expect(inspection?.selectedFiles).toHaveLength(1);
    expect(inspection?.selectedFiles[0].path).toBe("Season 1/Show.S01E01.mkv");
  });
});
