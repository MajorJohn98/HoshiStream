import { createHash } from "node:crypto";
import {
  mkdir,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { z } from "zod";
import { rawFileId, type SelectedFile } from "./media-file-selection.ts";
import { containsPath, isSafeRelativePath } from "./path-safety.ts";
import type { DiskCopy, DiskCopyFile, LibraryEntry } from "./types.ts";
import type { VolumeRegistry } from "./volumes.ts";

export class DiskCopyError extends Error {}

export const PARTIAL_SUFFIX = ".partial";

/**
 * Stable identity of a source file: torrent hash + the torrent's own file id.
 * Composite ids depend on source order and raw ids collide across sources;
 * this key survives both.
 */
export function sourceKey(primaryHash: string, file: SelectedFile): string {
  return `${file.hash ?? primaryHash}:${rawFileId(file.id)}`;
}

/**
 * Torrent paths are untrusted external input. Normalize separators, then
 * reject — never rewrite — anything that could escape the entry directory.
 */
export function safeRelativePath(torrentPath: string): string {
  const normalized = torrentPath.replaceAll("\\", "/").replace(/\/+$/, "");
  if (!isSafeRelativePath(normalized))
    throw new DiskCopyError("Torrent contains an unsafe file path");
  return normalized;
}

/**
 * Directory for an entry's disk copy under the volume root. Uses the entry id
 * for stability across renames, prefixed with a sanitized title for humans
 * browsing the drive.
 */
export function defaultRelativeDir(entry: {
  id: string;
  name: string;
}): string {
  const cleaned = entry.name
    .normalize("NFKC")
    .replace(/[^\p{L}\p{N} ._-]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 60)
    .trim();
  // Require real content: punctuation-only leftovers ("..", "-") could form
  // confusing or unsafe directory names.
  const title = /[\p{L}\p{N}]/u.test(cleaned) ? cleaned : "entry";
  const suffix = entry.id.replace(/^hoshi:/, "").slice(0, 8);
  return `${title}-${suffix}`;
}

/** Fingerprint of the selected source files backing a disk copy. */
export function computeSourceRevision(
  files: Pick<DiskCopyFile, "sourceKey" | "relativePath" | "length">[],
): string {
  const canonical = files
    .map((file) => [file.sourceKey, file.relativePath, file.length] as const)
    .sort((a, b) => a[0].localeCompare(b[0]));
  return createHash("sha256")
    .update(JSON.stringify(canonical))
    .digest("hex")
    .slice(0, 16);
}

export interface ManifestOptions {
  scope: DiskCopy["scope"];
  // Explicit per-file intent for scope "selected". Omitted: previous
  // inclusion is preserved; files new to the manifest default to excluded.
  includedSourceKeys?: string[];
  previous?: DiskCopyFile[];
}

/**
 * Build the durable file manifest from the entry's inspected selection.
 * States carry over for files whose identity and size are unchanged, so
 * rebuilding a manifest never forgets completed work.
 */
export function buildManifest(
  entry: LibraryEntry,
  options: ManifestOptions,
): DiskCopyFile[] {
  const cache = entry.inspectionCache;
  if (!cache)
    throw new DiskCopyError(
      "Inspect the torrent before enabling its disk copy",
    );
  const previous = new Map(
    (options.previous ?? []).map((file) => [file.sourceKey, file]),
  );
  const explicit = options.includedSourceKeys
    ? new Set(options.includedSourceKeys)
    : undefined;
  return cache.selectedFiles
    .map((file) => {
      const key = sourceKey(cache.hash, file);
      const prior = previous.get(key);
      const carried = prior && prior.length === file.length;
      return {
        sourceKey: key,
        relativePath: safeRelativePath(file.path),
        length: file.length,
        included:
          options.scope === "all"
            ? true
            : (explicit?.has(key) ?? prior?.included ?? false),
        state: carried ? prior.state : ("missing" as const),
      };
    })
    .sort((a, b) => a.sourceKey.localeCompare(b.sourceKey));
}

/**
 * Absolute destination of a manifest file, containment-checked against the
 * volume root. Throws rather than serving or writing outside the volume.
 */
export function destinationPath(
  root: string,
  relativeDir: string,
  relativePath: string,
): string {
  if (!isSafeRelativePath(relativeDir) || !isSafeRelativePath(relativePath))
    throw new DiskCopyError("Unsafe disk copy path");
  const destination = resolve(root, relativeDir, relativePath);
  if (!containsPath(root, destination))
    throw new DiskCopyError("Disk copy path escapes the volume root");
  return destination;
}

/**
 * Sync persisted file states with filesystem facts. Persisted `complete` is
 * only a hint: files vanish, drives get edited elsewhere. `invalid` sticks
 * until an explicit retry so unknown wrong-size data is never silently
 * replaced.
 */
export async function reconcileFiles(
  root: string,
  relativeDir: string,
  files: DiskCopyFile[],
  options: { retry?: boolean } = {},
): Promise<{ files: DiskCopyFile[]; changed: boolean }> {
  let changed = false;
  const reconciled: DiskCopyFile[] = [];
  for (const file of files) {
    const destination = destinationPath(root, relativeDir, file.relativePath);
    const info = await stat(destination).catch(() => undefined);
    const partial = await stat(`${destination}${PARTIAL_SUFFIX}`).catch(
      () => undefined,
    );
    let state: DiskCopyFile["state"];
    if (info?.isFile() && info.size === file.length) {
      state = "complete";
    } else if (info) {
      // Existing file with the wrong size or type: unknown data, never
      // streamed. An explicit retry approves its replacement.
      state = options.retry ? "missing" : "invalid";
    } else if (file.state === "invalid" && !options.retry) {
      state = "invalid";
    } else if (partial?.isFile()) {
      state = "partial";
    } else {
      state = "missing";
    }
    if (state !== file.state) changed = true;
    reconciled.push({ ...file, state });
  }
  return { files: reconciled, changed };
}

/**
 * Delete an entry's disk copy directory — and nothing else. The directory is
 * containment-checked and realpath-verified so a symlinked or crafted path
 * can never delete outside the registered volume.
 */
export async function removeDiskCopyDirectory(
  root: string,
  relativeDir: string,
): Promise<void> {
  if (!isSafeRelativePath(relativeDir))
    throw new DiskCopyError("Unsafe disk copy directory");
  const directory = resolve(root, relativeDir);
  if (!containsPath(root, directory))
    throw new DiskCopyError("Disk copy directory escapes the volume root");
  const actualRoot = await realpath(root);
  const actual = await realpath(directory).catch(() => undefined);
  if (actual === undefined) return; // already gone
  if (!containsPath(actualRoot, actual))
    throw new DiskCopyError("Disk copy directory escapes the volume root");
  await rm(directory, { recursive: true, force: true });
}

// Deferred deletions ("tombstones"): cleanup the user asked for while the
// drive was offline. Kept outside library entries so an entry can be deleted
// and its cleanup still happen when the drive returns.
const tombstoneSchema = z.object({
  volumeId: z.string().min(1),
  relativeDir: z.string().min(1).refine(isSafeRelativePath),
  entryId: z.string().min(1).optional(),
  createdAt: z.string().datetime(),
});
const tombstonesSchema = z.array(tombstoneSchema);

export type DiskCleanupTombstone = z.infer<typeof tombstoneSchema>;

export class DiskCleanup {
  #queue: Promise<void> = Promise.resolve();

  private readonly path: string;

  constructor(path: string) {
    this.path = path;
  }

  async list(): Promise<DiskCleanupTombstone[]> {
    await this.#queue;
    return this.#read();
  }

  add(input: {
    volumeId: string;
    relativeDir: string;
    entryId?: string;
  }): Promise<void> {
    return this.#update(async (tombstones) => {
      if (
        tombstones.some(
          (tombstone) =>
            tombstone.volumeId === input.volumeId &&
            tombstone.relativeDir === input.relativeDir,
        )
      )
        return;
      tombstones.push(
        tombstoneSchema.parse({
          ...input,
          createdAt: new Date().toISOString(),
        }),
      );
    });
  }

  /**
   * Attempt every deferred deletion whose volume is currently online. Called
   * lazily (volume status polls); offline and ambiguous volumes keep their
   * tombstones untouched.
   */
  async sweep(volumes: VolumeRegistry): Promise<number> {
    const pending = await this.list();
    if (!pending.length) return 0;
    let removed = 0;
    for (const tombstone of pending) {
      const resolution = await volumes.resolve(tombstone.volumeId);
      if (resolution.state !== "online") continue;
      try {
        await removeDiskCopyDirectory(resolution.root, tombstone.relativeDir);
      } catch (error) {
        console.error(
          JSON.stringify({
            level: "warn",
            event: "disk_cleanup_failed",
            volumeId: tombstone.volumeId,
            error: error instanceof Error ? error.message : String(error),
          }),
        );
        continue;
      }
      await this.#update(async (tombstones) => {
        const index = tombstones.findIndex(
          (entry) =>
            entry.volumeId === tombstone.volumeId &&
            entry.relativeDir === tombstone.relativeDir,
        );
        if (index !== -1) tombstones.splice(index, 1);
      });
      removed += 1;
      console.log(
        JSON.stringify({
          level: "info",
          event: "disk_cleanup_completed",
          volumeId: tombstone.volumeId,
          entryId: tombstone.entryId,
        }),
      );
    }
    return removed;
  }

  async #read(): Promise<DiskCleanupTombstone[]> {
    try {
      return tombstonesSchema.parse(
        JSON.parse(await readFile(this.path, "utf8")),
      );
    } catch {
      return [];
    }
  }

  #update(
    change: (tombstones: DiskCleanupTombstone[]) => Promise<void>,
  ): Promise<void> {
    const operation = this.#queue.then(async () => {
      const tombstones = await this.#read();
      await change(tombstones);
      await mkdir(dirname(this.path), { recursive: true });
      const temporary = `${this.path}.tmp`;
      await writeFile(temporary, `${JSON.stringify(tombstones, null, 2)}\n`, {
        mode: 0o600,
      });
      await rename(temporary, this.path);
    });
    this.#queue = operation.then(
      () => undefined,
      () => undefined,
    );
    return operation;
  }
}
