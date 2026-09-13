// Watched state (plans/2026-09-13-watched-state-plan.md): which files a
// viewer has started or finished, derived from observed reads rather than
// from player reports — external Stremio clients never send a position.
import { inspectLocalEntry } from "./local-media.ts";
import type { Library } from "./library.ts";
import { rawFileId, type SelectedFile } from "./media-file-selection.ts";
import type { TorrServerClient } from "./torrserver-client.ts";
import type { LibraryEntry, WatchState } from "./types.ts";

// A read this far into the file counts as having watched it.
export const WATCHED_FRACTION = 0.9;
// Players read the tail at open time (MKV cues, MP4 moov); only a late read
// near the end means the viewer actually got there.
export const WATCHED_MIN_ELAPSED_MS = 60_000;
// Observations for a file nobody has touched this long are forgotten, so a
// replay weeks later starts the 60 s clock again.
export const OBSERVATION_TTL_MS = 30 * 60_000;

export function watchStateFor(
  entry: Pick<LibraryEntry, "watchStates">,
  fileId: number,
): WatchState | undefined {
  return entry.watchStates?.find((item) => item.fileId === fileId);
}

// Files the watched state refers to: the cached torrent selection, or the
// current local scan (cached in local-media.ts) for local entries. Empty
// when the entry has never been inspected.
export async function watchableFiles(
  entry: LibraryEntry,
): Promise<SelectedFile[]> {
  if (entry.localFilePath || entry.localFolderPath)
    return (await inspectLocalEntry(entry))?.selectedFiles ?? [];
  return entry.inspectionCache?.selectedFiles ?? [];
}

function episodeOrder(a: SelectedFile, b: SelectedFile): number {
  return (
    (a.season ?? 0) - (b.season ?? 0) ||
    (a.episode ?? 0) - (b.episode ?? 0) ||
    a.id - b.id
  );
}

// Where playback should pick up: the most recently started file; else the
// first unwatched file after the last watched one; else the first unwatched
// file. Undefined when nothing has been watched or everything has.
export function resumeFile(
  entry: Pick<LibraryEntry, "watchStates">,
  files: readonly SelectedFile[],
): SelectedFile | undefined {
  const states = entry.watchStates ?? [];
  if (!states.length || !files.length) return undefined;
  const ordered = [...files].sort(episodeOrder);
  const stateOf = new Map(states.map((state) => [state.fileId, state]));
  const started = states
    .filter(
      (state) =>
        state.state === "started" && ordered.some((f) => f.id === state.fileId),
    )
    .sort((a, b) => b.at.localeCompare(a.at))[0];
  if (started) return ordered.find((file) => file.id === started.fileId);
  let lastWatched = -1;
  ordered.forEach((file, index) => {
    if (stateOf.get(file.id)?.state === "watched") lastWatched = index;
  });
  if (lastWatched === -1) return undefined;
  const unwatched = (file: SelectedFile) =>
    stateOf.get(file.id)?.state !== "watched";
  return (
    ordered.slice(lastWatched + 1).find(unwatched) ?? ordered.find(unwatched)
  );
}

// Most recent watch activity, for ordering Continue Watching.
export function lastWatchActivity(
  entry: Pick<LibraryEntry, "watchStates">,
): number {
  let latest = 0;
  for (const state of entry.watchStates ?? [])
    latest = Math.max(latest, Date.parse(state.at) || 0);
  return latest;
}

export interface WatchSink {
  started(entryId: string, fileId: number): Promise<unknown>;
  watched(entryId: string, fileId: number): Promise<unknown>;
}

// Turns observed reads (reader position, Range start, player time) into
// started/watched events. In memory only; the library holds the result.
export class WatchProgress {
  readonly #sink: WatchSink;
  readonly #fraction: number;
  readonly #minElapsedMs: number;
  readonly #ttlMs: number;
  readonly #seen = new Map<
    string,
    { first: number; last: number; watched: boolean }
  >();

  constructor(
    sink: WatchSink,
    options: { fraction?: number; minElapsedMs?: number; ttlMs?: number } = {},
  ) {
    this.#sink = sink;
    this.#fraction = options.fraction ?? WATCHED_FRACTION;
    this.#minElapsedMs = options.minElapsedMs ?? WATCHED_MIN_ELAPSED_MS;
    this.#ttlMs = options.ttlMs ?? OBSERVATION_TTL_MS;
  }

  /** One observed read at `fraction` (0–1) of the file. */
  observe(
    entryId: string,
    fileId: number,
    fraction: number,
    now = Date.now(),
  ): void {
    if (!Number.isFinite(fraction)) return;
    this.#prune(now);
    const key = `${entryId}\u0000${fileId}`;
    let record = this.#seen.get(key);
    if (!record) {
      record = { first: now, last: now, watched: false };
      this.#seen.set(key, record);
      void this.#sink.started(entryId, fileId).catch(() => undefined);
    }
    record.last = now;
    if (
      !record.watched &&
      fraction >= this.#fraction &&
      now - record.first >= this.#minElapsedMs
    ) {
      record.watched = true;
      void this.#sink.watched(entryId, fileId).catch(() => undefined);
    }
  }

  #prune(now: number): void {
    for (const [key, record] of this.#seen)
      if (now - record.last > this.#ttlMs) this.#seen.delete(key);
  }
}

// Position of a Range request as a fraction of the file, for the routes
// that serve local and disk-copy files themselves. Undefined for whole-file
// or malformed ranges.
export function rangeFraction(
  header: string | undefined,
  length: number,
): number | undefined {
  if (!header || length <= 0) return undefined;
  const match = /^bytes=(\d+)-/.exec(header.trim());
  if (!match) return undefined;
  return Math.min(1, Number(match[1]) / length);
}

// Persists watch state and keeps TorrServer's own viewed marks in step, so
// its web UI agrees with the add-on. TorrServer failures are logged, never
// surfaced: the library is the source of truth.
export class WatchStates implements WatchSink {
  readonly #library: Library;
  readonly #torrServer: TorrServerClient;
  readonly #log: (line: string) => void;

  constructor(
    library: Library,
    torrServer: TorrServerClient,
    log: (line: string) => void = (line) => console.error(line),
  ) {
    this.#library = library;
    this.#torrServer = torrServer;
    this.#log = log;
  }

  started(entryId: string, fileId: number): Promise<boolean> {
    return this.#library.setWatchState(entryId, fileId, "started");
  }

  async watched(entryId: string, fileId: number): Promise<boolean> {
    const changed = await this.#library.setWatchState(
      entryId,
      fileId,
      "watched",
    );
    if (changed) await this.#syncViewed(entryId, fileId, "set");
    return changed;
  }

  async clear(entryId: string, fileId: number): Promise<boolean> {
    const changed = await this.#library.clearWatchState(entryId, fileId);
    if (changed) await this.#syncViewed(entryId, fileId, "rem");
    return changed;
  }

  async #syncViewed(
    entryId: string,
    fileId: number,
    action: "set" | "rem",
  ): Promise<void> {
    const entry = await this.#library.get(entryId);
    const cache = entry?.inspectionCache;
    const file = cache?.selectedFiles.find((item) => item.id === fileId);
    if (!cache || !file) return;
    const hash = file.hash ?? cache.hash;
    try {
      if (action === "set")
        await this.#torrServer.setViewed(hash, rawFileId(fileId));
      else await this.#torrServer.removeViewed(hash, rawFileId(fileId));
    } catch (error) {
      this.#log(
        JSON.stringify({
          level: "warn",
          event: "viewed_sync_failed",
          entryId,
          fileId,
          action,
          error: error instanceof Error ? error.message : String(error),
        }),
      );
    }
  }
}
