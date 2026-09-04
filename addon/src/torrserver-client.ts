import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import { z } from "zod";
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

export class TorrServerError extends Error {}

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

  async addMagnet(link: string, title?: string): Promise<TorrentStatus> {
    return torrentStatusSchema.parse(
      await this.torrentAction({
        action: "add",
        link,
        title,
        save_to_db: false,
      }),
    );
  }

  async addTorrentFile(path: string, title?: string): Promise<TorrentStatus> {
    const form = new FormData();
    form.append(
      "file",
      new Blob([Uint8Array.from(await readFile(path))]),
      basename(path),
    );
    if (title) form.append("title", title);
    const response = await this.request(
      "/torrent/upload",
      {
        method: "POST",
        body: form,
      },
      1,
    );
    const statuses = torrentListSchema.parse(await response.json());
    if (!statuses[0])
      throw new TorrServerError("TorrServer did not accept the torrent file");
    return statuses[0];
  }

  async get(hash: string): Promise<TorrentStatus> {
    return torrentStatusSchema.parse(
      await this.torrentAction({ action: "get", hash }),
    );
  }

  async list(): Promise<TorrentStatus[]> {
    return torrentListSchema.parse(
      await this.torrentAction({ action: "list" }),
    );
  }

  async waitForFiles(hash: string, timeoutMs = 30_000): Promise<TorrentStatus> {
    const deadline = Date.now() + timeoutMs;
    do {
      const status = await this.get(hash);
      if (status.file_stats.length) return status;
      await new Promise((resolve) => setTimeout(resolve, 500));
    } while (Date.now() < deadline);
    throw new TorrServerError("Timed out waiting for torrent metadata");
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

  private async torrentAction(payload: object): Promise<unknown> {
    const response = await this.request("/torrents", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (
      response.status === 204 ||
      response.headers.get("content-length") === "0"
    )
      return undefined;
    return response.json();
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
      let failure: string;
      try {
        const response = await fetch(`${this.baseUrl}${path}`, {
          ...init,
          signal: AbortSignal.timeout(this.timeoutMs),
        });
        if (response.ok) return response;
        // Release the connection: an unread body keeps the socket pinned
        // until GC, which starves the pool during retry storms.
        await response.body?.cancel().catch(() => undefined);
        if (response.status < 500) {
          throw new TorrServerError(
            `TorrServer ${response.status} ${response.statusText}`,
          );
        }
        failure = `TorrServer ${response.status} ${response.statusText}`;
      } catch (error) {
        if (error instanceof TorrServerError) throw error;
        failure = `TorrServer request failed: ${error instanceof Error ? error.message : error}`;
      }
      if (attempt >= attempts) throw new TorrServerError(failure);
      await new Promise((resolve) => setTimeout(resolve, delayMs));
      delayMs *= 2;
    }
  }
}
