import { randomUUID } from "node:crypto";
import {
  copyFile,
  mkdir,
  readFile,
  rename,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import { dirname } from "node:path";
import { z } from "zod";
import type { DirectPlay } from "./direct-play.ts";
import { tagKey } from "./tags.ts";
import {
  libraryEntrySchema,
  type CreateEntry,
  type DiskCopy,
  type InspectionCache,
  type LibraryEntry,
  type PlaybackState,
  type PatchEntry,
} from "./types.ts";

const librarySchema = z.array(libraryEntrySchema);
const STREAMED_THROTTLE_MS = 180_000;
const CACHE_INVALIDATING_FIELDS = [
  "type",
  "magnetUri",
  "torrentFilePath",
  "localFilePath",
  "localFolderPath",
  "preferredFileIndex",
  "fileOverrides",
  "extraSources",
] as const;

export class LibraryError extends Error {}

export class Library {
  private queue: Promise<void> = Promise.resolve();
  private cache?: { mtimeMs: number; size: number; entries: LibraryEntry[] };
  // Last write of lastStreamedAt per entry; keeps the throttle check off the
  // disk-backed read path that every range request would otherwise hit.
  private readonly streamedAt = new Map<string, number>();

  private readonly path: string;

  constructor(path: string) {
    this.path = path;
  }

  async list(): Promise<LibraryEntry[]> {
    await this.queue;
    return structuredClone(await this.read());
  }

  // Clones only the matched entry: playback range requests call this on
  // every chunk, so copying the whole library each time adds up.
  async get(id: string): Promise<LibraryEntry | undefined> {
    await this.queue;
    const entry = (await this.read()).find((entry) => entry.id === id);
    return entry && structuredClone(entry);
  }

  create(input: CreateEntry): Promise<LibraryEntry> {
    return this.update(async (entries) => {
      const now = new Date().toISOString();
      const entry = libraryEntrySchema.parse({
        ...input,
        id: `hoshi:${randomUUID()}`,
        createdAt: now,
        updatedAt: now,
      });
      entries.push(entry);
      return entry;
    });
  }

  patch(id: string, input: PatchEntry): Promise<LibraryEntry | undefined> {
    return this.update(async (entries) => {
      const index = entries.findIndex((entry) => entry.id === id);
      if (index === -1) return undefined;
      const current = entries[index];
      const candidate: Record<string, unknown> = {
        ...current,
        ...input,
        id,
        createdAt: current.createdAt,
        updatedAt: new Date().toISOString(),
      };
      if (input.description === null) delete candidate.description;
      if (input.poster === null) delete candidate.poster;
      if (input.background === null) delete candidate.background;
      if (input.tags === null) delete candidate.tags;
      if (CACHE_INVALIDATING_FIELDS.some((field) => field in input)) {
        delete candidate.inspectionCache;
        delete candidate.directPlay;
      }
      const updated = libraryEntrySchema.parse(candidate);
      entries[index] = updated;
      return updated;
    });
  }

  remove(id: string): Promise<boolean> {
    return this.update(async (entries) => {
      const index = entries.findIndex((entry) => entry.id === id);
      if (index === -1) return false;
      entries.splice(index, 1);
      return true;
    });
  }

  // Cascade a tag rename (or removal when `to` is undefined) through every
  // entry. Returns how many entries changed.
  retag(from: string, to: string | undefined): Promise<number> {
    const key = tagKey(from);
    return this.update(async (entries) => {
      let changed = 0;
      const now = new Date().toISOString();
      entries.forEach((entry, index) => {
        if (!entry.tags?.some((tag) => tagKey(tag) === key)) return;
        const tags = entry.tags.flatMap((tag) =>
          tagKey(tag) === key ? (to === undefined ? [] : [to]) : [tag],
        );
        const candidate: Record<string, unknown> = {
          ...entry,
          tags,
          updatedAt: now,
        };
        if (!tags.length) delete candidate.tags;
        entries[index] = libraryEntrySchema.parse(candidate);
        changed += 1;
      });
      return changed;
    });
  }

  setInspectionCache(id: string, cache: InspectionCache): Promise<void> {
    return this.update(async (entries) => {
      const index = entries.findIndex((entry) => entry.id === id);
      if (index === -1) return;
      entries[index] = libraryEntrySchema.parse({
        ...entries[index],
        inspectionCache: cache,
      });
    });
  }

  setPlayback(id: string, playback: PlaybackState): Promise<void> {
    return this.update(async (entries) => {
      const index = entries.findIndex((entry) => entry.id === id);
      if (index === -1) return;
      entries[index] = libraryEntrySchema.parse({
        ...entries[index],
        playback,
      });
    });
  }

  setDirectPlay(id: string, directPlay: DirectPlay): Promise<void> {
    return this.update(async (entries) => {
      const index = entries.findIndex((entry) => entry.id === id);
      if (index === -1) return;
      entries[index] = libraryEntrySchema.parse({
        ...entries[index],
        directPlay,
      });
    });
  }

  // Undefined removes the disk copy from the entry (a settled disable).
  setDiskCopy(id: string, diskCopy: DiskCopy | undefined): Promise<void> {
    return this.update(async (entries) => {
      const index = entries.findIndex((entry) => entry.id === id);
      if (index === -1) return;
      const candidate: Record<string, unknown> = {
        ...entries[index],
        diskCopy,
        updatedAt: new Date().toISOString(),
      };
      if (!diskCopy) delete candidate.diskCopy;
      entries[index] = libraryEntrySchema.parse(candidate);
    });
  }

  // Record that a client requested this entry's stream. Throttled: stream
  // lists and range requests repeat constantly, and one timestamp per few
  // minutes is plenty for "recently streamed".
  async markStreamed(id: string): Promise<void> {
    const now = Date.now();
    const last = this.streamedAt.get(id);
    if (last !== undefined && now - last < STREAMED_THROTTLE_MS) return;
    this.streamedAt.set(id, now);
    await this.update(async (entries) => {
      const index = entries.findIndex((entry) => entry.id === id);
      if (index === -1) {
        this.streamedAt.delete(id);
        return;
      }
      const stored = entries[index].lastStreamedAt;
      if (stored && now - Date.parse(stored) < STREAMED_THROTTLE_MS) return;
      entries[index] = libraryEntrySchema.parse({
        ...entries[index],
        lastStreamedAt: new Date(now).toISOString(),
      });
    });
  }

  private async read(): Promise<LibraryEntry[]> {
    try {
      const info = await stat(this.path);
      if (
        this.cache &&
        this.cache.mtimeMs === info.mtimeMs &&
        this.cache.size === info.size
      ) {
        return this.cache.entries;
      }
      const entries = await this.parse(this.path);
      this.cache = { mtimeMs: info.mtimeMs, size: info.size, entries };
      return entries;
    } catch (error) {
      this.cache = undefined;
      return this.recover(error);
    }
  }

  private async parse(path: string): Promise<LibraryEntry[]> {
    return librarySchema.parse(JSON.parse(await readFile(path, "utf8")));
  }

  private async recover(cause: unknown): Promise<LibraryEntry[]> {
    const missing =
      cause instanceof Error &&
      (cause as NodeJS.ErrnoException).code === "ENOENT";
    let entries: LibraryEntry[];
    try {
      entries = await this.parse(this.backupPath);
    } catch (backupError) {
      const backupMissing =
        backupError instanceof Error &&
        (backupError as NodeJS.ErrnoException).code === "ENOENT";
      if (missing && backupMissing) return [];
      throw new LibraryError(
        `Cannot read library: ${cause instanceof Error ? cause.message : cause}`,
      );
    }
    if (!missing) {
      await rename(this.path, `${this.path}.corrupt-${Date.now()}`).catch(
        () => undefined,
      );
    }
    await copyFile(this.backupPath, this.path).catch(() => undefined);
    console.error(
      JSON.stringify({
        level: "warn",
        event: "library_recovered_from_backup",
        entries: entries.length,
        error: cause instanceof Error ? cause.message : String(cause),
      }),
    );
    return entries;
  }

  private get backupPath(): string {
    return `${this.path}.bak`;
  }

  private update<T>(
    change: (entries: LibraryEntry[]) => Promise<T>,
  ): Promise<T> {
    const operation = this.queue.then(async () => {
      // Mutations work on a copy so the cached array stays pristine until
      // the write lands.
      const entries = structuredClone(await this.read());
      const result = await change(entries);
      await this.write(entries);
      return result;
    });
    this.queue = operation.then(
      () => undefined,
      () => undefined,
    );
    return operation;
  }

  private async write(entries: LibraryEntry[]): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true });
    const temporaryPath = `${this.path}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporaryPath, `${JSON.stringify(entries, null, 2)}\n`, {
        mode: 0o600,
      });
      await rename(temporaryPath, this.path);
      const info = await stat(this.path).catch(() => undefined);
      this.cache = info
        ? {
            mtimeMs: info.mtimeMs,
            size: info.size,
            entries: structuredClone(entries),
          }
        : undefined;
      await copyFile(this.path, this.backupPath).catch(() => undefined);
    } catch (error) {
      this.cache = undefined;
      await unlink(temporaryPath).catch(() => undefined);
      throw error;
    }
  }
}
