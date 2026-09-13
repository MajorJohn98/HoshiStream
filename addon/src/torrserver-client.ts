import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import { z } from "zod";
import { setTimeout as delay } from "node:timers/promises";
import { rawFileId, type TorrentFile } from "./media-file-selection.ts";

const torrentFileSchema = z.object({
  id: z.number().int().positive(),
  path: z.string().min(1),
  length: z.number().int().nonnegative(),
});

const liveStat = z
  .number()
  .nullish()
  .transform((value) => value ?? undefined);

const torrentStatusSchema = z.object({
  title: z.string().default(""),
  name: z.string().optional(),
  hash: z.string().min(1),
  stat: z.number().int(),
  stat_string: z.string(),
  file_stats: z.array(torrentFileSchema).optional().default([]),
  // Optional live stats (verified against MatriX.141 server/torr/state/state.go)
  // surfaced by the Devices panel; absent unless the torrent is active, and
  // observed as null for a working torrent with no measurable speed yet.
  loaded_size: liveStat,
  torrent_size: liveStat,
  download_speed: liveStat,
  upload_speed: liveStat,
  active_peers: liveStat,
  connected_seeders: liveStat,
});

const torrentListSchema = z.array(torrentStatusSchema);

export type TorrentStatus = z.infer<typeof torrentStatusSchema>;

// `POST /cache {action:"get"}` returns storage/state.CacheState, whose Go
// struct has no JSON tags (verified at the pinned commit), so fields arrive
// Go-cased. Reader Start/End/Reader are absolute piece indexes; multiply by
// PiecesLength for bytes. A torrent without a cache yet answers `{}`.
const cacheReaderSchema = z.object({
  Start: z.number().int().nonnegative(),
  End: z.number().int().nonnegative(),
  Reader: z.number().int().nonnegative(),
});

const cachePieceSchema = z.object({
  Id: z.number().int().nonnegative(),
  Length: z.number().nonnegative(),
  Size: z.number().nonnegative(),
  Completed: z.boolean(),
  Priority: z.number().int(),
});

const cacheStateSchema = z.object({
  Hash: z.string().optional(),
  Capacity: z.number().nonnegative().optional(),
  Filled: z.number().nonnegative().optional(),
  PiecesLength: z.number().positive().optional(),
  PiecesCount: z.number().int().nonnegative().optional(),
  Pieces: z.record(z.string(), cachePieceSchema).nullable().optional(),
  Readers: z.array(cacheReaderSchema).nullable().optional(),
  Torrent: z
    .object({
      download_speed: z.number().optional(),
      upload_speed: z.number().optional(),
      active_peers: z.number().optional(),
      connected_seeders: z.number().optional(),
      file_stats: z.array(torrentFileSchema).nullable().optional(),
    })
    .nullable()
    .optional(),
});

export interface CacheReader {
  startPiece: number;
  endPiece: number;
  readerPiece: number;
}

export interface CacheState {
  hash: string;
  capacity: number;
  filled: number;
  pieceLength: number;
  pieceCount: number;
  /** Piece index → completed flag, for pieces the cache currently holds. */
  completed: Map<number, boolean>;
  readers: CacheReader[];
  downloadSpeedBps: number;
  activePeers: number;
  connectedSeeders: number;
  /** Torrent files in torrent order (the embedded status), for byte offsets. */
  files: TorrentStatus["file_stats"];
}

export class TorrServerError extends Error {
  readonly code: string;
  readonly status?: number;
  constructor(message: string, code = "unavailable", status?: number) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

export class TorrServerClient {
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly retryDelayMs: number;

  constructor(baseUrl: string, timeoutMs = 10_000, retryDelayMs = 500) {
    this.baseUrl = baseUrl;
    this.timeoutMs = timeoutMs;
    this.retryDelayMs = retryDelayMs;
  }

  async health(): Promise<string> {
    return this.requestText("/echo");
  }

  async addMagnet(
    link: string,
    title?: string,
    signal?: AbortSignal,
  ): Promise<TorrentStatus> {
    return this.status(
      await this.torrentAction(
        {
          action: "add",
          link,
          title,
          save_to_db: false,
        },
        signal,
        1,
      ),
    );
  }

  async addTorrentFile(
    path: string,
    title?: string,
    signal?: AbortSignal,
  ): Promise<TorrentStatus> {
    const form = new FormData();
    form.append(
      "file",
      new Blob([Uint8Array.from(await readFile(path, { signal }))]),
      basename(path),
    );
    if (title) form.append("title", title);
    const response = await this.request(
      "/torrent/upload",
      {
        method: "POST",
        body: form,
        signal,
      },
      1,
    );
    return this.status(await this.json(response));
  }

  async get(hash: string, signal?: AbortSignal): Promise<TorrentStatus> {
    return this.status(
      await this.torrentAction({ action: "get", hash }, signal),
    );
  }

  async list(): Promise<TorrentStatus[]> {
    const parsed = torrentListSchema.safeParse(
      await this.torrentAction({ action: "list" }),
    );
    if (!parsed.success)
      throw new TorrServerError(
        "TorrServer returned an invalid torrent list",
        "invalid_response",
      );
    return parsed.data;
  }

  async waitForFiles(
    hash: string,
    timeoutMs = 30_000,
    signal?: AbortSignal,
  ): Promise<TorrentStatus> {
    const deadline = AbortSignal.timeout(timeoutMs);
    const bounded = AbortSignal.any([deadline, ...(signal ? [signal] : [])]);
    try {
      for (;;) {
        bounded.throwIfAborted();
        const status = await this.get(hash, bounded);
        if (status.file_stats.length) return status;
        await delay(500, undefined, { signal: bounded });
      }
    } catch (error) {
      if (signal?.aborted)
        throw new TorrServerError(
          "Torrent inspection was cancelled",
          "cancelled",
        );
      if (deadline.aborted)
        throw new TorrServerError(
          "Timed out waiting for torrent metadata",
          "metadata_timeout",
        );
      throw error;
    }
  }

  async remove(hash: string): Promise<void> {
    await this.torrentAction({ action: "rem", hash });
  }

  /**
   * Cache window for one registered torrent, or undefined when TorrServer
   * has not built a cache for it yet (metadata still pending).
   */
  async cacheState(
    hash: string,
    signal?: AbortSignal,
  ): Promise<CacheState | undefined> {
    const response = await this.request(
      "/cache",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "get", hash }),
        signal,
      },
      1,
    );
    const parsed = cacheStateSchema.safeParse(await this.json(response));
    if (!parsed.success)
      throw new TorrServerError(
        "TorrServer returned an invalid cache state",
        "invalid_response",
      );
    const raw = parsed.data;
    if (!raw.PiecesLength) return undefined;
    const completed = new Map<number, boolean>();
    for (const [index, piece] of Object.entries(raw.Pieces ?? {}))
      completed.set(Number(index), piece.Completed);
    return {
      hash: raw.Hash ?? hash,
      capacity: raw.Capacity ?? 0,
      filled: raw.Filled ?? 0,
      pieceLength: raw.PiecesLength,
      pieceCount: raw.PiecesCount ?? 0,
      completed,
      readers: (raw.Readers ?? []).map((reader) => ({
        startPiece: reader.Start,
        endPiece: reader.End,
        readerPiece: reader.Reader,
      })),
      downloadSpeedBps: raw.Torrent?.download_speed ?? 0,
      activePeers: raw.Torrent?.active_peers ?? 0,
      connectedSeeders: raw.Torrent?.connected_seeders ?? 0,
      files: raw.Torrent?.file_stats ?? [],
    };
  }

  // TorrServer's own viewed marks (`POST /viewed`, verified at the pinned
  // commit: settings/viewed.go). `fileIndex` is the raw one-based index of
  // the file inside `hash`. Both answer 200 with no body.
  async setViewed(hash: string, fileIndex: number): Promise<void> {
    await this.viewedAction("set", hash, fileIndex);
  }

  async removeViewed(hash: string, fileIndex: number): Promise<void> {
    await this.viewedAction("rem", hash, fileIndex);
  }

  private async viewedAction(
    action: "set" | "rem",
    hash: string,
    fileIndex: number,
  ): Promise<void> {
    const response = await this.request(
      "/viewed",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action, hash, file_index: fileIndex }),
      },
      1,
    );
    await response.body?.cancel().catch(() => undefined);
  }

  // Composite ids (multi-torrent series) carry the owning source's hash on
  // the file itself and encode the raw TorrServer index; decode both here so
  // every caller keeps passing selected files unchanged.
  streamUrl(hash: string, file: TorrentFile & { hash?: string }): string {
    return `${this.baseUrl}/play/${encodeURIComponent(file.hash ?? hash)}/${rawFileId(file.id)}`;
  }

  private status(value: unknown): TorrentStatus {
    const parsed = torrentStatusSchema.safeParse(value);
    if (!parsed.success)
      throw new TorrServerError(
        "TorrServer returned invalid torrent metadata",
        "invalid_response",
      );
    return parsed.data;
  }

  private async json(response: Response): Promise<unknown> {
    try {
      return await response.json();
    } catch {
      throw new TorrServerError(
        "TorrServer returned unreadable metadata",
        "invalid_response",
      );
    }
  }

  private async torrentAction(
    payload: object,
    signal?: AbortSignal,
    attempts = 3,
  ): Promise<unknown> {
    const response = await this.request(
      "/torrents",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
        signal,
      },
      attempts,
    );
    if (
      response.status === 204 ||
      response.headers.get("content-length") === "0"
    )
      return undefined;
    return this.json(response);
  }

  private async requestText(path: string): Promise<string> {
    return (await this.request(path)).text();
  }

  private async request(
    path: string,
    init?: RequestInit,
    attempts = 3,
  ): Promise<Response> {
    let delayMs = this.retryDelayMs;
    for (let attempt = 1; ; attempt += 1) {
      if (init?.signal?.aborted)
        throw new TorrServerError(
          "TorrServer request was cancelled",
          "cancelled",
        );
      let failure: string;
      const timeout = AbortSignal.timeout(this.timeoutMs);
      const signal = AbortSignal.any([
        timeout,
        ...(init?.signal ? [init.signal] : []),
      ]);
      try {
        const response = await fetch(`${this.baseUrl}${path}`, {
          ...init,
          signal,
        });
        if (response.ok) return response;
        // Release the connection: an unread body keeps the socket pinned
        // until GC, which starves the pool during retry storms.
        await response.body?.cancel().catch(() => undefined);
        if (response.status < 500) {
          throw new TorrServerError(
            `TorrServer ${response.status} ${response.statusText}`,
            response.status === 404 ? "not_found" : "request_rejected",
            response.status,
          );
        }
        failure = `TorrServer ${response.status} ${response.statusText}`;
      } catch (error) {
        if (init?.signal?.aborted)
          throw new TorrServerError(
            "TorrServer request was cancelled",
            "cancelled",
          );
        if (error instanceof TorrServerError) throw error;
        failure = timeout.aborted
          ? "TorrServer request timed out"
          : "TorrServer request failed";
      }
      if (attempt >= attempts)
        throw new TorrServerError(
          failure,
          timeout.aborted ? "timeout" : "unavailable",
        );
      try {
        await delay(delayMs, undefined, { signal: init?.signal ?? undefined });
      } catch {
        throw new TorrServerError(
          "TorrServer request was cancelled",
          "cancelled",
        );
      }
      delayMs *= 2;
    }
  }
}
