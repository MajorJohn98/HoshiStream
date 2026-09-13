import { createWriteStream } from "node:fs";
import { mkdir, rename, rm, stat, statfs } from "node:fs/promises";
import { dirname } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream as WebReadableStream } from "node:stream/web";
import { recentStreamActivity } from "./activity.ts";
import { describeWindow, type ArchiveSchedule } from "./archive-schedule.ts";
import {
  PARTIAL_SUFFIX,
  destinationPath,
  reconcileFiles,
  sourceKey,
} from "./disk-copy.ts";
import { planDiskPolicy, policyActive } from "./disk-policy.ts";
import { resolveStreamSource } from "./inspection.ts";
import type { Library } from "./library.ts";
import { activeStreamTargets } from "./playback-telemetry.ts";
import type { TorrServerClient } from "./torrserver-client.ts";
import type { DiskCopyFile, LibraryEntry } from "./types.ts";
import type { VolumeRegistry } from "./volumes.ts";

// Archive playback quality first: while streams are active the queue waits
// instead of competing for TorrServer's cache and the drive's bandwidth.
const PLAYBACK_YIELD_MS = 15_000;
// Waiting entries (drive offline, out of space) are re-checked periodically.
const WAKE_INTERVAL_MS = 60_000;
const HEADROOM_BYTES = 1 << 30;
const MAX_FILE_RETRIES = 3;
// While a file streams to disk, re-check that its volume is still there. An
// unplugged drive usually fails the write outright, but a slow or buffered
// loss should also stop the transfer within a few seconds.
const VOLUME_GUARD_MS = 5_000;

export interface ArchiverOptions {
  headroomBytes?: number;
  retryBaseMs?: number;
  playbackYieldMs?: number;
  wakeIntervalMs?: number;
  // Injectable for tests; defaults to recent stream activity.
  playbackActive?: () => boolean;
  // Files clients are streaming right now, which a policy must never evict.
  // Defaults to the telemetry's stream targets.
  streamingFiles?: () => { entryId: string; fileId: number }[];
  // Optional global download window: work outside it waits until the wake
  // cycle finds the window open.
  schedule?: ArchiveSchedule;
  // Called once per pass that landed at least one complete copy, so
  // follow-up work (episode thumbnails) can run against the new file.
  onEntryArchived?: (entryId: string) => void;
}

// Waiting reasons the queue distinguishes: drive loss is woken by volume
// polls, a user pause only by resume(); everything else by the wake timer.
export const WAITING_FOR_DRIVE = "Drive disconnected";
export const PAUSED = "Paused";

export interface DiskJobProgress {
  doneBytes: number;
  totalBytes: number;
  doneFiles: number;
  totalFiles: number;
}

export interface DiskJob {
  entryId: string;
  status: "queued" | "copying" | "waiting" | "paused";
  reason?: string;
  file?: { sourceKey: string; received: number; length: number };
  progress: DiskJobProgress;
}

function log(level: "info" | "warn", event: string, context: object): void {
  const line = JSON.stringify({ level, event, ...context });
  if (level === "warn") console.error(line);
  else console.log(line);
}

/**
 * Single-flight background copier: downloads included manifest files through
 * TorrServer's verified /play endpoint into `.partial` files, resuming with
 * Range from whatever bytes already exist, and renames to the final name only
 * after the size matches. Only durable file-state transitions are persisted;
 * everything else here is runtime state that reconstructs from disk facts.
 */
export class Archiver {
  private readonly pending: string[] = [];
  private readonly waiting = new Map<string, string>(); // entryId → reason
  private readonly generations = new Map<string, number>();
  private active?: {
    entryId: string;
    sourceKey: string;
    received: number;
    length: number;
    controller: AbortController;
  };
  // Bytes known to sit in .partial files, by sourceKey, so entry progress
  // counts interrupted transfers without stat()ing the drive on every poll.
  private readonly partialBytes = new Map<string, number>();
  private running = false;
  private closed = false;
  // Entry whose copy pass is running, and entries enqueued during their own
  // pass (a policy included more files) that must run once more after it.
  private processing?: string;
  private readonly requeued = new Set<string>();
  private wakeTimer?: NodeJS.Timeout;
  private settled: Promise<void> = Promise.resolve();

  private readonly headroomBytes: number;
  private readonly retryBaseMs: number;
  private readonly playbackYieldMs: number;
  private readonly wakeIntervalMs: number;
  private readonly playbackActive: () => boolean;
  private readonly streamingFiles: () => { entryId: string; fileId: number }[];
  private readonly schedule?: ArchiveSchedule;
  private readonly onEntryArchived?: (entryId: string) => void;
  private readonly library: Library;
  private readonly torrServer: TorrServerClient;
  private readonly volumes: VolumeRegistry;

  constructor(
    library: Library,
    torrServer: TorrServerClient,
    volumes: VolumeRegistry,
    options: ArchiverOptions = {},
  ) {
    this.library = library;
    this.torrServer = torrServer;
    this.volumes = volumes;
    this.headroomBytes = options.headroomBytes ?? HEADROOM_BYTES;
    this.retryBaseMs = options.retryBaseMs ?? 2_000;
    this.playbackYieldMs = options.playbackYieldMs ?? PLAYBACK_YIELD_MS;
    this.wakeIntervalMs = options.wakeIntervalMs ?? WAKE_INTERVAL_MS;
    this.playbackActive =
      options.playbackActive ?? (() => recentStreamActivity());
    this.streamingFiles =
      options.streamingFiles ?? (() => activeStreamTargets());
    this.schedule = options.schedule;
    this.onEntryArchived = options.onEntryArchived;
  }

  /**
   * "Scheduled HH:MM–HH:MM" when the download window is closed right now,
   * undefined when work may run. In-flight files finish; new work waits.
   */
  private async scheduledPause(): Promise<string | undefined> {
    if (!this.schedule || (await this.schedule.activeNow())) return undefined;
    const window = await this.schedule.window();
    return window ? `Scheduled ${describeWindow(window)}` : undefined;
  }

  /** Enqueue outstanding work found in the library (called at startup). */
  async start(): Promise<void> {
    const entries = await this.library.list().catch(() => []);
    for (const entry of entries) {
      if (!entry.diskCopy || entry.diskCopy.desired !== "keep") continue;
      // A rolling window may have moved while the app was down (watch
      // states are persisted; the plan is not).
      if (policyActive(entry.diskCopy.policy))
        await this.applyPolicy(entry.id).catch(() => undefined);
      const current = (await this.library.get(entry.id))?.diskCopy;
      if (!current) continue;
      if (this.hasOutstandingWork(current.files)) {
        if (current.paused) this.waiting.set(entry.id, PAUSED);
        else this.enqueue(entry.id);
      }
    }
    this.wakeTimer = setInterval(() => this.wake(), this.wakeIntervalMs);
    this.wakeTimer.unref();
  }

  enqueue(entryId: string): void {
    if (this.closed) return;
    this.waiting.delete(entryId);
    if (this.processing === entryId) {
      this.requeued.add(entryId);
      return;
    }
    if (!this.pending.includes(entryId)) this.pending.push(entryId);
    void this.run();
  }

  /**
   * Re-plan the entry's rolling window (Phase 8): include the next episodes
   * after `anchorFileId` (or the latest watched one), evict watched copies
   * once the window is on disk, persist, and queue any new work. Skips
   * paused entries and offline drives — eviction only ever happens against
   * a volume we can see. Never touches the anchor or a streaming file.
   */
  async applyPolicy(entryId: string, anchorFileId?: number): Promise<void> {
    if (this.closed) return;
    const entry = await this.library.get(entryId);
    const diskCopy = entry?.diskCopy;
    if (!entry || !diskCopy || diskCopy.desired !== "keep") return;
    if (diskCopy.paused || !policyActive(diskCopy.policy)) return;
    const cache = entry.inspectionCache;
    if (!cache) return;
    const protectedKeys = new Set<string>();
    for (const target of this.streamingFiles()) {
      if (target.entryId !== entryId) continue;
      const file = cache.selectedFiles.find((f) => f.id === target.fileId);
      if (file) protectedKeys.add(sourceKey(cache.hash, file));
    }
    if (this.active?.entryId === entryId)
      protectedKeys.add(this.active.sourceKey);
    const plan = planDiskPolicy(entry, { anchorFileId, protectedKeys });
    if (!plan.changed) return;
    let files = plan.files;
    if (plan.evict.length) {
      const resolution = await this.volumes.resolve(diskCopy.volumeId);
      if (resolution.state !== "online") {
        // Keep the copies included until the drive is back; the next
        // application (a watch event or the wake cycle) retries.
        const kept = new Set(plan.evict.map((file) => file.sourceKey));
        const original = new Map(
          diskCopy.files.map((file) => [file.sourceKey, file]),
        );
        files = files.map((file) =>
          kept.has(file.sourceKey) ? original.get(file.sourceKey)! : file,
        );
      } else {
        for (const file of plan.evict) {
          const destination = destinationPath(
            resolution.root,
            diskCopy.relativeDir,
            file.relativePath,
          );
          await rm(destination, { force: true });
          await rm(`${destination}${PARTIAL_SUFFIX}`, { force: true });
          this.partialBytes.delete(file.sourceKey);
          log("info", "disk_policy_evicted", {
            entryId,
            sourceKey: file.sourceKey,
          });
        }
      }
    }
    const current = (await this.library.get(entryId))?.diskCopy;
    if (!current || current.sourceRevision !== diskCopy.sourceRevision) return;
    await this.library.setDiskCopy(entryId, {
      ...current,
      files,
      updatedAt: new Date().toISOString(),
    });
    log("info", "disk_policy_applied", {
      entryId,
      added: plan.added.length,
      evicted: plan.evict.length,
    });
    if (plan.added.length) this.enqueue(entryId);
  }

  /** Stop this entry's transfer and keep it stopped until resume(). */
  async pause(entryId: string): Promise<boolean> {
    const entry = await this.library.get(entryId);
    if (!entry?.diskCopy || entry.diskCopy.desired !== "keep") return false;
    await this.library.setDiskCopy(entryId, {
      ...entry.diskCopy,
      paused: true,
      updatedAt: new Date().toISOString(),
    });
    this.cancel(entryId);
    if (this.hasOutstandingWork(entry.diskCopy.files))
      this.waiting.set(entryId, PAUSED);
    log("info", "disk_archive_paused", { entryId });
    return true;
  }

  async resume(entryId: string): Promise<boolean> {
    const entry = await this.library.get(entryId);
    if (!entry?.diskCopy || entry.diskCopy.desired !== "keep") return false;
    if (entry.diskCopy.paused) {
      const diskCopy = {
        ...entry.diskCopy,
        updatedAt: new Date().toISOString(),
      };
      delete diskCopy.paused;
      await this.library.setDiskCopy(entryId, diskCopy);
    }
    this.enqueue(entryId);
    log("info", "disk_archive_resumed", { entryId });
    return true;
  }

  private hasOutstandingWork(files: DiskCopyFile[]): boolean {
    return files.some(
      (file) =>
        file.included && (file.state === "missing" || file.state === "partial"),
    );
  }

  /** Invalidate any queued or in-flight work for the entry. */
  cancel(entryId: string): void {
    this.generations.set(entryId, this.generation(entryId) + 1);
    const index = this.pending.indexOf(entryId);
    if (index !== -1) this.pending.splice(index, 1);
    this.waiting.delete(entryId);
    if (this.active?.entryId === entryId) this.active.controller.abort();
  }

  async close(): Promise<void> {
    this.closed = true;
    if (this.wakeTimer) clearInterval(this.wakeTimer);
    this.pending.length = 0;
    this.active?.controller.abort();
    await this.settled;
  }

  /** Resolves when the current queue drain finishes (used by tests). */
  settle(): Promise<void> {
    return this.settled;
  }

  /** Runtime queue snapshot for the management UI, with entry progress. */
  async jobs(): Promise<DiskJob[]> {
    const jobs: DiskJob[] = [];
    const active = this.active;
    if (active) {
      jobs.push({
        entryId: active.entryId,
        status: "copying",
        file: {
          sourceKey: active.sourceKey,
          received: active.received,
          length: active.length,
        },
        progress: await this.progress(active.entryId),
      });
    }
    for (const entryId of this.pending) {
      if (entryId !== active?.entryId)
        jobs.push({
          entryId,
          status: "queued",
          progress: await this.progress(entryId),
        });
    }
    for (const [entryId, reason] of this.waiting) {
      jobs.push({
        entryId,
        status: reason === PAUSED ? "paused" : "waiting",
        reason,
        progress: await this.progress(entryId),
      });
    }
    return jobs;
  }

  /** The entry whose file is being copied right now, if any. */
  activeEntryId(): string | undefined {
    return this.active?.entryId;
  }

  /** Bytes and files done across the entry's included manifest. */
  async progress(entryId: string): Promise<DiskJobProgress> {
    const entry = await this.library.get(entryId);
    const files = (entry?.diskCopy?.files ?? []).filter((f) => f.included);
    let doneBytes = 0;
    let doneFiles = 0;
    for (const file of files) {
      if (file.state === "complete") {
        doneBytes += file.length;
        doneFiles += 1;
      } else if (this.active?.sourceKey === file.sourceKey) {
        doneBytes += this.active.received;
      } else {
        doneBytes += this.partialBytes.get(file.sourceKey) ?? 0;
      }
    }
    return {
      doneBytes,
      totalBytes: files.reduce((sum, file) => sum + file.length, 0),
      doneFiles,
      totalFiles: files.length,
    };
  }

  /**
   * Move waiting entries back into the queue. Without a filter every waiter
   * except user-paused ones is retried (the wake timer); with one, only
   * entries waiting for that reason — volume polls pass WAITING_FOR_DRIVE so
   * a reconnected drive resumes within seconds.
   */
  wake(onlyReason?: string): void {
    for (const [entryId, reason] of [...this.waiting]) {
      if (reason === PAUSED) continue;
      if (onlyReason && reason !== onlyReason) continue;
      this.enqueue(entryId);
    }
  }

  private generation(entryId: string): number {
    return this.generations.get(entryId) ?? 0;
  }

  private run(): Promise<void> {
    if (this.running) return this.settled;
    this.running = true;
    this.settled = (async () => {
      try {
        while (this.pending.length && !this.closed) {
          const entryId = this.pending[0];
          this.processing = entryId;
          try {
            await this.process(entryId);
          } catch (error) {
            log("warn", "disk_archive_failed", {
              entryId,
              error: error instanceof Error ? error.message : String(error),
            });
          } finally {
            this.processing = undefined;
          }
          const index = this.pending.indexOf(entryId);
          if (index !== -1) this.pending.splice(index, 1);
          if (this.requeued.delete(entryId) && !this.closed)
            this.pending.push(entryId);
        }
      } finally {
        this.running = false;
      }
    })();
    return this.settled;
  }

  private async process(entryId: string): Promise<void> {
    const generation = this.generation(entryId);
    const entry = await this.library.get(entryId);
    const diskCopy = entry?.diskCopy;
    if (!entry || !diskCopy || diskCopy.desired !== "keep") return;
    if (diskCopy.paused) {
      this.waiting.set(entryId, PAUSED);
      return;
    }
    const scheduled = await this.scheduledPause();
    if (scheduled) {
      this.waiting.set(entryId, scheduled);
      return;
    }
    const resolution = await this.volumes.resolve(diskCopy.volumeId);
    if (resolution.state !== "online") {
      this.waiting.set(entryId, WAITING_FOR_DRIVE);
      log("info", "disk_archive_waiting", {
        entryId,
        state: resolution.state,
      });
      return;
    }
    // Adopt whatever the drive already has before transferring anything.
    const reconciled = await reconcileFiles(
      resolution.root,
      diskCopy.relativeDir,
      diskCopy.files,
    );
    if (reconciled.changed) {
      await this.persistFiles(
        entryId,
        diskCopy.sourceRevision,
        reconciled.files,
      );
    }
    // Re-read the manifest before each file: a policy may include more
    // episodes while this pass runs, and a selection change may drop some.
    const attempted = new Set<string>();
    let landed = 0;
    for (;;) {
      if (this.cancelled(entryId, generation) || this.closed) break;
      const current = (await this.library.get(entryId))?.diskCopy;
      if (!current || current.sourceRevision !== diskCopy.sourceRevision)
        return;
      const file = current.files.find(
        (candidate) =>
          candidate.included &&
          (candidate.state === "missing" || candidate.state === "partial") &&
          !attempted.has(candidate.sourceKey),
      );
      if (!file) break;
      attempted.add(file.sourceKey);
      const outcome = await this.copyFile(entryId, generation, file);
      if (outcome === "stop") break;
      if (outcome === "complete") landed += 1;
      await this.persistFiles(entryId, diskCopy.sourceRevision, [
        { ...file, state: outcome },
      ]);
      log(outcome === "complete" ? "info" : "warn", "disk_archive_file", {
        entryId,
        sourceKey: file.sourceKey,
        state: outcome,
      });
    }
    if (landed) this.onEntryArchived?.(entryId);
    if (this.cancelled(entryId, generation) || this.closed) return;
    // The window just landed on disk: watched copies behind it may go now.
    if (policyActive(diskCopy.policy)) await this.applyPolicy(entryId);
  }

  private async copyFile(
    entryId: string,
    generation: number,
    file: DiskCopyFile,
  ): Promise<DiskCopyFile["state"] | "stop"> {
    for (let attempt = 0; ; attempt += 1) {
      if (this.cancelled(entryId, generation) || this.closed) return "stop";
      const scheduled = await this.scheduledPause();
      if (scheduled) {
        this.waiting.set(entryId, scheduled);
        return "stop";
      }
      while (this.playbackActive()) {
        await delay(this.playbackYieldMs);
        if (this.cancelled(entryId, generation) || this.closed) return "stop";
      }
      const entry = await this.library.get(entryId);
      const diskCopy = entry?.diskCopy;
      if (!entry || !diskCopy || diskCopy.desired !== "keep") return "stop";
      if (diskCopy.paused) {
        this.waiting.set(entryId, PAUSED);
        return "stop";
      }
      const resolution = await this.volumes.resolve(diskCopy.volumeId);
      if (resolution.state !== "online") {
        this.waiting.set(entryId, WAITING_FOR_DRIVE);
        return "stop";
      }
      const destination = destinationPath(
        resolution.root,
        diskCopy.relativeDir,
        file.relativePath,
      );
      const partial = `${destination}${PARTIAL_SUFFIX}`;
      const offset = (await stat(partial).catch(() => undefined))?.size ?? 0;
      this.partialBytes.set(file.sourceKey, offset);
      const space = await statfs(resolution.root).catch(() => undefined);
      const free = space ? space.bavail * space.bsize : 0;
      if (free < file.length - offset + this.headroomBytes) {
        this.waiting.set(entryId, "Out of space");
        log("warn", "disk_archive_out_of_space", {
          entryId,
          requiredBytes: file.length - offset,
          freeBytes: free,
        });
        return "stop";
      }
      try {
        const state = await this.transfer(
          entry,
          file,
          { destination, partial, offset },
          diskCopy.volumeId,
        );
        if (state === "complete") this.partialBytes.delete(file.sourceKey);
        return state;
      } catch (error) {
        // Whatever landed before the interruption is resumable and counts.
        if (this.active?.sourceKey === file.sourceKey)
          this.partialBytes.set(file.sourceKey, this.active.received);
        if (this.cancelled(entryId, generation) || this.closed) return "stop";
        // Drive loss pauses without consuming the retry budget; the volume
        // poll wakes the entry when the drive is back.
        if (
          (await this.volumes.resolve(diskCopy.volumeId)).state !== "online"
        ) {
          this.waiting.set(entryId, WAITING_FOR_DRIVE);
          return "stop";
        }
        if (attempt >= MAX_FILE_RETRIES) {
          log("warn", "disk_archive_retries_exhausted", {
            entryId,
            sourceKey: file.sourceKey,
            error: error instanceof Error ? error.message : String(error),
          });
          // Bytes on disk stay resumable; the wake cycle tries again later.
          this.waiting.set(entryId, "Source unavailable");
          return "stop";
        }
        await delay(this.retryBaseMs * 2 ** attempt);
      } finally {
        this.active = undefined;
      }
    }
  }

  private async transfer(
    entry: LibraryEntry,
    file: DiskCopyFile,
    target: { destination: string; partial: string; offset: number },
    volumeId?: string,
  ): Promise<DiskCopyFile["state"]> {
    const source = await resolveStreamSource(
      entry,
      this.torrServer,
      this.library,
    );
    const selected = source.selectedFiles.find(
      (candidate) => sourceKey(source.hash, candidate) === file.sourceKey,
    );
    if (!selected) {
      // The selection changed underneath the manifest (stale revision); a
      // retry/reconcile rebuilds it.
      return "invalid";
    }
    const controller = new AbortController();
    this.active = {
      entryId: entry.id,
      sourceKey: file.sourceKey,
      received: target.offset,
      length: file.length,
      controller,
    };
    const response = await fetch(
      this.torrServer.streamUrl(source.hash, selected),
      {
        headers: target.offset ? { range: `bytes=${target.offset}-` } : {},
        signal: controller.signal,
      },
    );
    if (!response.ok || !response.body) {
      throw new Error(`Stream request failed: ${response.status}`);
    }
    // A 200 to a ranged request means the server restarted from byte zero.
    const resumed = response.status === 206 && target.offset > 0;
    if (!resumed && this.active) this.active.received = 0;
    await mkdir(dirname(target.partial), { recursive: true });
    const active = this.active;
    const counter = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        if (active) active.received += chunk.length;
        callback(null, chunk);
      },
    });
    const guard = volumeId
      ? setInterval(() => {
          void this.volumes.resolve(volumeId).then((resolution) => {
            if (resolution.state !== "online")
              controller.abort(new Error("Drive disconnected"));
          });
        }, VOLUME_GUARD_MS)
      : undefined;
    guard?.unref();
    try {
      await pipeline(
        Readable.fromWeb(response.body as WebReadableStream),
        counter,
        createWriteStream(target.partial, { flags: resumed ? "a" : "w" }),
      );
    } finally {
      if (guard) clearInterval(guard);
    }
    const written = await stat(target.partial);
    if (written.size === file.length) {
      // The only transition to complete: verified size, then atomic rename.
      await rename(target.partial, target.destination);
      return "complete";
    }
    if (written.size > file.length) return "invalid";
    throw new Error(
      `Transfer ended early: ${written.size} of ${file.length} bytes`,
    );
  }

  private cancelled(entryId: string, generation: number): boolean {
    return this.generation(entryId) !== generation;
  }

  /**
   * Persist file-state transitions by source key into whatever manifest is
   * current, leaving inclusion (a concurrent policy or selection write) as
   * it is. A changed source revision means another writer owns the manifest.
   */
  private async persistFiles(
    entryId: string,
    sourceRevision: string,
    updates: DiskCopyFile[],
  ): Promise<void> {
    const entry = await this.library.get(entryId);
    const diskCopy = entry?.diskCopy;
    if (!diskCopy || diskCopy.sourceRevision !== sourceRevision) return;
    const states = new Map(
      updates.map((file) => [file.sourceKey, file.state] as const),
    );
    const files = diskCopy.files.map((file) => {
      const state = states.get(file.sourceKey);
      return state === undefined || state === file.state
        ? file
        : { ...file, state };
    });
    await this.library.setDiskCopy(entryId, {
      ...diskCopy,
      files,
      updatedAt: new Date().toISOString(),
    });
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
