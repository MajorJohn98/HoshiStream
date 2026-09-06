import { createHash, randomUUID } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import {
  lstat,
  link,
  mkdir,
  readdir,
  realpath,
  rm,
  rmdir,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { basename, dirname, extname, join, relative, resolve } from "node:path";
import { containsPath, firstSegmentBelow } from "./path-safety.ts";
import { pipeline } from "node:stream/promises";
import { isPlayablePath, selectMediaFiles } from "./media-file-selection.ts";
import type { LibraryEntry } from "./types.ts";
import {
  MAX_TORRENT_BYTES,
  torrentIdentity,
} from "./imports/source-identity.ts";
import { stateRoot } from "./config-schema.ts";
import { ImportError } from "./imports/errors.ts";

const MEDIA_ROOT = resolve(process.env.MEDIA_ROOT ?? "/media");
const UPLOAD_ROOT = resolve(
  process.env.UPLOAD_ROOT ?? join(stateRoot(), "media"),
);
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

export function mediaContentType(path: string): string {
  return (
    CONTENT_TYPES[extname(path).toLowerCase()] ?? "application/octet-stream"
  );
}

// Media players issue many range requests per seek. Without this cache each one
// re-walks the entry's directory tree and stats every file it contains.
const INSPECTION_TTL_MS = 30_000;
const INSPECTION_CACHE_LIMIT = 256;
const MEDIA_HIGH_WATER_MARK = 4 * 1024 * 1024;

type LocalInspection = {
  files: Array<{ id: number; path: string; length: number; localPath: string }>;
  selectedFiles: ReturnType<typeof selectMediaFiles>;
};

const inspectionCache = new Map<
  string,
  {
    signature: string;
    mtimeMs: number;
    expiresAt: number;
    value: LocalInspection;
  }
>();

function selectionSignature(entry: LibraryEntry): string {
  return JSON.stringify([
    entry.type,
    entry.localFilePath,
    entry.localFolderPath,
    entry.preferredFileIndex,
    entry.fileOverrides,
  ]);
}

export function clearLocalInspectionCache(entryId?: string): void {
  if (entryId) inspectionCache.delete(entryId);
  else inspectionCache.clear();
}

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
    if (root && containsPath(root, actual)) {
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
  return Boolean(root && containsPath(root, actual));
}

export async function inspectLocalEntry(entry: LibraryEntry) {
  const source = entry.localFolderPath ?? entry.localFilePath;
  if (!source) return;
  const root = await realpath(source);
  const info = await stat(root);
  const signature = selectionSignature(entry);
  const cached = inspectionCache.get(entry.id);
  if (
    cached &&
    cached.signature === signature &&
    cached.mtimeMs === info.mtimeMs &&
    cached.expiresAt > Date.now()
  ) {
    return cached.value;
  }
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
  const value = {
    files,
    selectedFiles: selectMediaFiles(
      entry.type,
      files,
      entry.preferredFileIndex,
      entry.fileOverrides,
    ),
  };
  if (inspectionCache.size >= INSPECTION_CACHE_LIMIT) {
    const oldest = inspectionCache.keys().next();
    if (!oldest.done) inspectionCache.delete(oldest.value);
  }
  inspectionCache.set(entry.id, {
    signature,
    mtimeMs: info.mtimeMs,
    expiresAt: Date.now() + INSPECTION_TTL_MS,
    value,
  });
  return value;
}

export async function listLocalMedia(): Promise<string[]> {
  return (await walk(MEDIA_ROOT)).sort();
}

export async function saveUpload(
  request: IncomingMessage,
  batch: string,
  relativePath: string,
): Promise<{ path: string; folderRoot: string }> {
  if (!UUID_V4.test(batch) || !relativePath)
    throw new SyntaxError("Invalid upload path");
  const uploadRoot = await ensureUploadRoot(UPLOAD_ROOT);
  const batchRoot = resolve(uploadRoot, batch);
  const destination = resolve(batchRoot, relativePath);
  if (!containsPath(batchRoot, destination) || !isPlayablePath(destination))
    throw new SyntaxError("Invalid upload path");
  await ensureOwnedDirectory(uploadRoot, dirname(destination));
  const temporary = uploadTemporaryPath(destination);
  const hash = createHash("sha256");
  let size = 0;
  try {
    await pipeline(
      request,
      async function* (source) {
        for await (const chunk of source) {
          const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          size += bytes.length;
          hash.update(bytes);
          yield bytes;
        }
      },
      createWriteStream(temporary, { flags: "wx", mode: 0o600 }),
    );
    await publishOwnedFile(destination, temporary, size, hash.digest("hex"));
  } catch (error) {
    await unlink(temporary).catch(() => undefined);
    throw error;
  }
  await unlink(temporary).catch(() => undefined);
  return { path: destination, folderRoot: batchRoot };
}

export async function saveTorrentUpload(
  request: IncomingMessage,
  batch: string,
  name: string,
): Promise<string> {
  if (!UUID_V4.test(batch) || extname(name).toLowerCase() !== ".torrent")
    throw new SyntaxError("Invalid torrent upload");
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_TORRENT_BYTES)
      throw new SyntaxError("Torrent file exceeds 1 MB");
    chunks.push(chunk);
  }
  const data = Buffer.concat(chunks);
  await torrentIdentity(data);
  return saveTorrentBytes(data, batch, name);
}

export async function saveTorrentBytes(
  data: Uint8Array,
  batch: string,
  name: string,
  root = UPLOAD_ROOT,
): Promise<string> {
  if (!UUID_V4.test(batch) || extname(name).toLowerCase() !== ".torrent")
    throw new SyntaxError("Invalid torrent upload");
  if (data.length > MAX_TORRENT_BYTES)
    throw new SyntaxError("Torrent file exceeds 1 MB");
  const lexicalRoot = resolve(root);
  const uploadRoot = await ensureUploadRoot(lexicalRoot);
  const directory = resolve(uploadRoot, batch);
  await ensureOwnedDirectory(uploadRoot, directory);
  const destination = resolve(directory, basename(name));
  const returnedPath = resolve(lexicalRoot, batch, basename(name));
  const temporary = uploadTemporaryPath(destination);
  await writeFile(temporary, data, { flag: "wx", mode: 0o600 });
  try {
    await publishOwnedFile(
      destination,
      temporary,
      data.length,
      createHash("sha256").update(data).digest("hex"),
    );
  } catch (error) {
    await unlink(temporary).catch(() => undefined);
    throw error;
  }
  await unlink(temporary).catch(() => undefined);
  return returnedPath;
}

function mediaPaths(entry: LibraryEntry): string[] {
  return [
    entry.localFolderPath,
    entry.localFilePath,
    entry.torrentFilePath,
    ...(entry.extraSources ?? []).map((source) => source.torrentFilePath),
  ].filter((path): path is string => Boolean(path));
}

async function existingRealpath(path: string): Promise<string | undefined> {
  try {
    return await realpath(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
}

export async function removeManagedMedia(
  entry: LibraryEntry,
  referencedEntries: LibraryEntry[] = [],
  uploadRoot = UPLOAD_ROOT,
): Promise<void> {
  const owned = [
    ...(entry.managedMedia
      ? [entry.localFolderPath ?? entry.localFilePath ?? entry.torrentFilePath]
      : []),
    ...(entry.extraSources ?? [])
      .filter((source) => source.managedMedia)
      .map((source) => source.torrentFilePath),
  ].filter((path): path is string => Boolean(path));
  if (!owned.length) return;
  const root = resolve(uploadRoot);
  const actualRoot = await existingRealpath(root);
  if (!actualRoot) return;
  const references = await Promise.all(
    referencedEntries.flatMap(mediaPaths).map(async (path) => ({
      lexical: resolve(path),
      actual: await existingRealpath(path),
    })),
  );
  const overlaps = (a: string, b: string) =>
    a === b || containsPath(a, b) || containsPath(b, a);
  for (const path of new Set(owned)) {
    const source = resolve(path);
    const batch = firstSegmentBelow(root, source);
    if (!batch || !UUID_V4.test(batch)) continue;
    const actual = await existingRealpath(source);
    if (
      !actual ||
      !containsPath(actualRoot, actual) ||
      // Never follow a replaced file or intermediate directory symlink.
      actual !== resolve(actualRoot, relative(root, source)) ||
      references.some(
        (reference) =>
          overlaps(source, reference.lexical) ||
          (reference.actual && overlaps(actual, reference.actual)),
      )
    )
      continue;
    // A managed file owns only itself, not other user files in its batch.
    await rm(source, {
      recursive: source === entry.localFolderPath,
      force: true,
    });
    for (
      let directory = dirname(source);
      containsPath(root, directory);
      directory = dirname(directory)
    ) {
      try {
        await rmdir(directory);
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === "ENOENT") continue;
        if (code === "ENOTEMPTY" || code === "EEXIST") break;
        throw error;
      }
    }
  }
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
  request.socket.setNoDelay(true);
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
  createReadStream(local.localPath, {
    ...range,
    highWaterMark: MEDIA_HIGH_WATER_MARK,
  }).pipe(response);
}

function uploadTemporaryPath(destination: string): string {
  return join(
    dirname(destination),
    `.${basename(destination)}.${randomUUID()}.pending`,
  );
}

async function ensureUploadRoot(root: string): Promise<string> {
  await mkdir(root, { recursive: true, mode: 0o700 });
  return realpath(root);
}

async function ensureOwnedDirectory(
  root: string,
  directory: string,
): Promise<void> {
  if (directory !== root && !containsPath(root, directory))
    throw new SyntaxError("Invalid upload path");
  let current = root;
  for (const segment of relative(root, directory)
    .split(/[\\/]/)
    .filter(Boolean)) {
    current = join(current, segment);
    try {
      const info = await lstat(current);
      if (info.isSymbolicLink() || !info.isDirectory())
        throw new SyntaxError("Invalid upload path");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      await mkdir(current, { mode: 0o700 });
    }
  }
}

async function publishOwnedFile(
  destination: string,
  temporary: string,
  size: number,
  digest: string,
): Promise<void> {
  try {
    // Publish atomically without replacing an existing file.
    await link(temporary, destination);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    if (await fileMatches(destination, size, digest)) return;
    throw new ImportError(
      "upload_conflict",
      "A file already exists at this path with different content.",
      409,
    );
  }
}

async function fileMatches(
  path: string,
  expectedSize: number,
  expectedDigest: string,
): Promise<boolean> {
  const info = await lstat(path);
  if (info.isSymbolicLink() || !info.isFile())
    throw new SyntaxError("Invalid upload path");
  if (info.size !== expectedSize) return false;
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) {
    hash.update(chunk);
  }
  return hash.digest("hex") === expectedDigest;
}
