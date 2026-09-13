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
import { assessDirectPlay, type DirectPlay } from "./direct-play.ts";
import { ImportError } from "./imports/errors.ts";
import type { SeriesPreviewPlan } from "./imports/series.ts";
import { tagKey } from "./tags.ts";
import {
  entryHasHash,
  entrySourceRevision,
  entrySourceDefinitionRevision,
} from "./imports/source-identity.ts";
import { sourceCheckSchema, type SourceCheck } from "./source-check-types.ts";
import {
  libraryEntrySchema,
  TITLE_METADATA_FIELDS,
  type CreateEntry,
  type DiskCopy,
  type InspectionCache,
  type LibraryEntry,
  type PlaybackState,
  type PatchEntry,
  type SearchImport,
  type SearchReceipt,
  type WatchState,
  searchReceiptSchema,
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

// Runs after persistence while holding the mutation queue; use the supplied
// snapshot for references, not library.list()/get(), which wait on that queue.
type SourceCleanup = (
  previous: LibraryEntry,
  remaining: LibraryEntry[],
) => Promise<void>;
type ImportedSourceOptions = {
  sourceHash: string;
  receipt: SearchReceipt;
  searchImport?: SearchImport;
};

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

  createWithReceipt(
    input: CreateEntry,
    receipt: SearchReceipt,
  ): Promise<{ entry: LibraryEntry; created: boolean }> {
    searchReceiptSchema.parse(receipt);
    return this.update(async (entries) => {
      const existing = this.findSearchReceipt(entries, receipt);
      if (existing) return { entry: existing, created: false };
      const now = new Date().toISOString();
      const entry = libraryEntrySchema.parse({
        ...input,
        id: `hoshi:${randomUUID()}`,
        createdAt: now,
        updatedAt: now,
        searchReceipts: [receipt],
      });
      entries.push(entry);
      return { entry, created: true };
    });
  }

  async searchReceipt(
    receipt: SearchReceipt,
  ): Promise<LibraryEntry | undefined> {
    return this.findSearchReceipt(await this.list(), receipt);
  }

  private findSearchReceipt(entries: LibraryEntry[], receipt: SearchReceipt) {
    for (const entry of entries) {
      const recorded = entry.searchReceipts?.find(
        (item) => item.key === receipt.key,
      );
      if (!recorded) continue;
      if (recorded.fingerprint !== receipt.fingerprint)
        throw new ImportError(
          "idempotency_conflict",
          "This retry key was already used for different details.",
          409,
        );
      return entry;
    }
  }

  importSource(input: CreateEntry, options: ImportedSourceOptions) {
    searchReceiptSchema.parse(options.receipt);
    return this.update(async (entries) => {
      const replay = this.findSearchReceipt(entries, options.receipt);
      if (replay) return { entry: replay, outcome: "existing" as const };
      const existing = entries.find((entry) =>
        entryHasHash(entry, options.sourceHash),
      );
      if (existing) {
        existing.searchReceipts = [
          ...(existing.searchReceipts ?? []),
          options.receipt,
        ];
        return { entry: existing, outcome: "existing" as const };
      }
      const now = new Date().toISOString();
      const entry = libraryEntrySchema.parse({
        ...input,
        id: `hoshi:${randomUUID()}`,
        createdAt: now,
        updatedAt: now,
        sourceHash: options.sourceHash.toLowerCase(),
        searchImport: options.searchImport,
        searchReceipts: [options.receipt],
      });
      entries.push(entry);
      return { entry, outcome: "created" as const };
    });
  }

  importSearch(
    input: CreateEntry,
    source: SearchImport,
    receipt: SearchReceipt,
  ) {
    return this.importSource(input, {
      sourceHash: source.hash,
      searchImport: source,
      receipt,
    });
  }

  appendImportedSeries(
    plan: SeriesPreviewPlan,
    receipt: SearchReceipt,
    allowReplace: boolean,
  ): Promise<{ entry: LibraryEntry; outcome: "appended" | "existing" }> {
    searchReceiptSchema.parse(receipt);
    return this.update(async (entries) => {
      const replay = this.findSearchReceipt(entries, receipt);
      if (replay) return { entry: replay, outcome: "existing" as const };
      const index = entries.findIndex((entry) => entry.id === plan.entryId);
      const current = entries[index];
      if (
        !current ||
        current.type !== "series" ||
        current.localFilePath ||
        current.localFolderPath ||
        !(current.magnetUri || current.torrentFilePath)
      )
        throw new ImportError(
          "invalid_target",
          "Choose an existing torrent-backed series.",
          409,
        );
      if (entryHasHash(current, plan.hash)) {
        current.searchReceipts = [...(current.searchReceipts ?? []), receipt];
        return { entry: current, outcome: "existing" as const };
      }
      if (entrySourceRevision(current) !== plan.sourceRevision)
        throw new ImportError(
          "stale_preview",
          "The series sources or episode selection changed. Preview again before adding.",
          409,
        );
      if (plan.replacements.length && !allowReplace)
        throw new ImportError(
          "replacement_confirmation_required",
          "Confirm episode replacements before adding this source.",
          409,
        );
      const updated = libraryEntrySchema.parse({
        ...current,
        extraSources: [...(current.extraSources ?? []), plan.source],
        inspectionCache: plan.inspectionCache,
        directPlay: undefined,
        mediaFacts: undefined,
        sourceCheck: undefined,
        searchReceipts: [...(current.searchReceipts ?? []), receipt],
        updatedAt: new Date().toISOString(),
      });
      entries[index] = updated;
      return { entry: updated, outcome: "appended" as const };
    });
  }

  appendSearchSeries(
    plan: SeriesPreviewPlan,
    receipt: SearchReceipt,
    allowReplace: boolean,
  ) {
    return this.appendImportedSeries(plan, receipt, allowReplace);
  }

  patch(
    id: string,
    input: PatchEntry,
    cleanup?: SourceCleanup,
  ): Promise<LibraryEntry | undefined> {
    let previous: LibraryEntry | undefined;
    return this.update(
      async (entries) => {
        const index = entries.findIndex((entry) => entry.id === id);
        if (index === -1) return undefined;
        const current = entries[index];
        previous = current;
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
        for (const field of TITLE_METADATA_FIELDS)
          if (input[field] === null) delete candidate[field];
        if ("episodeOverrides" in input) {
          // Repairs are not part of the source definition: the cached
          // selection is stale, but source checks and probes still apply.
          if (!input.episodeOverrides?.length)
            delete candidate.episodeOverrides;
          delete candidate.inspectionCache;
        }
        if (input.extraSources) {
          candidate.extraSources = input.extraSources.map((source) => {
            const original = current.extraSources?.find(
              (existing) =>
                existing.magnetUri === source.magnetUri &&
                existing.torrentFilePath === source.torrentFilePath,
            );
            return {
              ...source,
              managedMedia: original?.managedMedia,
              searchImport: original?.searchImport,
              sourceHash: original?.sourceHash,
            };
          });
        }
        if (CACHE_INVALIDATING_FIELDS.some((field) => field in input)) {
          delete candidate.inspectionCache;
          delete candidate.directPlay;
          delete candidate.mediaFacts;
        }
        if (
          (
            [
              "magnetUri",
              "torrentFilePath",
              "localFilePath",
              "localFolderPath",
            ] as const
          ).some((field) => field in input && input[field] !== current[field])
        ) {
          delete candidate.searchImport;
          delete candidate.sourceHash;
          // File ids belong to the old source.
          delete candidate.watchStates;
          if (input.managedMedia === undefined) delete candidate.managedMedia;
        }
        const updated = libraryEntrySchema.parse(candidate);
        if (
          entrySourceDefinitionRevision(updated) !==
          entrySourceDefinitionRevision(current)
        )
          delete updated.sourceCheck;
        entries[index] = updated;
        return updated;
      },
      async (updated, remaining) => {
        if (updated && previous && cleanup) await cleanup(previous, remaining);
      },
    );
  }

  remove(id: string, cleanup?: SourceCleanup): Promise<boolean> {
    let previous: LibraryEntry | undefined;
    return this.update(
      async (entries) => {
        const index = entries.findIndex((entry) => entry.id === id);
        if (index === -1) return false;
        [previous] = entries.splice(index, 1);
        return true;
      },
      async (removed, remaining) => {
        if (removed && previous && cleanup) await cleanup(previous, remaining);
      },
    );
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

  setInspectionCache(
    id: string,
    cache: InspectionCache,
    expectedRevision?: string,
  ): Promise<void> {
    return this.update(async (entries) => {
      const index = entries.findIndex((entry) => entry.id === id);
      if (index === -1) return;
      if (
        expectedRevision !== undefined &&
        entrySourceRevision(entries[index]) !== expectedRevision
      )
        return;
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

  clearPlayback(id: string): Promise<void> {
    return this.update(async (entries) => {
      const index = entries.findIndex((entry) => entry.id === id);
      if (index === -1) return;
      const candidate: Record<string, unknown> = { ...entries[index] };
      delete candidate.playback;
      entries[index] = libraryEntrySchema.parse(candidate);
    });
  }

  // Records one file's watch state. "watched" is sticky: a later "started"
  // (a rewatch) keeps it, and only clearWatchState removes it. Resolves to
  // whether the stored state changed, so callers can skip side effects on a
  // no-op.
  setWatchState(
    id: string,
    fileId: number,
    state: WatchState["state"],
  ): Promise<boolean> {
    return this.update(async (entries) => {
      const index = entries.findIndex((entry) => entry.id === id);
      if (index === -1) return false;
      const current = entries[index];
      const existing = current.watchStates?.find(
        (item) => item.fileId === fileId,
      );
      if (existing?.state === "watched" || existing?.state === state)
        return false;
      const record: WatchState = {
        fileId,
        state,
        at: new Date().toISOString(),
      };
      entries[index] = libraryEntrySchema.parse({
        ...current,
        watchStates: [
          ...(current.watchStates ?? []).filter(
            (item) => item.fileId !== fileId,
          ),
          record,
        ],
      });
      return true;
    });
  }

  clearWatchState(id: string, fileId: number): Promise<boolean> {
    return this.update(async (entries) => {
      const index = entries.findIndex((entry) => entry.id === id);
      if (index === -1) return false;
      const current = entries[index];
      if (!current.watchStates?.some((item) => item.fileId === fileId))
        return false;
      const remaining = current.watchStates.filter(
        (item) => item.fileId !== fileId,
      );
      const candidate: Record<string, unknown> = {
        ...current,
        watchStates: remaining,
      };
      if (!remaining.length) delete candidate.watchStates;
      entries[index] = libraryEntrySchema.parse(candidate);
      return true;
    });
  }

  setDirectPlay(
    id: string,
    directPlay: DirectPlay,
    expectedDefinitionRevision?: string,
  ): Promise<void> {
    return this.update(async (entries) => {
      const index = entries.findIndex((entry) => entry.id === id);
      if (index === -1) return;
      if (
        expectedDefinitionRevision !== undefined &&
        entrySourceDefinitionRevision(entries[index]) !==
          expectedDefinitionRevision
      )
        return;
      entries[index] = libraryEntrySchema.parse({
        ...entries[index],
        directPlay,
      });
    });
  }

  setSourceCheck(
    id: string,
    check: SourceCheck | undefined,
    expectedRevision: string,
    expectedJobId?: string,
  ): Promise<boolean> {
    if (check) sourceCheckSchema.parse(check);
    return this.update(async (entries) => {
      const index = entries.findIndex((entry) => entry.id === id);
      if (
        index === -1 ||
        entrySourceDefinitionRevision(entries[index]) !== expectedRevision ||
        (expectedJobId !== undefined &&
          entries[index].sourceCheck?.jobId !== expectedJobId)
      )
        return false;
      const current = entries[index];
      const observed =
        check?.phase === "complete" &&
        check.outcome === "observed" &&
        check.fileId !== undefined &&
        check.filePath !== undefined &&
        check.fileLength !== undefined &&
        check.technical?.videoCodec &&
        (check.technical.decodedVideoFrames ?? 0) > 0;
      const fact =
        observed && check?.technical
          ? {
              revision: check.revision,
              jobId: check.jobId,
              fileId: check.fileId!,
              sourceHash: check.sourceHash,
              filePath: check.filePath!,
              fileLength: check.fileLength!,
              technical: check.technical,
              observedAt: check.updatedAt,
            }
          : undefined;
      entries[index] = libraryEntrySchema.parse({
        ...current,
        sourceCheck: check,
        ...(fact
          ? {
              mediaFacts: [
                ...(current.mediaFacts ?? []).filter(
                  (item) =>
                    item.revision === expectedRevision &&
                    item.fileId !== fact.fileId,
                ),
                fact,
              ],
              directPlay: {
                ...assessDirectPlay(fact.technical),
                probedAt: fact.observedAt,
              },
            }
          : {}),
      });
      return true;
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
    afterWrite?: (result: T, entries: LibraryEntry[]) => Promise<void>,
  ): Promise<T> {
    const operation = this.queue.then(async () => {
      // Mutations work on a copy so the cached array stays pristine until
      // the write lands.
      const entries = structuredClone(await this.read());
      const result = await change(entries);
      await this.write(entries);
      if (afterWrite) await afterWrite(result, entries);
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
