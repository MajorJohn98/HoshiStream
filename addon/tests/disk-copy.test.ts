import {
  mkdir,
  mkdtemp,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  DiskCleanup,
  DiskCopyError,
  buildManifest,
  computeSourceRevision,
  defaultRelativeDir,
  destinationPath,
  reconcileFiles,
  removeDiskCopyDirectory,
  safeRelativePath,
  sourceKey,
} from "../src/disk-copy.ts";
import { VolumeRegistry } from "../src/volumes.ts";
import { libraryEntrySchema, type LibraryEntry } from "../src/types.ts";

const temporary: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporary
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

async function temporaryDir(prefix: string): Promise<string> {
  const dir = await realpath(await mkdtemp(join(tmpdir(), prefix)));
  temporary.push(dir);
  return dir;
}

function seriesEntry(): LibraryEntry {
  const now = new Date().toISOString();
  return libraryEntrySchema.parse({
    id: "hoshi:0f7f2f5e-4a5b-4a3c-8c2d-9e1f2a3b4c5d",
    type: "series",
    name: "Example Show",
    magnetUri: "magnet:?xt=urn:btih:aaaa",
    inspectionCache: {
      hash: "aaaa",
      inspectedAt: now,
      selectedFiles: [
        { id: 1, path: "Show/S01E01.mkv", length: 100, season: 1, episode: 1 },
        { id: 2, path: "Show/S01E02.mkv", length: 200, season: 1, episode: 2 },
        {
          // Composite id from extra source 1, with its own torrent hash.
          id: 100_003,
          path: "Show/S02E01.mkv",
          length: 300,
          season: 2,
          episode: 1,
          hash: "bbbb",
        },
      ],
    },
    createdAt: now,
    updatedAt: now,
  });
}

describe("disk copy identity and paths", () => {
  it("keys files by owning torrent hash and raw file id", () => {
    const entry = seriesEntry();
    const files = entry.inspectionCache!.selectedFiles;
    expect(sourceKey("aaaa", files[0])).toBe("aaaa:1");
    // Extra-source file: composite id folds back to the raw id, hash wins.
    expect(sourceKey("aaaa", files[2])).toBe("bbbb:3");
  });

  it("normalizes separators but rejects traversal outright", () => {
    expect(safeRelativePath("Show\\S01E01.mkv")).toBe("Show/S01E01.mkv");
    expect(() => safeRelativePath("../escape.mkv")).toThrow(DiskCopyError);
    expect(() => safeRelativePath("a/../../b.mkv")).toThrow(DiskCopyError);
    expect(() => safeRelativePath("/absolute.mkv")).toThrow(DiskCopyError);
  });

  it("derives a stable entry directory from title and id", () => {
    expect(defaultRelativeDir(seriesEntry())).toBe("Example Show-0f7f2f5e");
    expect(
      defaultRelativeDir({ id: "hoshi:12345678-x", name: "../..//" }),
    ).toBe("entry-12345678");
  });

  it("containment-checks destinations against the volume root", () => {
    expect(destinationPath("/vol", "Show-1", "S01E01.mkv")).toBe(
      "/vol/Show-1/S01E01.mkv",
    );
    expect(() => destinationPath("/vol", "..", "S01E01.mkv")).toThrow(
      DiskCopyError,
    );
  });
});

describe("manifest building", () => {
  it("includes everything under scope all and carries prior states", () => {
    const entry = seriesEntry();
    const first = buildManifest(entry, { scope: "all" });
    expect(first).toHaveLength(3);
    expect(first.every((file) => file.included)).toBe(true);
    expect(first.every((file) => file.state === "missing")).toBe(true);

    const completed = first.map((file) =>
      file.sourceKey === "aaaa:1"
        ? { ...file, state: "complete" as const }
        : file,
    );
    const rebuilt = buildManifest(entry, { scope: "all", previous: completed });
    expect(rebuilt.find((file) => file.sourceKey === "aaaa:1")?.state).toBe(
      "complete",
    );
  });

  it("freezes intent to explicitly included files under scope selected", () => {
    const entry = seriesEntry();
    const manifest = buildManifest(entry, {
      scope: "selected",
      includedSourceKeys: ["aaaa:2"],
    });
    expect(
      manifest.filter((file) => file.included).map((file) => file.sourceKey),
    ).toEqual(["aaaa:2"]);

    // Omitted includedSourceKeys preserves previous intent; new files
    // default to excluded.
    const preserved = buildManifest(entry, {
      scope: "selected",
      previous: manifest,
    });
    expect(
      preserved.filter((file) => file.included).map((file) => file.sourceKey),
    ).toEqual(["aaaa:2"]);
  });

  it("requires an inspected torrent and changes revision with selection", () => {
    const uninspected = { ...seriesEntry(), inspectionCache: undefined };
    expect(() => buildManifest(uninspected, { scope: "all" })).toThrow(
      DiskCopyError,
    );

    const entry = seriesEntry();
    const all = buildManifest(entry, { scope: "all" });
    const fewer = all.slice(0, 2);
    expect(computeSourceRevision(all)).not.toBe(computeSourceRevision(fewer));
    expect(computeSourceRevision(all)).toBe(
      computeSourceRevision([...all].reverse()),
    );
  });
});

describe("reconciliation", () => {
  it("adopts complete files, detects partials, and flags wrong sizes", async () => {
    const root = await temporaryDir("hoshistream-diskcopy-");
    const dir = join(root, "Show-1");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "one.mkv"), "x".repeat(10));
    await writeFile(join(dir, "two.mkv.partial"), "x".repeat(3));
    await writeFile(join(dir, "three.mkv"), "wrong size");

    const { files, changed } = await reconcileFiles(root, "Show-1", [
      {
        sourceKey: "a:1",
        relativePath: "one.mkv",
        length: 10,
        included: true,
        state: "missing",
      },
      {
        sourceKey: "a:2",
        relativePath: "two.mkv",
        length: 10,
        included: true,
        state: "missing",
      },
      {
        sourceKey: "a:3",
        relativePath: "three.mkv",
        length: 99,
        included: true,
        state: "missing",
      },
      {
        sourceKey: "a:4",
        relativePath: "four.mkv",
        length: 10,
        included: true,
        state: "complete",
      },
    ]);
    expect(changed).toBe(true);
    expect(files.map((file) => file.state)).toEqual([
      "complete",
      "partial",
      "invalid",
      "missing", // persisted complete is only a hint; the file is gone
    ]);
  });

  it("keeps invalid sticky until an explicit retry approves replacement", async () => {
    const root = await temporaryDir("hoshistream-diskcopy-");
    await mkdir(join(root, "Show-1"), { recursive: true });
    await writeFile(join(root, "Show-1", "one.mkv"), "wrong");
    const manifest = [
      {
        sourceKey: "a:1",
        relativePath: "one.mkv",
        length: 99,
        included: true,
        state: "invalid" as const,
      },
    ];

    const plain = await reconcileFiles(root, "Show-1", manifest);
    expect(plain.files[0].state).toBe("invalid");

    const retried = await reconcileFiles(root, "Show-1", manifest, {
      retry: true,
    });
    expect(retried.files[0].state).toBe("missing");
  });
});

describe("deletion safety and tombstones", () => {
  it("deletes only the entry directory and refuses symlink escapes", async () => {
    const root = await temporaryDir("hoshistream-diskcopy-");
    const outside = await temporaryDir("hoshistream-outside-");
    await mkdir(join(root, "Show-1"));
    await writeFile(join(root, "Show-1", "one.mkv"), "x");
    await writeFile(join(root, "keep.txt"), "keep");
    await symlink(outside, join(root, "Escape-1"));

    await removeDiskCopyDirectory(root, "Show-1");
    await expect(
      removeDiskCopyDirectory(root, "Show-1"),
    ).resolves.toBeUndefined(); // already gone: idempotent
    await expect(removeDiskCopyDirectory(root, "Escape-1")).rejects.toThrow(
      DiskCopyError,
    );
    await expect(realpath(join(root, "keep.txt"))).resolves.toBeTruthy();
    await expect(realpath(outside)).resolves.toBeTruthy();
  });

  it("sweeps deferred deletions only when the volume is online", async () => {
    const base = await temporaryDir("hoshistream-cleanup-");
    const mountBase = join(base, "Volumes");
    const drive = join(mountBase, "Seagate", "HoshiStream");
    await mkdir(join(drive, "Show-1"), { recursive: true });
    await writeFile(join(drive, "Show-1", "one.mkv"), "x");
    const volumes = new VolumeRegistry(join(base, "volumes.json"), mountBase);
    const volume = await volumes.register(drive);

    const cleanup = new DiskCleanup(join(base, "disk-cleanup.json"));
    await cleanup.add({
      volumeId: volume.id,
      relativeDir: "Show-1",
      entryId: "hoshi:x",
    });
    await cleanup.add({ volumeId: "missing-volume", relativeDir: "Other-1" });

    await expect(cleanup.sweep(volumes)).resolves.toBe(1);
    await expect(realpath(join(drive, "Show-1"))).rejects.toThrow();
    // The unreachable volume keeps its tombstone for a later sweep.
    await expect(cleanup.list()).resolves.toHaveLength(1);
  });
});

describe("library schema", () => {
  it("accepts diskCopy on torrent entries and rejects it on local ones", () => {
    const entry = seriesEntry();
    const diskCopy = {
      desired: "keep",
      volumeId: "vol-1",
      relativeDir: "Example Show-0f7f2f5e",
      sourceRevision: "abc123",
      scope: "all",
      files: buildManifest(entry, { scope: "all" }),
      updatedAt: new Date().toISOString(),
    };
    expect(libraryEntrySchema.safeParse({ ...entry, diskCopy }).success).toBe(
      true,
    );
    expect(
      libraryEntrySchema.safeParse({
        ...entry,
        magnetUri: undefined,
        localFilePath: "/media/example.mkv",
        diskCopy,
      }).success,
    ).toBe(false);
    expect(
      libraryEntrySchema.safeParse({
        ...entry,
        diskCopy: {
          ...diskCopy,
          files: [
            {
              sourceKey: "aaaa:1",
              relativePath: "../escape.mkv",
              length: 1,
              included: true,
              state: "missing",
            },
          ],
        },
      }).success,
    ).toBe(false);
  });
});
