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

const torrentStatusSchema = z.object({
  title: z.string().default(""),
  name: z.string().optional(),
  hash: z.string().min(1),
  stat: z.number().int(),
  stat_string: z.string(),
  file_stats: z.array(torrentFileSchema).optional().default([]),
  // Optional live stats (verified against MatriX.141 server/torr/state/state.go)
  // surfaced by the Devices panel; absent unless the torrent is active.
  loaded_size: z.number().optional(),
  torrent_size: z.number().optional(),
  download_speed: z.number().optional(),
  upload_speed: z.number().optional(),
  active_peers: z.number().optional(),
  connected_seeders: z.number().optional(),
});

const torrentListSchema = z.array(torrentStatusSchema);

export type TorrentStatus = z.infer<typeof torrentStatusSchema>;

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
