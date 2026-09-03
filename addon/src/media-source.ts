import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream as WebReadableStream } from "node:stream/web";
import {
  buildManifest,
  computeSourceRevision,
  destinationPath,
  sourceKey,
} from "./disk-copy.js";
import { resolveStreamSource } from "./inspection.js";
import type { Library } from "./library.js";
import { mediaContentType, mediaHeaders, parseRange } from "./local-media.js";
import type { TorrServerClient } from "./torrserver-client.js";
import type { LibraryEntry } from "./types.js";
import type { VolumeRegistry } from "./volumes.js";

const MEDIA_HIGH_WATER_MARK = 4 * 1024 * 1024;

/**
 * The disk file backing a source key, or undefined when playback must fall
 * back to the torrent. Every gate from the plan applies: keep intent, file
 * included and complete, manifest revision current, volume uniquely online,
 * destination contained, regular file of the expected size. Persisted state
 * is only a hint — the filesystem has the final word.
 */
export async function diskSourcePath(
  entry: LibraryEntry,
  key: string,
  volumes: VolumeRegistry,
): Promise<{ path: string; length: number } | undefined> {
  const diskCopy = entry.diskCopy;
  if (!diskCopy || diskCopy.desired !== "keep") return undefined;
  const file = diskCopy.files.find(
    (candidate) => candidate.sourceKey === key && candidate.included,
  );
  if (!file || file.state !== "complete") return undefined;
  if (entry.inspectionCache) {
    // The selection changed since the manifest was built: the copy is stale
    // and must not shadow the current source.
    const current = computeSourceRevision(
      buildManifest(entry, { scope: diskCopy.scope, previous: diskCopy.files }),
    );
    if (current !== diskCopy.sourceRevision) return undefined;
  }
  const resolution = await volumes.resolve(diskCopy.volumeId);
  if (resolution.state !== "online") return undefined;
  let destination: string;
  try {
    destination = destinationPath(
      resolution.root,
      diskCopy.relativeDir,
      file.relativePath,
    );
  } catch {
    return undefined;
  }
  const info = await stat(destination).catch(() => undefined);
  if (!info?.isFile() || info.size !== file.length) return undefined;
  return { path: destination, length: file.length };
}

function serveDiskFile(
  request: IncomingMessage,
  response: ServerResponse,
  file: { path: string; length: number },
): void {
  const range = parseRange(request.headers.range, file.length);
  if (!range) {
    response
      .writeHead(416, { "content-range": `bytes */${file.length}` })
      .end();
    return;
  }
  const partial = Boolean(request.headers.range);
  request.socket.setNoDelay(true);
  response.writeHead(
    partial ? 206 : 200,
    mediaHeaders(file.length, range, partial, mediaContentType(file.path)),
  );
  if (request.method === "HEAD") {
    response.end();
    return;
  }
  // A drive yanked mid-read ends this response; the client's next range
  // request re-resolves the source and falls back to the torrent.
  createReadStream(file.path, {
    ...range,
    highWaterMark: MEDIA_HIGH_WATER_MARK,
  })
    .on("error", () => response.destroy())
    .pipe(response);
}

async function proxyTorrent(
  request: IncomingMessage,
  response: ServerResponse,
  entry: LibraryEntry,
  key: string,
  torrServer: TorrServerClient,
  library: Library,
): Promise<void> {
  const source = await resolveStreamSource(entry, torrServer, library).catch(
    () => undefined,
  );
  const selected = source?.selectedFiles.find(
    (candidate) => sourceKey(source.hash, candidate) === key,
  );
  if (!source || !selected) {
    response.writeHead(404, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: "Unknown media file" }));
    return;
  }
  const controller = new AbortController();
  response.once("close", () => controller.abort());
  let upstream: Response;
  try {
    upstream = await fetch(torrServer.streamUrl(source.hash, selected), {
      method: request.method === "HEAD" ? "HEAD" : "GET",
      headers: request.headers.range
        ? { range: request.headers.range }
        : undefined,
      signal: controller.signal,
    });
  } catch {
    response.writeHead(502, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: "Stream source unavailable" }));
    return;
  }
  const headers: Record<string, string> = {};
  for (const name of [
    "content-type",
    "content-length",
    "content-range",
    "accept-ranges",
  ]) {
    const value = upstream.headers.get(name);
    if (value) headers[name] = value;
  }
  response.writeHead(upstream.status, headers);
  if (request.method === "HEAD" || !upstream.body) {
    response.end();
    return;
  }
  await pipeline(
    Readable.fromWeb(upstream.body as WebReadableStream),
    response,
  ).catch(() => response.destroy());
}

/**
 * The stable playback URL's request handler: decides disk vs torrent for
 * every HEAD/ranged GET, so plugging or unplugging a drive changes the
 * source on the client's next request without a new stream URL. Origins
 * never switch mid-response.
 */
export async function serveMediaSource(
  request: IncomingMessage,
  response: ServerResponse,
  entry: LibraryEntry,
  key: string,
  volumes: VolumeRegistry,
  torrServer: TorrServerClient,
  library: Library,
): Promise<void> {
  const disk = await diskSourcePath(entry, key, volumes).catch(() => undefined);
  if (disk) {
    serveDiskFile(request, response, disk);
    return;
  }
  await proxyTorrent(request, response, entry, key, torrServer, library);
}
