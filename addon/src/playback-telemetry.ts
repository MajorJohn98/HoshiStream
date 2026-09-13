// Per-stream runway telemetry: while a client is streaming a torrent entry,
// sample TorrServer's cache window every few seconds and derive how many
// seconds of playback are already cached ahead of the playhead, and whether
// the swarm is keeping up with the file's bitrate. Observation only — nothing
// here changes what the player receives. Everything stays in memory.
import { markStreamActivity, recentEntryActivity } from "./activity.ts";
import { directPlayForFile } from "./media-facts.ts";
import { rawFileId } from "./media-file-selection.ts";
import type { SelectedFile } from "./media-file-selection.ts";
import type {
  CacheState,
  TorrentStatus,
  TorrServerClient,
} from "./torrserver-client.ts";
import type { LibraryEntry } from "./types.ts";

export const SAMPLE_INTERVAL_MS = 2_000;
export const RING_SIZE = 60;
export const LOW_RUNWAY_SECONDS = 10;
export const WARN_INTERVAL_MS = 30_000;
// The swarm must beat the bitrate by this factor before we call it sustained;
// anything closer leaves no room for peer churn.
export const SUSTAIN_MARGIN = 1.2;
// How long the hash → entry index is reused before re-reading the library.
export const OWNER_INDEX_TTL_MS = 15_000;
export const LIST_FAILURE_LOG_INTERVAL_MS = 300_000;

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
  // A first-play probe is measuring this file's bitrate right now.
  probing: boolean;
}

// Probes files whose bitrate is unknown while they stream (playback-probes.ts).
export interface StreamProber {
  ensure(target: StreamTarget): void;
  pending(target: Pick<StreamTarget, "entryId" | "fileId">): boolean;
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

// A probe finished after the target was noted; later samples use the figure.
export function setStreamTargetBitrate(
  target: Pick<StreamTarget, "entryId" | "fileId">,
  bitrateMbps: number,
): void {
  const current = targets.get(target.entryId);
  if (current && current.fileId === target.fileId)
    current.bitrateMbps = bitrateMbps;
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

// The torrent file a reader is inside, from the byte offset of its current
// piece. TorrServer lists file_stats in torrent order, so offsets accumulate.
export function fileAtPiece(
  files: TorrentStatus["file_stats"],
  piece: number,
  pieceLength: number,
): TorrentStatus["file_stats"][number] | undefined {
  const byte = piece * pieceLength;
  let offset = 0;
  for (const file of files) {
    if (byte >= offset && byte < offset + file.length) return file;
    offset += file.length;
  }
  return files.at(-1);
}

// The library file the reader is inside. Extra-source files carry composite
// ids; TorrServer's are raw.
function selectedFileFor(
  entry: LibraryEntry,
  hash: string,
  torrentFile: TorrentStatus["file_stats"][number] | undefined,
): SelectedFile | undefined {
  if (!torrentFile) return undefined;
  return entry.inspectionCache?.selectedFiles.find(
    (file) =>
      rawFileId(file.id) === torrentFile.id &&
      (file.hash ?? entry.inspectionCache?.hash)?.toLowerCase() ===
        hash.toLowerCase(),
  );
}

// Which of several entries sharing a torrent to credit with the stream: the
// one the add-on already saw stream, else one with a bitrate for the file
// being read, else the most recently streamed.
export function pickOwner(
  candidates: readonly LibraryEntry[],
  hash: string,
  torrentFile: TorrentStatus["file_stats"][number] | undefined,
  now: number,
): { entry: LibraryEntry; selected: SelectedFile | undefined } {
  const resolved = candidates.map((entry) => ({
    entry,
    selected: selectedFileFor(entry, hash, torrentFile),
  }));
  const streaming = resolved.find(
    ({ entry }) => recentEntryActivity(entry.id, now) === "streaming",
  );
  if (streaming) return streaming;
  const analyzed = resolved.find(
    ({ entry, selected }) =>
      selected && directPlayForFile(entry, selected, hash) !== undefined,
  );
  if (analyzed) return analyzed;
  return resolved.reduce((best, item) =>
    Date.parse(item.entry.lastStreamedAt ?? "") >
    Date.parse(best.entry.lastStreamedAt ?? "")
      ? item
      : best,
  );
}

export interface PlaybackTelemetryOptions {
  // Library lookup for discovering streams the add-on never handed out: a
  // client that cached the stream URL plays straight from TorrServer.
  entries?: () => Promise<LibraryEntry[]>;
  probes?: StreamProber;
  intervalMs?: number;
  ringSize?: number;
  lowRunwaySeconds?: number;
  warnIntervalMs?: number;
  now?: () => number;
  log?: (line: string) => void;
}

export class PlaybackTelemetry {
  readonly #torrServer: TorrServerClient;
  readonly #entries: (() => Promise<LibraryEntry[]>) | undefined;
  readonly #probes: StreamProber | undefined;
  readonly #intervalMs: number;
  readonly #ringSize: number;
  readonly #lowRunwaySeconds: number;
  readonly #warnIntervalMs: number;
  readonly #now: () => number;
  readonly #log: (line: string) => void;
  readonly #samples = new Map<string, PlaybackSample[]>();
  readonly #lastWarned = new Map<string, number>();
  #owners: { at: number; index: Map<string, LibraryEntry[]> } | undefined;
  #lastListFailure = 0;
  #timer: NodeJS.Timeout | undefined;
  #sampling = false;

  constructor(
    torrServer: TorrServerClient,
    options: PlaybackTelemetryOptions = {},
  ) {
    this.#torrServer = torrServer;
    this.#entries = options.entries;
    this.#probes = options.probes;
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
      await this.#discover(now);
      const active = activeStreamTargets(now);
      const activeIds = new Set(active.map((target) => target.entryId));
      for (const entryId of this.#samples.keys())
        if (!activeIds.has(entryId)) {
          this.#samples.delete(entryId);
          this.#lastWarned.delete(entryId);
        }
      if (this.#probes)
        for (const target of active)
          if (target.bitrateMbps === undefined) this.#probes.ensure(target);
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
      return {
        ...target,
        samples,
        latest: samples.at(-1) ?? null,
        probing: this.#probes?.pending(target) ?? false,
      };
    });
  }

  // Working torrents owned by a library entry that have an open reader but
  // no target yet: the player went to TorrServer without asking us for the
  // stream (cached URL, resumed playback, restarted add-on).
  async #discover(now: number): Promise<void> {
    if (!this.#entries) return;
    let torrents: TorrentStatus[];
    try {
      torrents = await this.#torrServer.list();
    } catch (error) {
      // Discovery is best-effort, but a persistent failure here hides every
      // stream the add-on did not hand out — say so, without flooding.
      if (now - this.#lastListFailure >= LIST_FAILURE_LOG_INTERVAL_MS) {
        this.#lastListFailure = now;
        this.#log(
          JSON.stringify({
            level: "warn",
            event: "playback_discovery_failed",
            error: error instanceof Error ? error.message : String(error),
          }),
        );
      }
      return;
    }
    const known = new Set(
      activeStreamTargets(now).map((target) => target.hash.toLowerCase()),
    );
    // stat 3 = TorrentWorking (MatriX state.go).
    const candidates = torrents.filter(
      (torrent) => torrent.stat === 3 && !known.has(torrent.hash.toLowerCase()),
    );
    if (!candidates.length) return;
    const owners = await this.#ownerIndex(now);
    if (!owners) return;
    await Promise.all(
      candidates.map(async (torrent) => {
        const candidates = owners.get(torrent.hash.toLowerCase());
        if (!candidates?.length) return;
        let cache: CacheState | undefined;
        try {
          cache = await this.#torrServer.cacheState(torrent.hash);
        } catch {
          return;
        }
        const reader = cache?.readers[0];
        if (!cache || !reader) return;
        const torrentFile = fileAtPiece(
          torrent.file_stats,
          reader.readerPiece,
          cache.pieceLength,
        );
        const { entry, selected } = pickOwner(
          candidates,
          torrent.hash,
          torrentFile,
          now,
        );
        markStreamActivity(now, entry.id);
        noteStreamTarget({
          entryId: entry.id,
          hash: torrent.hash,
          fileId: selected?.id ?? torrentFile?.id ?? 0,
          title: entry.name,
          bitrateMbps: selected
            ? directPlayForFile(entry, selected, torrent.hash)?.bitrateMbps
            : undefined,
        });
      }),
    );
  }

  async #ownerIndex(
    now: number,
  ): Promise<Map<string, LibraryEntry[]> | undefined> {
    if (this.#owners && now - this.#owners.at < OWNER_INDEX_TTL_MS)
      return this.#owners.index;
    if (!this.#entries) return undefined;
    let entries: LibraryEntry[];
    try {
      entries = await this.#entries();
    } catch {
      return undefined;
    }
    // Several entries may share one torrent; keep every owner so discovery
    // can credit the one that is actually being watched.
    const index = new Map<string, LibraryEntry[]>();
    for (const entry of entries) {
      const cache = entry.inspectionCache;
      if (!cache) continue;
      const hashes = new Set([cache.hash.toLowerCase()]);
      for (const file of cache.selectedFiles)
        if (file.hash) hashes.add(file.hash.toLowerCase());
      for (const hash of hashes) {
        const list = index.get(hash) ?? [];
        list.push(entry);
        index.set(hash, list);
      }
    }
    this.#owners = { at: now, index };
    return index;
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
