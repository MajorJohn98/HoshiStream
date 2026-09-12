// Per-stream runway telemetry: while a client is streaming a torrent entry,
// sample TorrServer's cache window every few seconds and derive how many
// seconds of playback are already cached ahead of the playhead, and whether
// the swarm is keeping up with the file's bitrate. Observation only — nothing
// here changes what the player receives. Everything stays in memory.
import { markStreamActivity, recentEntryActivity } from "./activity.ts";
import type { CacheState, TorrServerClient } from "./torrserver-client.ts";

export const SAMPLE_INTERVAL_MS = 2_000;
export const RING_SIZE = 60;
export const LOW_RUNWAY_SECONDS = 10;
export const WARN_INTERVAL_MS = 30_000;
// The swarm must beat the bitrate by this factor before we call it sustained;
// anything closer leaves no room for peer churn.
export const SUSTAIN_MARGIN = 1.2;

export interface StreamTarget {
  entryId: string;
  hash: string;
  fileId: number;
  title: string;
  bitrateMbps?: number;
}

export interface PlaybackSample {
  at: string;
  readers: number;
  aheadBytes: number;
  runwaySeconds: number | null;
  downloadMbps: number;
  bitrateMbps: number | null;
  sustainable: boolean | null;
  activePeers: number;
  filledBytes: number;
  capacityBytes: number;
}

export interface StreamTelemetry extends StreamTarget {
  samples: PlaybackSample[];
  latest: PlaybackSample | null;
}

// Contiguous completed bytes from the reader's current piece to the end of
// its read-ahead window — the runway. The first incomplete piece ends it: a
// completed piece beyond a gap does not help a player that stalls on the gap.
// With several readers the shortest runway is the one that stalls first.
export function bytesAhead(cache: CacheState): number {
  if (!cache.readers.length) return 0;
  let shortest = Number.POSITIVE_INFINITY;
  for (const reader of cache.readers) {
    let pieces = 0;
    for (let index = reader.readerPiece; index <= reader.endPiece; index += 1) {
      if (!cache.completed.get(index)) break;
      pieces += 1;
    }
    shortest = Math.min(shortest, pieces * cache.pieceLength);
  }
  return Number.isFinite(shortest) ? shortest : 0;
}

export function sampleFrom(
  cache: CacheState,
  bitrateMbps: number | undefined,
  now: number,
): PlaybackSample {
  const aheadBytes = bytesAhead(cache);
  const downloadMbps = (cache.downloadSpeedBps * 8) / 1_000_000;
  const bitrate = bitrateMbps && bitrateMbps > 0 ? bitrateMbps : null;
  return {
    at: new Date(now).toISOString(),
    readers: cache.readers.length,
    aheadBytes,
    runwaySeconds:
      bitrate === null
        ? null
        : Number((aheadBytes / ((bitrate * 1_000_000) / 8)).toFixed(1)),
    downloadMbps: Number(downloadMbps.toFixed(2)),
    bitrateMbps: bitrate,
    sustainable:
      bitrate === null ? null : downloadMbps >= bitrate * SUSTAIN_MARGIN,
    activePeers: cache.activePeers,
    filledBytes: cache.filled,
    capacityBytes: cache.capacity,
  };
}

// Targets are registered by the stream handler (which knows entry, hash,
// file and bitrate) and read by the sampler, so they live at module level
// like the activity markers.
const targets = new Map<string, StreamTarget>();

export function noteStreamTarget(target: StreamTarget): void {
  targets.set(target.entryId, target);
}

export function activeStreamTargets(now = Date.now()): StreamTarget[] {
  const active: StreamTarget[] = [];
  for (const [entryId, target] of targets) {
    if (recentEntryActivity(entryId, now) === "streaming") active.push(target);
    else targets.delete(entryId);
  }
  return active;
}

// For tests.
export function resetStreamTargets(): void {
  targets.clear();
}

export interface PlaybackTelemetryOptions {
  intervalMs?: number;
  ringSize?: number;
  lowRunwaySeconds?: number;
  warnIntervalMs?: number;
  now?: () => number;
  log?: (line: string) => void;
}

export class PlaybackTelemetry {
  readonly #torrServer: TorrServerClient;
  readonly #intervalMs: number;
  readonly #ringSize: number;
  readonly #lowRunwaySeconds: number;
  readonly #warnIntervalMs: number;
  readonly #now: () => number;
  readonly #log: (line: string) => void;
  readonly #samples = new Map<string, PlaybackSample[]>();
  readonly #lastWarned = new Map<string, number>();
  #timer: NodeJS.Timeout | undefined;
  #sampling = false;

  constructor(
    torrServer: TorrServerClient,
    options: PlaybackTelemetryOptions = {},
  ) {
    this.#torrServer = torrServer;
    this.#intervalMs = options.intervalMs ?? SAMPLE_INTERVAL_MS;
    this.#ringSize = options.ringSize ?? RING_SIZE;
    this.#lowRunwaySeconds = options.lowRunwaySeconds ?? LOW_RUNWAY_SECONDS;
    this.#warnIntervalMs = options.warnIntervalMs ?? WARN_INTERVAL_MS;
    this.#now = options.now ?? Date.now;
    this.#log = options.log ?? ((line) => console.error(line));
  }

  start(): void {
    if (this.#timer) return;
    this.#timer = setInterval(() => void this.sample(), this.#intervalMs);
    this.#timer.unref();
  }

  stop(): void {
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = undefined;
  }

  /** One sampling pass over every entry a client is currently streaming. */
  async sample(now = this.#now()): Promise<void> {
    if (this.#sampling) return;
    this.#sampling = true;
    try {
      const active = activeStreamTargets(now);
      const activeIds = new Set(active.map((target) => target.entryId));
      for (const entryId of this.#samples.keys())
        if (!activeIds.has(entryId)) {
          this.#samples.delete(entryId);
          this.#lastWarned.delete(entryId);
        }
      await Promise.all(
        active.map((target) => this.#sampleTarget(target, now)),
      );
    } finally {
      this.#sampling = false;
    }
  }

  report(now = this.#now()): StreamTelemetry[] {
    return activeStreamTargets(now).map((target) => {
      const samples = this.#samples.get(target.entryId) ?? [];
      return { ...target, samples, latest: samples.at(-1) ?? null };
    });
  }

  async #sampleTarget(target: StreamTarget, now: number): Promise<void> {
    let cache: CacheState | undefined;
    try {
      cache = await this.#torrServer.cacheState(target.hash);
    } catch {
      // TorrServer dropped the torrent or is busy; the ring keeps its
      // last samples and the next tick tries again.
      return;
    }
    if (!cache) return;
    const sample = sampleFrom(cache, target.bitrateMbps, now);
    // Playback goes straight to TorrServer, so the stream request is the
    // add-on's only direct signal and it ages out after a few minutes. An
    // open reader means a player is still pulling bytes: keep the entry
    // counted as streaming (and this target sampled) until readers drop.
    if (sample.readers > 0) markStreamActivity(now, target.entryId);
    const ring = this.#samples.get(target.entryId) ?? [];
    ring.push(sample);
    if (ring.length > this.#ringSize)
      ring.splice(0, ring.length - this.#ringSize);
    this.#samples.set(target.entryId, ring);
    this.#maybeWarn(target, sample, now);
  }

  #maybeWarn(target: StreamTarget, sample: PlaybackSample, now: number): void {
    if (
      sample.readers === 0 ||
      sample.runwaySeconds === null ||
      sample.runwaySeconds >= this.#lowRunwaySeconds
    )
      return;
    const last = this.#lastWarned.get(target.entryId) ?? 0;
    if (last && now - last < this.#warnIntervalMs) return;
    this.#lastWarned.set(target.entryId, now);
    this.#log(
      JSON.stringify({
        level: "warn",
        event: "playback_sample",
        entryId: target.entryId,
        fileId: target.fileId,
        runwaySeconds: sample.runwaySeconds,
        aheadBytes: sample.aheadBytes,
        downloadMbps: sample.downloadMbps,
        bitrateMbps: sample.bitrateMbps,
        activePeers: sample.activePeers,
        readers: sample.readers,
      }),
    );
  }
}
