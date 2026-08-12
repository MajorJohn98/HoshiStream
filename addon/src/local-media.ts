import { createReadStream, createWriteStream } from "node:fs";
import {
  mkdir,
  readdir,
  realpath,
  rm,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { basename, extname, join, relative, resolve, sep } from "node:path";
import { pipeline } from "node:stream/promises";
import { isPlayablePath, selectMediaFiles } from "./media-file-selection.js";
import type { LibraryEntry } from "./types.js";

const MEDIA_ROOT = resolve(process.env.MEDIA_ROOT ?? "/media");
const UPLOAD_ROOT = resolve(process.env.UPLOAD_ROOT ?? "/data/media");
const UUID_V4 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const CONTENT_TYPES: Record<string, string> = {
  ".avi": "video/x-msvideo",
  ".m4v": "video/x-m4v",
  ".mkv": "video/x-matroska",
  ".mov": "video/quicktime",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
};

async function walk(directory: string): Promise<string[]> {
  const found: string[] = [];
  for (const item of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, item.name);
    if (item.isDirectory()) found.push(...(await walk(path)));
    else if (item.isFile() && isPlayablePath(path)) found.push(path);
  }
  return found;
}

export async function validateBrowserLocalPath(
  path: string,
  kind: "file" | "folder",
): Promise<string> {
  const actual = await realpath(path);
  for (const rootPath of [MEDIA_ROOT, UPLOAD_ROOT]) {
    const root = await realpath(rootPath).catch(() => undefined);
    if (root && actual.startsWith(`${root}${sep}`)) {
      const info = await stat(actual);
      if (kind === "file" && info.isFile() && isPlayablePath(actual))
        return actual;
      if (
        kind === "folder" &&
        info.isDirectory() &&
        (await walk(actual)).length
      )
        return actual;
      break;
    }
  }
  throw new SyntaxError("Local media path is not allowed");
}

export async function isManagedMediaPath(path: string): Promise<boolean> {
  const actual = await realpath(path);
  const root = await realpath(UPLOAD_ROOT).catch(() => undefined);
  return Boolean(root && actual.startsWith(`${root}${sep}`));
}

export async function inspectLocalEntry(entry: LibraryEntry) {
  const source = entry.localFolderPath ?? entry.localFilePath;
  if (!source) return;
  const root = await realpath(source);
  const info = await stat(root);
  const paths = info.isDirectory() ? await walk(root) : [root];
  const files = await Promise.all(
    paths.map(async (path, id) => ({
      id,
      path: info.isDirectory()
        ? relative(root, path)
        : relative(join(root, ".."), path),
      length: (await stat(path)).size,
      localPath: path,
    })),
  );
  return {
    files,
    selectedFiles: selectMediaFiles(
      entry.type,
      files,
      entry.preferredFileIndex,
      entry.fileOverrides,
    ),
  };
}

export async function listLocalMedia(): Promise<string[]> {
  return (await walk(MEDIA_ROOT)).sort();
}

export async function saveUpload(
  request: IncomingMessage,
  batch: string,
  relativePath: string,
): Promise<void> {
  if (!UUID_V4.test(batch) || !relativePath)
    throw new SyntaxError("Invalid upload path");
  const batchRoot = resolve(UPLOAD_ROOT, batch);
  const destination = resolve(batchRoot, relativePath);
  if (
    !destination.startsWith(`${batchRoot}${sep}`) ||
    !isPlayablePath(destination)
  )
    throw new SyntaxError("Invalid upload path");
  await mkdir(resolve(destination, ".."), { recursive: true });
  try {
    await pipeline(request, createWriteStream(destination, { flags: "wx" }));
  } catch (error) {
    await unlink(destination).catch(() => undefined);
    throw error;
  }
}

export async function saveTorrentUpload(
  request: IncomingMessage,
  batch: string,
  name: string,
): Promise<string> {
  if (!UUID_V4.test(batch) || extname(name).toLowerCase() !== ".torrent")
    throw new SyntaxError("Invalid torrent upload");
  const directory = resolve(UPLOAD_ROOT, batch);
  const destination = resolve(directory, basename(name));
  await mkdir(directory, { recursive: true });
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 1_000_000) throw new SyntaxError("Torrent file exceeds 1 MB");
    chunks.push(chunk);
  }
  await writeFile(destination, Buffer.concat(chunks), { flag: "wx" });
  return destination;
}

export async function removeManagedMedia(entry: LibraryEntry): Promise<void> {
  if (!entry.managedMedia) return;
  const source =
    entry.localFolderPath ?? entry.localFilePath ?? entry.torrentFilePath;
  if (!source?.startsWith(`${UPLOAD_ROOT}/`)) return;
  const batch = relative(UPLOAD_ROOT, source).split(sep)[0];
  if (UUID_V4.test(batch))
    await rm(resolve(UPLOAD_ROOT, batch), { recursive: true, force: true });
}

export function parseRange(
  header: string | undefined,
  size: number,
): { start: number; end: number } | undefined {
  if (!header) return { start: 0, end: size - 1 };
  const match = /^bytes=(\d*)-(\d*)$/.exec(header);
  if (!match || (!match[1] && !match[2])) return;
  const start = match[1]
    ? Number(match[1])
    : Math.max(0, size - Number(match[2]));
  const end = match[2] && match[1] ? Number(match[2]) : size - 1;
  if (
    !Number.isSafeInteger(start) ||
    !Number.isSafeInteger(end) ||
    start < 0 ||
    start > end ||
    start >= size
  )
    return;
  return { start, end: Math.min(end, size - 1) };
}

export function mediaHeaders(
  size: number,
  range: { start: number; end: number },
  partial: boolean,
  contentType: string,
) {
  return {
    "accept-ranges": "bytes",
    "content-length": range.end - range.start + 1,
    ...(partial && {
      "content-range": `bytes ${range.start}-${range.end}/${size}`,
    }),
    "content-type": contentType,
  };
}

export async function serveLocalMedia(
  request: IncomingMessage,
  response: ServerResponse,
  entry: LibraryEntry,
  fileId?: number,
): Promise<void> {
  const inspection = await inspectLocalEntry(entry);
  const selected = inspection?.selectedFiles.find(
    (file) => file.id === (fileId ?? inspection.selectedFiles[0]?.id),
  );
  const local = inspection?.files.find((file) => file.id === selected?.id);
  if (!local) {
    response.writeHead(404).end();
    return;
  }
  const range = parseRange(request.headers.range, local.length);
  if (!range) {
    response
      .writeHead(416, { "content-range": `bytes */${local.length}` })
      .end();
    return;
  }
  const partial = Boolean(request.headers.range);
  response.writeHead(
    partial ? 206 : 200,
    mediaHeaders(
      local.length,
      range,
      partial,
      CONTENT_TYPES[extname(local.localPath).toLowerCase()] ??
        "application/octet-stream",
    ),
  );
  if (request.method === "HEAD") {
    response.end();
    return;
  }
  createReadStream(local.localPath, range).pipe(response);
}
