import { open, stat } from "node:fs/promises";

// OpenSubtitles hash: file size plus the sum of the 64-bit little-endian
// words in the first and last 64 KiB, modulo 2^64, as 16 lowercase hex
// digits. Stremio passes it to subtitle add-ons as behaviorHints.videoHash.
// Only ever computed over files on local disk, never over a torrent stream.
const CHUNK = 64 * 1024;
const MASK = (1n << 64n) - 1n;
const CACHE_LIMIT = 512;

const cache = new Map<string, string>();

export function hashChunks(
  size: number,
  head: Uint8Array,
  tail: Uint8Array,
): string {
  let sum = BigInt(size);
  for (const chunk of [head, tail]) {
    const view = new DataView(
      chunk.buffer,
      chunk.byteOffset,
      chunk.byteLength - (chunk.byteLength % 8),
    );
    for (let offset = 0; offset < view.byteLength; offset += 8)
      sum = (sum + view.getBigUint64(offset, true)) & MASK;
  }
  return sum.toString(16).padStart(16, "0");
}

// Undefined for files smaller than two chunks (the reference implementation
// does not define them) or when the file cannot be read.
export async function openSubtitlesHash(
  path: string,
): Promise<string | undefined> {
  let info;
  try {
    info = await stat(path);
  } catch {
    return undefined;
  }
  if (!info.isFile() || info.size < 2 * CHUNK) return undefined;
  const key = `${path}\u0000${info.size}\u0000${info.mtimeMs}`;
  const cached = cache.get(key);
  if (cached) return cached;
  let handle;
  try {
    handle = await open(path, "r");
    const head = new Uint8Array(CHUNK);
    const tail = new Uint8Array(CHUNK);
    const [first, last] = await Promise.all([
      handle.read(head, 0, CHUNK, 0),
      handle.read(tail, 0, CHUNK, info.size - CHUNK),
    ]);
    if (first.bytesRead !== CHUNK || last.bytesRead !== CHUNK) return undefined;
    const hash = hashChunks(info.size, head, tail);
    if (cache.size >= CACHE_LIMIT) {
      const oldest = cache.keys().next().value;
      if (oldest !== undefined) cache.delete(oldest);
    }
    cache.set(key, hash);
    return hash;
  } catch {
    return undefined;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

export function clearVideoHashCache(): void {
  cache.clear();
}
