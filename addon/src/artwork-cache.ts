// Local artwork copies (ADR 0026). Cinemeta hands out poster, background
// and logo URLs; entries keep those URLs, and this cache stores one copy
// of each image under ARTWORK_DIR so players get the same artwork when
// the CDN is slow, blocked or gone. Files are named
// <base64url(entryId)>/<kind>.<ext>; a fetch is skipped when the stored
// copy already came from the same URL.
import { createHash } from "node:crypto";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { containsPath } from "./path-safety.ts";
import type { ArtworkKind, ArtworkRef } from "./types.ts";
import { ARTWORK_KINDS } from "./types.ts";

const TIMEOUT_MS = 15_000;
const MAX_BYTES = 5_000_000;
const EXTENSIONS: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
};
const CONTENT_TYPES: Record<string, string> = {
  jpg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
};

export interface ArtworkCacheOptions {
  dir: string;
  fetch?: typeof fetch;
  userAgent?: string;
  now?: () => Date;
}

export interface StoredArtwork {
  path: string;
  contentType: string;
  size: number;
  etag: string;
}

function folderFor(entryId: string): string {
  return Buffer.from(entryId, "utf8").toString("base64url");
}

export function isArtworkKind(value: string): value is ArtworkKind {
  return (ARTWORK_KINDS as readonly string[]).includes(value);
}

export class ArtworkCache {
  readonly dir: string;
  readonly #fetch: typeof fetch;
  readonly #userAgent: string;
  readonly #now: () => Date;

  constructor(options: ArtworkCacheOptions) {
    this.dir = options.dir;
    this.#fetch = options.fetch ?? fetch;
    this.#userAgent = options.userAgent ?? "HoshiStream";
    this.#now = options.now ?? (() => new Date());
  }

  /**
   * Download `sourceUrl` for `kind` unless `current` already holds it.
   * Returns the ref to store, or `undefined` when the image could not be
   * fetched — callers keep the remote URL and try again on the next refresh.
   */
  async store(
    entryId: string,
    kind: ArtworkKind,
    sourceUrl: string,
    current?: ArtworkRef,
  ): Promise<ArtworkRef | undefined> {
    if (current?.sourceUrl === sourceUrl) {
      const existing = await this.stat(entryId, kind, current);
      if (existing) return current;
    }
    if (!/^https:\/\//.test(sourceUrl)) return undefined;
    let response: Response;
    try {
      response = await this.#fetch(sourceUrl, {
        headers: { accept: "image/*", "user-agent": this.#userAgent },
        redirect: "follow",
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch {
      this.#log(kind, "fetch-failed");
      return undefined;
    }
    if (!response.ok) {
      this.#log(kind, `status-${response.status}`);
      return undefined;
    }
    const mime = (response.headers.get("content-type") ?? "")
      .split(";")[0]
      ?.trim()
      .toLowerCase();
    const ext = mime ? EXTENSIONS[mime] : undefined;
    if (!ext) {
      await response.body?.cancel().catch(() => undefined);
      this.#log(kind, "unsupported-type");
      return undefined;
    }
    const body = await this.#read(response);
    if (!body) {
      this.#log(kind, "too-large");
      return undefined;
    }
    const file = `${kind}.${ext}`;
    const target = this.#pathFor(entryId, file);
    const partial = `${target}.part`;
    await mkdir(dirname(target), { recursive: true });
    try {
      await writeFile(partial, body);
      await rename(partial, target);
    } catch {
      await rm(partial, { force: true }).catch(() => undefined);
      this.#log(kind, "write-failed");
      return undefined;
    }
    // Drop a stale copy with a different extension (jpg → png swap).
    for (const other of Object.keys(CONTENT_TYPES)) {
      if (other === ext) continue;
      await rm(this.#pathFor(entryId, `${kind}.${other}`), {
        force: true,
      }).catch(() => undefined);
    }
    return {
      file,
      bytes: body.byteLength,
      etag: `"${createHash("sha1").update(body).digest("hex").slice(0, 32)}"`,
      fetchedAt: this.#now().toISOString(),
      sourceUrl,
    };
  }

  /** Local file for an artwork ref, when the file is still on disk. */
  async stat(
    entryId: string,
    kind: ArtworkKind,
    ref: ArtworkRef,
  ): Promise<StoredArtwork | undefined> {
    if (!ref.file.startsWith(`${kind}.`)) return undefined;
    const path = this.#pathFor(entryId, ref.file);
    try {
      const info = await stat(path);
      if (!info.isFile()) return undefined;
      const ext = ref.file.slice(ref.file.lastIndexOf(".") + 1);
      const contentType = CONTENT_TYPES[ext];
      if (!contentType) return undefined;
      return { path, contentType, size: info.size, etag: ref.etag };
    } catch {
      return undefined;
    }
  }

  async read(path: string): Promise<Buffer> {
    if (!containsPath(this.dir, path)) throw new Error("Artwork path escape");
    return readFile(path);
  }

  /** Remove every cached image for an entry (entry delete or unlink). */
  async remove(entryId: string): Promise<void> {
    await rm(join(this.dir, folderFor(entryId)), {
      recursive: true,
      force: true,
    });
  }

  #pathFor(entryId: string, file: string): string {
    const path = join(this.dir, folderFor(entryId), file);
    if (!containsPath(this.dir, path)) throw new Error("Artwork path escape");
    return path;
  }

  async #read(response: Response): Promise<Buffer | undefined> {
    const declared = Number(response.headers.get("content-length") ?? 0);
    if (declared > MAX_BYTES) {
      await response.body?.cancel().catch(() => undefined);
      return undefined;
    }
    const reader = response.body?.getReader();
    if (!reader) {
      const buffer = Buffer.from(await response.arrayBuffer());
      return buffer.byteLength > MAX_BYTES ? undefined : buffer;
    }
    const chunks: Uint8Array[] = [];
    let size = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_BYTES) {
        await reader.cancel().catch(() => undefined);
        return undefined;
      }
      chunks.push(value);
    }
    return Buffer.concat(chunks);
  }

  #log(kind: ArtworkKind, reason: string) {
    console.warn(
      JSON.stringify({
        level: "warn",
        event: "artwork_cache_skip",
        kind,
        reason,
      }),
    );
  }
}
