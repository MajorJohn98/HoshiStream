import { readdir, readFile, realpath, stat } from "node:fs/promises";
import { dirname, join, relative, sep } from "node:path";
import { resolveStreamSource } from "./inspection.ts";
import type { Library } from "./library.ts";
import { rawFileId, type SelectedFile } from "./media-file-selection.ts";
import { containsPath } from "./path-safety.ts";
import { requestedFile } from "./streams.ts";
import {
  decodeSubtitleBytes,
  isSubtitlePath,
  matchSubtitles,
  servedExtension,
  srtToVtt,
  subtitleContentType,
  subtitleFormat,
  subtitleLanguage,
  type SubtitleCandidate,
} from "./subtitles.ts";
import type { TorrServerClient } from "./torrserver-client.ts";
import type { LibraryEntry } from "./types.ts";

// Sidecars are small; anything larger is not a subtitle file we want to pull
// through the torrent or hold in memory.
export const MAX_SUBTITLE_BYTES = 10 * 1024 * 1024;
const DEFAULT_TTL_MS = 60 * 60 * 1000;
const DEFAULT_MAX_ENTRIES = 64;
const FETCH_TIMEOUT_MS = 20_000;

// Keys name the sidecar without trusting the URL for anything but a lookup:
// torrent files by `<hash>:<TorrServer file id>`, local files by the
// base64url of their entry-relative path. Both are matched against a fresh
// listing before any byte is read.
const TORRENT_KEY = /^([0-9a-f]{40}):(\d+)$/;
const LOCAL_KEY = /^l:([A-Za-z0-9_-]+)$/;

export interface StremioSubtitle {
  id: string;
  url: string;
  lang: string;
  /** Human label (language plus SDH/forced); not part of Stremio's shape. */
  label: string;
}

export interface SubtitlePayload {
  body: Buffer;
  contentType: string;
}

type LocalSidecar = SubtitleCandidate & { localPath: string };

async function walkSubtitles(directory: string): Promise<string[]> {
  const found: string[] = [];
  for (const item of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, item.name);
    if (item.isDirectory()) found.push(...(await walkSubtitles(path)));
    else if (item.isFile() && isSubtitlePath(path)) found.push(path);
  }
  return found;
}

/** Subtitle files inside a local entry, relative to the entry root. */
export async function localSidecars(
  entry: LibraryEntry,
): Promise<{ root: string; files: LocalSidecar[] }> {
  const source = entry.localFolderPath ?? entry.localFilePath;
  if (!source) return { root: "", files: [] };
  const actual = await realpath(source);
  const info = await stat(actual);
  const root = info.isDirectory() ? actual : dirname(actual);
  const paths = info.isDirectory()
    ? await walkSubtitles(root)
    : (await readdir(root, { withFileTypes: true }))
        .filter((item) => item.isFile() && isSubtitlePath(item.name))
        .map((item) => join(root, item.name));
  const files = await Promise.all(
    paths.sort().map(async (path, index) => ({
      id: index,
      path: relative(root, path).split(sep).join("/"),
      length: (await stat(path)).size,
      localPath: path,
    })),
  );
  return { root, files };
}

function localKey(path: string): string {
  return `l:${Buffer.from(path, "utf8").toString("base64url")}`;
}

function sameSource(hash: string, file: SelectedFile, candidate: string) {
  return (file.hash ?? hash) === candidate;
}

/**
 * Lists and serves subtitle sidecars that already exist next to the media:
 * in the torrent's file list (read whole through TorrServer's `/play`) or
 * in a local entry's folder. SRT is converted to WebVTT; results live in
 * memory for an hour. No downloads from third parties, ever.
 */
export class SubtitleService {
  private readonly cache = new Map<
    string,
    { expiresAt: number; payload: SubtitlePayload }
  >();
  private readonly library: Library;
  private readonly torrServer: TorrServerClient;
  private readonly ttlMs: number;
  private readonly maxEntries: number;
  private readonly fetchImpl: typeof fetch;

  constructor(
    library: Library,
    torrServer: TorrServerClient,
    options: {
      ttlMs?: number;
      maxEntries?: number;
      fetchImpl?: typeof fetch;
    } = {},
  ) {
    this.library = library;
    this.torrServer = torrServer;
    this.ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
    this.maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async list(
    type: string,
    id: string,
    publicAddonUrl: string,
    accessToken: string,
  ): Promise<{ subtitles: StremioSubtitle[] }> {
    const requested = requestedFile([], type, id);
    const entry = await this.library.get(requested.entryId);
    if (!entry || entry.type !== type) return { subtitles: [] };
    const source = await resolveStreamSource(
      entry,
      this.torrServer,
      this.library,
    );
    const video = requestedFile(source.selectedFiles, type, id).file;
    if (!video) return { subtitles: [] };
    const soleVideo = entry.type === "movie";
    let matches: ReturnType<typeof matchSubtitles<SubtitleCandidate>>;
    let keyFor: (file: SubtitleCandidate) => string;
    if (entry.localFilePath || entry.localFolderPath) {
      const { files } = await localSidecars(entry);
      matches = matchSubtitles(video, files, { soleVideo });
      keyFor = (file) => localKey(file.path);
    } else {
      const hash = video.hash ?? source.hash;
      const status = await this.torrServer.get(hash);
      const candidates = status.file_stats
        .filter((file) => isSubtitlePath(file.path))
        .map((file) => ({ ...file, hash }));
      matches = matchSubtitles(video, candidates, { soleVideo });
      keyFor = (file) => `${file.hash}:${rawFileId(file.id)}`;
    }
    const prefix = `${publicAddonUrl}/subtitles/${encodeURIComponent(accessToken)}/${encodeURIComponent(entry.id)}`;
    return {
      subtitles: matches
        .filter((match) => match.file.length <= MAX_SUBTITLE_BYTES)
        .map((match) => {
          const key = keyFor(match.file);
          return {
            id: key,
            url: `${prefix}/${key}.${servedExtension(match.format)}`,
            lang: match.lang,
            label: match.label,
          };
        }),
    };
  }

  /**
   * The sidecar named by `key`, converted for `extension`, or undefined when
   * the entry does not own such a file. Throws on upstream failures so the
   * route can answer 502.
   */
  async fetch(
    entryId: string,
    key: string,
    extension: "vtt" | "ass" | "ssa",
  ): Promise<SubtitlePayload | undefined> {
    const cacheKey = `${entryId}\u0000${key}.${extension}`;
    const cached = this.cache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) return cached.payload;
    this.cache.delete(cacheKey);
    const entry = await this.library.get(entryId);
    if (!entry) return undefined;
    const raw =
      entry.localFilePath || entry.localFolderPath
        ? await this.readLocal(entry, key)
        : await this.readTorrent(entry, key);
    if (!raw) return undefined;
    const format = subtitleFormat(raw.path);
    if (!format || servedExtension(format) !== extension) return undefined;
    const text = decodeSubtitleBytes(raw.bytes, subtitleLanguage(raw.path));
    const payload: SubtitlePayload = {
      body: Buffer.from(format === "srt" ? srtToVtt(text) : text, "utf8"),
      contentType: subtitleContentType(extension),
    };
    if (this.cache.size >= this.maxEntries) {
      const oldest = this.cache.keys().next();
      if (!oldest.done) this.cache.delete(oldest.value);
    }
    this.cache.set(cacheKey, {
      expiresAt: Date.now() + this.ttlMs,
      payload,
    });
    return payload;
  }

  private async readLocal(
    entry: LibraryEntry,
    key: string,
  ): Promise<{ path: string; bytes: Uint8Array } | undefined> {
    const match = LOCAL_KEY.exec(key);
    if (!match) return undefined;
    const wanted = Buffer.from(match[1]!, "base64url").toString("utf8");
    const { root, files } = await localSidecars(entry);
    const file = files.find((candidate) => candidate.path === wanted);
    if (!file || file.length > MAX_SUBTITLE_BYTES) return undefined;
    // The listing already came from inside the entry; re-check after
    // resolving links so a swapped symlink cannot point elsewhere.
    const actual = await realpath(file.localPath);
    if (!containsPath(root, actual)) return undefined;
    return { path: file.path, bytes: await readFile(actual) };
  }

  private async readTorrent(
    entry: LibraryEntry,
    key: string,
  ): Promise<{ path: string; bytes: Uint8Array } | undefined> {
    const match = TORRENT_KEY.exec(key);
    if (!match) return undefined;
    const [, hash, rawId] = match;
    const source = await resolveStreamSource(
      entry,
      this.torrServer,
      this.library,
    );
    const owned =
      source.hash === hash ||
      source.selectedFiles.some((file) => sameSource(source.hash, file, hash!));
    if (!owned) return undefined;
    const status = await this.torrServer.get(hash!);
    const file = status.file_stats.find(
      (candidate) => candidate.id === Number(rawId),
    );
    if (!file || !isSubtitlePath(file.path) || file.length > MAX_SUBTITLE_BYTES)
      return undefined;
    const response = await this.fetchImpl(
      this.torrServer.streamUrl(hash!, file),
      { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) },
    );
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      throw new Error(`Subtitle source answered ${response.status}`);
    }
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.length > MAX_SUBTITLE_BYTES)
      throw new Error("Subtitle file exceeds the size limit");
    return { path: file.path, bytes };
  }
}
