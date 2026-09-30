// Pre-add stream tests (decision 0029): an owner-triggered measurement of
// whether a torrent keeps up with its own bitrate on this host, before it is
// saved. A test registers the torrent with TorrServer (memory only), waits
// for its file list, then reads the chosen file from byte 0 as a player
// filling its buffer would, while it samples TorrServer's swarm figures and
// probes the bitrate. Results stay in memory for a few minutes.
import { randomUUID } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { beginStreamTest, lastStreamActivityAt } from "./activity.ts";
import type { AnalysisSlot } from "./analysis-slot.ts";
import { ImportError } from "./imports/errors.ts";
import {
  entryHasHash,
  magnetIdentity,
  MAX_TORRENT_BYTES,
  torrentIdentity,
} from "./imports/source-identity.ts";
import type { Library } from "./library.ts";
import { isManagedMediaPath } from "./local-media.ts";
import {
  isPlayablePath,
  MediaSelectionError,
  selectMediaFiles,
  type SelectedFile,
  type TorrentFile,
} from "./media-file-selection.ts";
import { MediaProbeError, probeMedia } from "./media-probe.ts";
import { currentSpeed } from "./speedtest.ts";
import {
  evaluateStreamTest,
  rateLimitMbps,
  readAheadBytes,
  summarizeSwarm,
  type StreamVerdict,
  type SwarmSample,
  type SwarmSummary,
} from "./stream-verdict.ts";
import { TorrServerError, type TorrServerClient } from "./torrserver-client.ts";
import type { LibraryEntry } from "./types.ts";

export type StreamTestMode = "basic" | "extended";
export type StreamTestPhase =
  "queued" | "metadata" | "measuring" | "done" | "cancelled" | "failed";
export type StreamTestStop = "time" | "cap" | "stream" | "complete" | "cancel";

export type StreamTestRequest = {
  source:
    { magnetUri: string } | { torrentFilePath: string } | { draftId: string };
  type?: "movie" | "series";
  seasonHint?: number;
  episodeHint?: number;
  fileId?: number;
  mode?: StreamTestMode;
};

export type StreamTestLimits = {
  sampleIntervalMs: number;
  warmupMs: number;
  /** Counted from the start of the run, metadata included. */
  budgetMs: Record<StreamTestMode, number>;
  capBytes: Record<StreamTestMode, number>;
  metadataTimeoutMs: Record<StreamTestMode, number>;
  probeTimeoutMs: Record<StreamTestMode, number>;
  ttlMs: number;
  maxQueued: number;
  maxRecords: number;
  /** A test won't start while a client streamed within this window. */
  quietMs: number;
  maxFiles: number;
};

export const STREAM_TEST_LIMITS: StreamTestLimits = {
  sampleIntervalMs: 2_000,
  warmupMs: 10_000,
  budgetMs: { basic: 90_000, extended: 180_000 },
  capBytes: { basic: 256 * 1024 ** 2, extended: 1024 ** 3 },
  metadataTimeoutMs: { basic: 30_000, extended: 60_000 },
  probeTimeoutMs: { basic: 20_000, extended: 60_000 },
  ttlMs: 10 * 60_000,
  maxQueued: 3,
  maxRecords: 8,
  quietMs: 10_000,
  maxFiles: 200,
};

/** The ImportService surface a test needs to test and track drafts. */
export interface StreamTestDrafts {
  draftSource(draftId: string): {
    source: { magnetUri?: string; torrentFilePath?: string };
    hash: string;
  };
  /** A live draft or episode preview refers to this infohash. */
  hashInUse(hash: string): boolean;
  onDraftDropped(listener: (draftId: string) => void): () => void;
}

type LineSpeed = {
  mbps: number;
  source: "measured" | "configured";
  measuredAt?: string;
};

export type StreamTestDependencies = {
  torrServer: Pick<
    TorrServerClient,
    | "get"
    | "addMagnet"
    | "addTorrentFile"
    | "waitForFiles"
    | "cacheState"
    | "settings"
    | "remove"
    | "streamUrl"
  >;
  library: Pick<Library, "list">;
  slot: AnalysisSlot;
  drafts?: StreamTestDrafts;
  probe?: typeof probeMedia;
  fetch?: typeof fetch;
  now?: () => number;
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  lastStreamActivity?: () => number;
  lineSpeed?: () => LineSpeed;
  /** The archiver is copying a torrent to disk and shares the line. */
  diskCopyActive?: () => boolean;
  isManagedPath?: (path: string) => Promise<boolean>;
  readTorrent?: (path: string) => Promise<Uint8Array>;
  limits?: Partial<StreamTestLimits>;
};

type TestSource =
  | { hash: string; magnetUri: string }
  | { hash: string; torrentFilePath: string };

type TestRecord = {
  id: string;
  mode: StreamTestMode;
  source: TestSource;
  hash: string;
  draftId?: string;
  type: "movie" | "series";
  hints: { seasonHint?: number; episodeHint?: number };
  fileId?: number;
  phase: StreamTestPhase;
  code?: string;
  message: string;
  createdAt: number;
  startedAt?: number;
  finishedAt?: number;
  expiresAt: number;
  controller: AbortController;
  /** Why the run was aborted, when it wasn't the owner's own cancel. */
  abortedWith?: { code: string; message: string };
  file?: SelectedFile;
  files?: TorrentFile[];
  progress?: {
    downloadMbps?: number;
    peers?: number;
    seeders?: number;
    bytes: number;
  };
  bitrate?: { mbps: number; durationSeconds?: number };
  swarm?: SwarmSummary;
  line?: LineSpeed;
  limitMbps?: number;
  cacheWindowBytes?: number;
  verdict?: StreamVerdict;
  stoppedBy?: StreamTestStop;
};

type FileState = {
  id: number;
  name: string;
  size: number;
  season?: number;
  episode?: number;
};

export type StreamTestState = {
  testId: string;
  phase: StreamTestPhase;
  code?: string;
  message: string;
  mode: StreamTestMode;
  hash: string;
  elapsedSeconds: number;
  budgetSeconds: number;
  expiresAt: string;
  file?: FileState;
  files?: FileState[];
  progress?: {
    downloadMbps?: number;
    peers?: number;
    seeders?: number;
    bytes: number;
  };
  bitrate?: { mbps: number; durationSeconds?: number };
  swarm?: SwarmSummary;
  line?: LineSpeed;
  limitMbps?: number;
  cacheWindowBytes?: number;
  verdict?: StreamVerdict;
  stoppedBy?: StreamTestStop;
};

const FINISHED: ReadonlySet<StreamTestPhase> = new Set([
  "done",
  "cancelled",
  "failed",
]);

const DONE_MESSAGES: Record<StreamTestStop, string> = {
  time: "Test finished.",
  cap: "Test finished at its data limit.",
  complete: "Test finished: the whole file arrived.",
  stream: "Playback started, so the test stopped early.",
  cancel: "Test cancelled.",
};

const round1 = (value: number) => Math.round(value * 10) / 10;

function log(
  level: "info" | "warn" | "error",
  event: string,
  fields: Record<string, unknown> = {},
): void {
  const line = JSON.stringify({ level, event, ...fields });
  if (level === "info") console.log(line);
  else console.error(line);
}

function invalidSource(error: unknown): unknown {
  return error instanceof ImportError
    ? new ImportError("invalid_source", error.message, 400)
    : error;
}

function failure(error: unknown): { code: string; message: string } {
  if (error instanceof ImportError)
    return { code: error.code, message: error.message };
  if (error instanceof TorrServerError)
    return {
      code: "torrserver_unavailable",
      message:
        "TorrServer did not answer. Check that it is running, then test again.",
    };
  return {
    code: "stream_test_failed",
    message: "The test failed unexpectedly. Test again.",
  };
}

async function readTorrentFile(path: string): Promise<Uint8Array> {
  if ((await stat(path)).size > MAX_TORRENT_BYTES)
    throw new ImportError(
      "torrent_size",
      "Torrent metadata must be at most 1 MB.",
    );
  return readFile(path);
}

function entryUses(
  entry: LibraryEntry,
  hash: string,
  paths: ReadonlySet<string>,
): boolean {
  if (entryHasHash(entry, hash)) return true;
  // An entry saved from a tested .torrent upload records its hash only once
  // it is inspected; until then its path is what ties it to the test.
  return [entry, ...(entry.extraSources ?? [])].some(
    (source) =>
      source.torrentFilePath !== undefined &&
      paths.has(resolve(source.torrentFilePath)),
  );
}

function fileState(file: SelectedFile): FileState {
  return {
    id: file.id,
    name: file.path,
    size: file.length,
    ...(file.season === undefined ? {} : { season: file.season }),
    ...(file.episode === undefined ? {} : { episode: file.episode }),
  };
}

function roundedSwarm(swarm: SwarmSummary): SwarmSummary {
  return {
    ...swarm,
    ...(swarm.sustainedMbps === undefined
      ? {}
      : { sustainedMbps: round1(swarm.sustainedMbps) }),
    ...(swarm.peakMbps === undefined
      ? {}
      : { peakMbps: round1(swarm.peakMbps) }),
  };
}

function roundedVerdict(verdict: StreamVerdict): StreamVerdict {
  const remedies = verdict.remedies;
  if (!remedies) return verdict;
  return {
    ...verdict,
    remedies: {
      ...remedies,
      waitSeconds: Math.ceil(remedies.waitSeconds),
      bufferBytes: Math.ceil(remedies.bufferBytes),
      ...(remedies.copySeconds === undefined
        ? {}
        : { copySeconds: Math.ceil(remedies.copySeconds) }),
      ...(remedies.targetMbps === undefined
        ? {}
        : { targetMbps: Math.floor(remedies.targetMbps * 10) / 10 }),
      ...(remedies.targetBytes === undefined
        ? {}
        : { targetBytes: Math.floor(remedies.targetBytes) }),
    },
  };
}

/**
 * Runs pre-add stream tests one at a time, taking turns with source checks
 * through the shared analysis slot. A torrent the test registered is removed
 * again once no test, draft, preview or library entry uses it.
 */
export class StreamTests {
  readonly #torrServer: StreamTestDependencies["torrServer"];
  readonly #library: Pick<Library, "list">;
  readonly #slot: AnalysisSlot;
  readonly #drafts?: StreamTestDrafts;
  readonly #probe: typeof probeMedia;
  readonly #fetch: typeof fetch;
  readonly #now: () => number;
  readonly #sleep: (ms: number, signal: AbortSignal) => Promise<void>;
  readonly #lastStreamActivity: () => number;
  readonly #lineSpeed: () => LineSpeed;
  readonly #diskCopyActive: () => boolean;
  readonly #isManagedPath: (path: string) => Promise<boolean>;
  readonly #readTorrent: (path: string) => Promise<Uint8Array>;
  readonly #limits: StreamTestLimits;
  readonly #records = new Map<string, TestRecord>();
  readonly #queue: TestRecord[] = [];
  /** Records that keep their torrent registered, finished ones included. */
  readonly #holding = new Set<TestRecord>();
  /** Hashes a test registered → the .torrent paths tested for each. */
  readonly #registered = new Map<string, Set<string>>();
  readonly #pending = new Set<Promise<void>>();
  readonly #unsubscribe?: () => void;
  #running?: TestRecord;
  #runningOperation?: Promise<void>;
  #slotRequest?: () => void;
  #serial: Promise<void> = Promise.resolve();
  #sweep?: ReturnType<typeof setInterval>;
  #closing = false;

  constructor(dependencies: StreamTestDependencies) {
    this.#torrServer = dependencies.torrServer;
    this.#library = dependencies.library;
    this.#slot = dependencies.slot;
    this.#drafts = dependencies.drafts;
    this.#probe = dependencies.probe ?? probeMedia;
    this.#fetch = dependencies.fetch ?? fetch;
    this.#now = dependencies.now ?? Date.now;
    this.#sleep =
      dependencies.sleep ?? ((ms, signal) => delay(ms, undefined, { signal }));
    this.#lastStreamActivity =
      dependencies.lastStreamActivity ?? lastStreamActivityAt;
    this.#lineSpeed = dependencies.lineSpeed ?? currentSpeed;
    this.#diskCopyActive = dependencies.diskCopyActive ?? (() => false);
    this.#isManagedPath = dependencies.isManagedPath ?? isManagedMediaPath;
    this.#readTorrent = dependencies.readTorrent ?? readTorrentFile;
    this.#limits = { ...STREAM_TEST_LIMITS, ...dependencies.limits };
    this.#unsubscribe = this.#drafts?.onDraftDropped((draftId) =>
      this.#draftDropped(draftId),
    );
  }

  async start(request: StreamTestRequest): Promise<StreamTestState> {
    this.#ensureOpen();
    this.#prune();
    if (this.#streamingNow())
      throw new ImportError(
        "streaming_active",
        "Something is streaming. Test after playback stops, so the test doesn't slow it down.",
        409,
      );
    this.#ensureRoom();
    const { source, draftId } = await this.#resolve(request);
    this.#ensureOpen();
    this.#ensureRoom();
    const now = this.#now();
    const record: TestRecord = {
      id: randomUUID(),
      mode: request.mode ?? "basic",
      source,
      hash: source.hash,
      ...(draftId ? { draftId } : {}),
      type: request.type ?? "movie",
      hints: {
        ...(request.seasonHint === undefined
          ? {}
          : { seasonHint: request.seasonHint }),
        ...(request.episodeHint === undefined
          ? {}
          : { episodeHint: request.episodeHint }),
      },
      ...(request.fileId === undefined ? {} : { fileId: request.fileId }),
      phase: "queued",
      message: "",
      createdAt: now,
      expiresAt: now + this.#limits.ttlMs,
      controller: new AbortController(),
    };
    this.#records.set(record.id, record);
    this.#holding.add(record);
    this.#queue.push(record);
    this.#trim();
    this.#startSweep();
    this.#pump();
    return this.#state(record);
  }

  get(testId: string): StreamTestState {
    this.#prune();
    return this.#state(this.#require(testId));
  }

  /** Cancels a test that hasn't finished, forgets it and cleans up. */
  async delete(testId: string): Promise<void> {
    this.#prune();
    const record = this.#require(testId);
    this.#records.delete(testId);
    if (record === this.#running) {
      record.controller.abort();
      return;
    }
    if (record.phase === "queued") {
      this.#unqueue(record);
      this.#finish(record, "cancelled", DONE_MESSAGES.cancel);
    }
    await this.#release(record);
  }

  async close(): Promise<void> {
    if (this.#closing) return;
    this.#closing = true;
    clearInterval(this.#sweep);
    this.#unsubscribe?.();
    this.#slotRequest?.();
    this.#slotRequest = undefined;
    const shutdown = {
      code: "stream_test_unavailable",
      message: "The server is shutting down. Test again after it restarts.",
    };
    for (const record of this.#queue.splice(0))
      this.#finish(record, "cancelled", shutdown.message, shutdown.code);
    if (this.#running) {
      this.#running.abortedWith = shutdown;
      this.#running.controller.abort();
    }
    await this.#runningOperation;
    for (const record of [...this.#holding]) void this.#release(record);
    // TorrServer's `rem` takes no signal; don't let cleanup hold shutdown.
    const bound = new AbortController();
    await Promise.race([
      Promise.allSettled([...this.#pending]),
      delay(2_000, undefined, { signal: bound.signal, ref: false }).catch(
        () => undefined,
      ),
    ]);
    bound.abort();
  }

  #ensureOpen() {
    if (this.#closing)
      throw new ImportError(
        "stream_test_unavailable",
        "The server is shutting down. Test again after it restarts.",
        503,
      );
  }

  #ensureRoom() {
    if (this.#queue.length >= this.#limits.maxQueued)
      throw new ImportError(
        "stream_test_busy",
        "Other stream tests are already waiting. Wait for one to finish, or cancel one.",
        429,
      );
  }

  #require(testId: string): TestRecord {
    const record = this.#records.get(testId);
    if (!record)
      throw new ImportError(
        "not_found",
        "The test expired or the server restarted. Test again.",
        404,
      );
    return record;
  }

  #streamingNow(): boolean {
    const last = this.#lastStreamActivity();
    return last > 0 && this.#now() - last < this.#limits.quietMs;
  }

  async #resolve(
    request: StreamTestRequest,
  ): Promise<{ source: TestSource; draftId?: string }> {
    const { source } = request;
    if ("draftId" in source) {
      const drafts = this.#drafts;
      if (!drafts)
        throw new ImportError(
          "draft_expired",
          "This import draft expired. Prepare the source again.",
          410,
        );
      const draft = drafts.draftSource(source.draftId);
      const hash = draft.hash.toLowerCase();
      if (draft.source.magnetUri)
        return {
          source: { hash, magnetUri: draft.source.magnetUri },
          draftId: source.draftId,
        };
      if (draft.source.torrentFilePath)
        return {
          source: { hash, torrentFilePath: draft.source.torrentFilePath },
          draftId: source.draftId,
        };
      throw new ImportError(
        "invalid_source",
        "This draft has no torrent to test.",
        400,
      );
    }
    if ("magnetUri" in source) {
      try {
        const { hash } = magnetIdentity(source.magnetUri);
        return { source: { hash, magnetUri: source.magnetUri } };
      } catch (error) {
        throw invalidSource(error);
      }
    }
    const path = source.torrentFilePath;
    const unavailable = new ImportError(
      "invalid_source",
      "Choose the .torrent file again, then test it.",
      400,
    );
    if (
      !path.toLowerCase().endsWith(".torrent") ||
      !(await this.#isManagedPath(path).catch(() => false))
    )
      throw unavailable;
    let bytes: Uint8Array;
    try {
      bytes = await this.#readTorrent(path);
    } catch (error) {
      if (error instanceof ImportError) throw invalidSource(error);
      throw unavailable;
    }
    try {
      const { hash } = await torrentIdentity(bytes);
      return { source: { hash, torrentFilePath: path } };
    } catch (error) {
      throw invalidSource(error);
    }
  }

  #pump(): void {
    if (
      this.#closing ||
      this.#running ||
      this.#slotRequest ||
      !this.#queue.length
    )
      return;
    let requested = true;
    const withdraw = this.#slot.request("stream-test", (release) => {
      requested = false;
      this.#slotRequest = undefined;
      const record = this.#closing ? undefined : this.#queue.shift();
      if (!record) {
        release();
        return;
      }
      this.#running = record;
      this.#runningOperation = this.#run(record)
        .catch(() =>
          log("error", "stream_test_state_failed", { testId: record.id }),
        )
        .finally(() => {
          this.#running = undefined;
          this.#runningOperation = undefined;
          release();
          this.#pump();
        });
    });
    if (requested) this.#slotRequest = withdraw;
  }

  #unqueue(record: TestRecord) {
    const at = this.#queue.indexOf(record);
    if (at >= 0) this.#queue.splice(at, 1);
    if (!this.#queue.length && !this.#running) {
      this.#slotRequest?.();
      this.#slotRequest = undefined;
    }
  }

  async #run(record: TestRecord): Promise<void> {
    const signal = record.controller.signal;
    const endMark = beginStreamTest(record.hash);
    const startedAt = this.#now();
    record.startedAt = startedAt;
    const deadline = startedAt + this.#limits.budgetMs[record.mode];
    log("info", "stream_test_started", {
      testId: record.id,
      mode: record.mode,
    });
    try {
      if (this.#streamingNow())
        throw new ImportError(
          "streaming_active",
          "Playback started before the test could run. Test again after it stops.",
          409,
        );
      record.phase = "metadata";
      record.message = "Asking peers for the torrent's file list…";
      await this.#register(record, signal);
      const files = await this.#metadata(record, deadline, signal);
      if (!files) {
        record.verdict = evaluateStreamTest({ noMetadata: true });
        this.#finish(
          record,
          "done",
          "No peers sent the torrent's file list in time.",
        );
        return;
      }
      record.files = files
        .filter((file) => isPlayablePath(file.path))
        .sort((a, b) => a.path.localeCompare(b.path))
        .slice(0, this.#limits.maxFiles);
      record.file = this.#pick(record, files);
      signal.throwIfAborted();
      if (this.#lastStreamActivity() > startedAt) {
        record.stoppedBy = "stream";
        record.verdict = evaluateStreamTest({ streamStarted: true });
        this.#finish(record, "done", DONE_MESSAGES.stream);
        return;
      }
      record.phase = "measuring";
      record.message = "Measuring how fast peers deliver this file…";
      await this.#measure(record, record.file, deadline, signal);
      this.#finish(record, "done", DONE_MESSAGES[record.stoppedBy ?? "time"]);
    } catch (error) {
      if (signal.aborted)
        this.#finish(
          record,
          "cancelled",
          record.abortedWith?.message ?? DONE_MESSAGES.cancel,
          record.abortedWith?.code,
        );
      else {
        const { code, message } = failure(error);
        this.#finish(record, "failed", message, code);
      }
    } finally {
      endMark();
      // A finished test keeps its torrent registered until it expires, so
      // playing right after it may start from cache.
      const keep =
        record.phase === "done" &&
        record.verdict?.reason !== "no_metadata" &&
        this.#records.get(record.id) === record &&
        !this.#closing;
      if (!keep) void this.#release(record);
    }
  }

  #finish(
    record: TestRecord,
    phase: "done" | "cancelled" | "failed",
    message: string,
    code?: string,
  ) {
    const now = this.#now();
    record.phase = phase;
    record.message = message;
    if (code) record.code = code;
    record.finishedAt = now;
    record.expiresAt = now + this.#limits.ttlMs;
    delete record.progress;
    const seconds =
      record.startedAt === undefined
        ? 0
        : Math.round((now - record.startedAt) / 1000);
    if (phase === "failed")
      log("warn", "stream_test_failed", {
        testId: record.id,
        mode: record.mode,
        code,
        seconds,
      });
    else
      log("info", "stream_test_finished", {
        testId: record.id,
        mode: record.mode,
        phase,
        ...(code ? { code } : {}),
        ...(record.stoppedBy ? { stoppedBy: record.stoppedBy } : {}),
        ...(record.verdict
          ? {
              verdict: record.verdict.level,
              reason: record.verdict.reason,
              bottleneck: record.verdict.bottleneck,
            }
          : {}),
        sustainedMbps:
          record.swarm?.sustainedMbps === undefined
            ? undefined
            : round1(record.swarm.sustainedMbps),
        bitrateMbps:
          record.bitrate === undefined
            ? undefined
            : round1(record.bitrate.mbps),
        samples: record.swarm?.samples,
        seconds,
      });
  }

  /** Serializes TorrServer registration against cleanup. */
  #exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.#serial.then(operation);
    this.#serial = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  #own(hash: string, record: TestRecord) {
    let paths = this.#registered.get(hash);
    if (!paths) this.#registered.set(hash, (paths = new Set()));
    if ("torrentFilePath" in record.source)
      paths.add(resolve(record.source.torrentFilePath));
  }

  async #register(record: TestRecord, signal: AbortSignal): Promise<void> {
    await this.#exclusive(async () => {
      signal.throwIfAborted();
      try {
        await this.#torrServer.get(record.hash, signal);
        // Known already: only a torrent an earlier test registered is ours.
        if (this.#registered.has(record.hash)) this.#own(record.hash, record);
        return;
      } catch (error) {
        if (!(error instanceof TorrServerError && error.code === "not_found"))
          throw error;
      }
      // Claimed before the request: an aborted add may still register it.
      this.#own(record.hash, record);
      const status =
        "magnetUri" in record.source
          ? await this.#torrServer.addMagnet(
              record.source.magnetUri,
              undefined,
              signal,
            )
          : await this.#torrServer.addTorrentFile(
              record.source.torrentFilePath,
              undefined,
              signal,
            );
      const actual = status.hash.toLowerCase();
      if (actual === record.hash) return;
      this.#own(actual, record);
      void this.#track(this.#releaseIfUnused(actual));
      throw new ImportError(
        "source_mismatch",
        "TorrServer registered a different torrent than this source names. Choose another source.",
        502,
      );
    });
  }

  async #metadata(
    record: TestRecord,
    deadline: number,
    signal: AbortSignal,
  ): Promise<TorrentFile[] | undefined> {
    const timeout = Math.max(
      1,
      Math.min(
        this.#limits.metadataTimeoutMs[record.mode],
        deadline - this.#now(),
      ),
    );
    try {
      const status = await this.#torrServer.waitForFiles(
        record.hash,
        timeout,
        signal,
      );
      return status.file_stats;
    } catch (error) {
      if (error instanceof TorrServerError && error.code === "metadata_timeout")
        return undefined;
      throw error;
    }
  }

  #pick(record: TestRecord, files: TorrentFile[]): SelectedFile {
    let selected: SelectedFile[];
    try {
      selected = selectMediaFiles(
        record.type,
        files,
        undefined,
        [],
        record.hints,
      );
    } catch (error) {
      if (error instanceof MediaSelectionError)
        throw new ImportError(
          "no_playable_file",
          "This torrent has no playable video file.",
          422,
        );
      throw error;
    }
    if (record.fileId === undefined) return selected[0]!;
    const chosen =
      selected.find((file) => file.id === record.fileId) ??
      files.find((file) => file.id === record.fileId);
    if (!chosen || !isPlayablePath(chosen.path))
      throw new ImportError(
        "invalid_file",
        "That file isn't a playable video in this torrent. Pick another.",
        422,
      );
    return chosen;
  }

  async #measure(
    record: TestRecord,
    file: SelectedFile,
    deadline: number,
    signal: AbortSignal,
  ): Promise<void> {
    const limits = this.#limits;
    const cap = limits.capBytes[record.mode];
    const settings = await this.#torrServer
      .settings(signal)
      .catch(() => undefined);
    signal.throwIfAborted();
    const limitMbps = rateLimitMbps(settings?.DownloadRateLimit);
    const cacheWindowBytes = readAheadBytes(
      settings?.CacheSize,
      settings?.ReaderReadAHead,
    );
    if (limitMbps !== undefined) record.limitMbps = limitMbps;
    if (cacheWindowBytes !== undefined)
      record.cacheWindowBytes = cacheWindowBytes;
    const line = this.#lineSpeed();
    record.line = {
      mbps: line.mbps,
      source: line.source,
      ...(line.measuredAt ? { measuredAt: line.measuredAt } : {}),
    };
    // Pieces TorrServer already holds for this torrent don't count.
    const baseline = await this.#torrServer
      .cacheState(record.hash, signal)
      .then(
        (cache) => cache?.filled ?? 0,
        () => 0,
      );
    signal.throwIfAborted();

    const url = this.#torrServer.streamUrl(record.hash, file);
    const stopReader = new AbortController();
    const stopProbe = new AbortController();
    const measureStart = this.#now();
    let received = 0;
    let readerEnd: "eof" | "cap" | undefined;
    let readerEndedAt: number | undefined;
    let readerFailed = false;
    const readerSignal = AbortSignal.any([signal, stopReader.signal]);
    const reading = this.#read(url, readerSignal, cap, (bytes) => {
      received += bytes;
    }).then(
      (end) => {
        readerEnd = end;
        readerEndedAt = this.#now();
      },
      () => {
        if (!readerSignal.aborted) readerFailed = true;
      },
    );
    let probeSettled = false;
    const probing = this.#probe(
      url,
      { id: file.id, length: file.length },
      {
        timeoutMs: limits.probeTimeoutMs[record.mode],
        signal: AbortSignal.any([signal, stopProbe.signal]),
        bounded: true,
      },
    )
      .catch((error: unknown) =>
        error instanceof MediaProbeError ? error.technical : undefined,
      )
      .then((technical) => {
        probeSettled = true;
        return technical?.bitrateMbps === undefined
          ? undefined
          : {
              mbps: technical.bitrateMbps,
              ...(technical.durationSeconds === undefined
                ? {}
                : { durationSeconds: technical.durationSeconds }),
            };
      });

    const samples: SwarmSample[] = [];
    let filled = baseline;
    let snapshot: { at: number; bytes: number } | undefined;
    let shared = false;
    let stoppedBy: StreamTestStop | "failed" | undefined;
    while (!stoppedBy) {
      const wait = Math.min(limits.sampleIntervalMs, deadline - this.#now());
      if (wait > 0) await this.#sleep(wait, signal).catch(() => undefined);
      const at = this.#now();
      if (!signal.aborted) {
        const cache = await this.#torrServer
          .cacheState(record.hash, signal)
          .catch(() => undefined);
        if (cache) {
          samples.push({
            atMs: at - measureStart,
            downloadMbps: (cache.downloadSpeedBps * 8) / 1e6,
            peers: cache.activePeers,
            seeders: cache.connectedSeeders,
          });
          filled = Math.max(filled, cache.filled);
        }
      }
      if (this.#diskCopyActive()) shared = true;
      if (!snapshot && at - measureStart >= limits.warmupMs)
        snapshot = { at, bytes: received };
      const latest = samples.at(-1);
      record.progress = {
        bytes: Math.max(filled - baseline, received),
        ...(latest
          ? {
              downloadMbps: round1(latest.downloadMbps),
              peers: latest.peers,
              seeders: latest.seeders,
            }
          : {}),
      };
      if (signal.aborted) stoppedBy = "cancel";
      else if (this.#lastStreamActivity() > record.startedAt!)
        stoppedBy = "stream";
      else if (readerFailed) stoppedBy = "failed";
      else if (readerEnd === "eof") stoppedBy = "complete";
      else if (readerEnd === "cap" || filled - baseline >= cap)
        stoppedBy = "cap";
      else if (this.#now() >= deadline) stoppedBy = "time";
    }
    const end = this.#now();
    stopReader.abort();
    await reading;
    if (!probeSettled && (stoppedBy === "cap" || stoppedBy === "complete")) {
      // Stopped early with a good read: give the bitrate probe the rest of
      // the budget.
      const wait = deadline - this.#now();
      const pause = new AbortController();
      if (wait > 0)
        await Promise.race([
          probing,
          this.#sleep(wait, AbortSignal.any([signal, pause.signal])).catch(
            () => undefined,
          ),
        ]);
      pause.abort();
    }
    stopProbe.abort();
    const bitrate = await probing;
    signal.throwIfAborted();
    if (stoppedBy === "failed")
      throw new ImportError(
        "read_failed",
        "TorrServer stopped serving the file during the test. Test again.",
        502,
      );

    const windowEnd = Math.min(readerEndedAt ?? end, end);
    const swarm = summarizeSwarm({
      samples,
      warmupMs: limits.warmupMs,
      bytes: Math.max(filled - baseline, received),
      measuringMs: end - measureStart,
      reader: {
        bytesAfterWarmup: snapshot ? received - snapshot.bytes : 0,
        windowMs: snapshot ? Math.max(0, windowEnd - snapshot.at) : 0,
        eof: readerEnd === "eof",
      },
      capped: stoppedBy === "cap" || stoppedBy === "complete",
    });
    record.stoppedBy = stoppedBy;
    record.swarm = swarm;
    if (bitrate) record.bitrate = bitrate;
    record.verdict = evaluateStreamTest({
      bitrateMbps: bitrate?.mbps,
      durationSeconds: bitrate?.durationSeconds,
      sizeBytes: file.length,
      swarm,
      lineMbps: record.line.mbps,
      limitMbps,
      cacheWindowBytes,
      sharedWithDiskCopy: shared,
      streamStarted: stoppedBy === "stream",
    });
  }

  /**
   * Reads the file as fast as TorrServer delivers it. Resolves "eof" at the
   * end of the file, "cap" at the byte cap and undefined when aborted.
   */
  async #read(
    url: string,
    signal: AbortSignal,
    cap: number,
    onBytes: (bytes: number) => void,
  ): Promise<"eof" | "cap" | undefined> {
    const response = await this.#fetch(url, { signal });
    const body = response.body;
    if (!response.ok || !body) {
      await body?.cancel().catch(() => undefined);
      throw new Error(`TorrServer answered ${response.status}`);
    }
    const reader = body.getReader();
    const abort = () => void reader.cancel().catch(() => undefined);
    signal.addEventListener("abort", abort, { once: true });
    try {
      if (signal.aborted) return undefined;
      let total = 0;
      for (;;) {
        const { done, value } = await reader.read();
        // A cancelled reader reports done; that is not the end of the file.
        if (signal.aborted) return undefined;
        if (done) return "eof";
        total += value.byteLength;
        onBytes(value.byteLength);
        if (total >= cap) return "cap";
      }
    } finally {
      signal.removeEventListener("abort", abort);
      await reader.cancel().catch(() => undefined);
    }
  }

  #track(operation: Promise<void>): Promise<void> {
    const tracked = operation.catch(() =>
      log("warn", "stream_test_cleanup_failed"),
    );
    this.#pending.add(tracked);
    void tracked.finally(() => this.#pending.delete(tracked));
    return tracked;
  }

  #release(record: TestRecord): Promise<void> {
    if (!this.#holding.delete(record)) return Promise.resolve();
    return this.#track(this.#releaseIfUnused(record.hash));
  }

  #inUse(hash: string): boolean {
    for (const record of this.#holding) if (record.hash === hash) return true;
    return this.#drafts?.hashInUse(hash) ?? false;
  }

  /**
   * Removes a torrent a test registered once nothing else uses it: no test
   * still holding it, no draft or preview, and no library entry.
   */
  #releaseIfUnused(hash: string): Promise<void> {
    return this.#exclusive(async () => {
      const paths = this.#registered.get(hash);
      if (!paths || this.#inUse(hash)) return;
      let entries: LibraryEntry[];
      try {
        entries = await this.#library.list();
      } catch {
        log("warn", "stream_test_cleanup_failed");
        return;
      }
      if (this.#inUse(hash)) return;
      this.#registered.delete(hash);
      if (entries.some((entry) => entryUses(entry, hash, paths))) return;
      try {
        await this.#torrServer.remove(hash);
      } catch {
        log("warn", "stream_test_cleanup_failed");
      }
    });
  }

  #draftDropped(draftId: string) {
    const discarded = {
      code: "draft_discarded",
      message: "The import draft was discarded, so the test stopped.",
    };
    for (const record of this.#records.values()) {
      if (record.draftId !== draftId) continue;
      if (record === this.#running) {
        record.abortedWith = discarded;
        record.controller.abort();
      } else if (record.phase === "queued") {
        this.#unqueue(record);
        this.#finish(record, "cancelled", discarded.message, discarded.code);
        void this.#release(record);
      } else void this.#release(record);
    }
    // The draft no longer protects its hash; unused test torrents can go.
    for (const hash of [...this.#registered.keys()])
      void this.#track(this.#releaseIfUnused(hash));
  }

  #trim() {
    while (this.#records.size > this.#limits.maxRecords) {
      let oldest: TestRecord | undefined;
      for (const record of this.#records.values())
        if (
          FINISHED.has(record.phase) &&
          (!oldest || record.createdAt < oldest.createdAt)
        )
          oldest = record;
      if (!oldest) return;
      this.#records.delete(oldest.id);
      void this.#release(oldest);
    }
  }

  #prune() {
    const now = this.#now();
    for (const record of [...this.#records.values()]) {
      if (record === this.#running || record.expiresAt > now) continue;
      this.#records.delete(record.id);
      if (record.phase === "queued") {
        this.#unqueue(record);
        this.#finish(
          record,
          "cancelled",
          "The test waited too long to start.",
          "expired",
        );
      }
      void this.#release(record);
    }
  }

  #startSweep() {
    if (this.#sweep) return;
    this.#sweep = setInterval(() => {
      this.#prune();
      // A preview or draft may have stopped protecting a hash without a
      // drop event, such as an episode preview that was closed.
      for (const hash of [...this.#registered.keys()])
        void this.#track(this.#releaseIfUnused(hash));
    }, 60_000);
    this.#sweep.unref();
  }

  #queuedMessage(): string {
    const holder = this.#slot.holder();
    if (holder === "source-check")
      return "Waiting for a source check to finish…";
    if (holder === "stream-test")
      return "Waiting for another stream test to finish…";
    return "Waiting to start…";
  }

  #state(record: TestRecord): StreamTestState {
    const now = this.#now();
    const elapsedMs =
      record.startedAt === undefined
        ? 0
        : (record.finishedAt ?? now) - record.startedAt;
    return {
      testId: record.id,
      phase: record.phase,
      ...(record.code ? { code: record.code } : {}),
      message:
        record.phase === "queued" ? this.#queuedMessage() : record.message,
      mode: record.mode,
      hash: record.hash,
      elapsedSeconds: Math.max(0, Math.round(elapsedMs / 1000)),
      budgetSeconds: this.#limits.budgetMs[record.mode] / 1000,
      expiresAt: new Date(record.expiresAt).toISOString(),
      ...(record.file ? { file: fileState(record.file) } : {}),
      ...(record.files ? { files: record.files.map(fileState) } : {}),
      ...(record.progress ? { progress: { ...record.progress } } : {}),
      ...(record.bitrate
        ? {
            bitrate: {
              mbps: round1(record.bitrate.mbps),
              ...(record.bitrate.durationSeconds === undefined
                ? {}
                : {
                    durationSeconds: Math.round(record.bitrate.durationSeconds),
                  }),
            },
          }
        : {}),
      ...(record.swarm ? { swarm: roundedSwarm(record.swarm) } : {}),
      ...(record.line
        ? { line: { ...record.line, mbps: round1(record.line.mbps) } }
        : {}),
      ...(record.limitMbps === undefined
        ? {}
        : { limitMbps: round1(record.limitMbps) }),
      ...(record.cacheWindowBytes === undefined
        ? {}
        : { cacheWindowBytes: record.cacheWindowBytes }),
      ...(record.verdict ? { verdict: roundedVerdict(record.verdict) } : {}),
      ...(record.stoppedBy ? { stoppedBy: record.stoppedBy } : {}),
    };
  }
}
