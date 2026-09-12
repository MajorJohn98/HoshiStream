import { BlobNotFoundError, del, get, head, list, put } from "@vercel/blob";
import { randomBytes } from "node:crypto";
import { z } from "zod";
import {
  POINTER_TTL_SECONDS,
  blobPathname,
  legacyPointerRecordSchema,
  pointerRecordSchema,
  recordBlobPathname,
  recordBlobPrefix,
  recordBlobVersionPathname,
  type LegacyPointerRecord,
  type PointerRecord,
} from "./relay.js";

// Serverless instances are reused between invocations; a short-lived bounded
// cache keeps redirect latency low without making stale pointers linger
// after a push (pushes are rare and manual).
const CACHE_TTL_MS = 10_000;
const CACHE_MAX_ENTRIES = 256;

interface Cached {
  record: PointerRecord | undefined;
  expiresAt: number;
}

const cache = new Map<string, Cached>();

export function resetPointerCache(): void {
  cache.clear();
}

function cacheSet(tokenHash: string, record: PointerRecord | undefined): void {
  if (cache.size >= CACHE_MAX_ENTRIES) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  cache.set(tokenHash, { record, expiresAt: Date.now() + CACHE_TTL_MS });
}

// --- Redis driver (Upstash REST API via fetch — no extra dependency) ------

interface RedisEnv {
  url: string;
  token: string;
}

const redisResultSchema = z
  .object({
    result: z.unknown(),
    error: z.string().optional(),
  })
  .refine((value) => !value.error && Object.hasOwn(value, "result"), {
    message: "Pointer storage command failed",
  });

export function redisEnv(): RedisEnv | undefined {
  const url = process.env.UPSTASH_REDIS_REST_URL ?? process.env.KV_REST_API_URL;
  const token =
    process.env.UPSTASH_REDIS_REST_TOKEN ?? process.env.KV_REST_API_TOKEN;
  if (!url || !token) return undefined;
  return { url: url.replace(/\/+$/, ""), token };
}

export async function redisCommand(
  command: (string | number)[],
): Promise<unknown> {
  const env = redisEnv();
  if (!env) throw new Error("Redis is not configured");
  const response = await fetch(env.url, {
    method: "POST",
    headers: {
      authorization: `Bearer ${env.token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(command),
    signal: AbortSignal.timeout(5_000),
  });
  if (!response.ok) {
    throw new Error(`Redis command failed with status ${response.status}`);
  }
  const parsed = redisResultSchema.parse(await response.json());
  return parsed.result;
}

export async function redisPipeline(
  commands: (string | number)[][],
): Promise<unknown[]> {
  const env = redisEnv();
  if (!env) throw new Error("Redis is not configured");
  const response = await fetch(`${env.url}/pipeline`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${env.token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(commands),
    signal: AbortSignal.timeout(5_000),
  });
  if (!response.ok) {
    throw new Error(`Redis pipeline failed with status ${response.status}`);
  }
  const parsed = z.array(redisResultSchema).parse(await response.json());
  return parsed.map((entry) => entry.result);
}

function redisKey(tokenHash: string): string {
  return `hoshistream:pointer:${tokenHash}`;
}

// --- Blob driver (fallback when no Redis is configured) --------------------

// Blob reads go through Vercel's CDN, which ignores cache-busting query
// strings and has been observed serving an in-place-overwritten record for
// days (pushes "succeeded" while the relay kept redirecting to an old LAN
// address). A public store offers no origin read, so v3 never overwrites:
// each push is a new immutable blob under the tenant prefix, located with the
// `list` API (not the CDN), and superseded versions are deleted best-effort.

const BLOB_TIMEOUT_MS = 5_000;

async function blobReadJson(pathname: string): Promise<unknown> {
  const result = await get(pathname, {
    access: "public",
    abortSignal: AbortSignal.timeout(BLOB_TIMEOUT_MS),
  });
  if (result === null) return undefined;
  if (result.statusCode !== 200) throw new Error("Pointer storage read failed");
  return (await new Response(result.stream).json()) as unknown;
}

interface BlobVersions {
  newest: { pathname: string; url: string } | undefined;
  superseded: string[];
}

async function blobListVersions(tokenHash: string): Promise<BlobVersions> {
  const prefix = recordBlobPrefix(tokenHash);
  const blobs: { pathname: string; url: string }[] = [];
  let cursor: string | undefined;
  do {
    const page = await list({
      prefix,
      cursor,
      abortSignal: AbortSignal.timeout(BLOB_TIMEOUT_MS),
    });
    for (const blob of page.blobs) {
      blobs.push({ pathname: blob.pathname, url: blob.url });
    }
    cursor = page.hasMore ? page.cursor : undefined;
  } while (cursor);
  blobs.sort((a, b) => (a.pathname < b.pathname ? 1 : -1));
  const [newest, ...rest] = blobs;
  return { newest, superseded: rest.map((blob) => blob.url) };
}

// Superseded versions are garbage, not state: the newest pathname already
// wins, so a failed cleanup must never fail the push or the redirect.
async function blobDeleteQuietly(urls: string[]): Promise<void> {
  if (urls.length === 0) return;
  try {
    await del(urls, { abortSignal: AbortSignal.timeout(BLOB_TIMEOUT_MS) });
  } catch {
    // Retried implicitly by the next push or delete.
  }
}

async function legacyBlobUrl(tokenHash: string): Promise<string | undefined> {
  try {
    const blob = await head(recordBlobPathname(tokenHash), {
      abortSignal: AbortSignal.timeout(BLOB_TIMEOUT_MS),
    });
    return blob.url;
  } catch (error) {
    if (error instanceof BlobNotFoundError) return undefined;
    throw error;
  }
}

async function blobSave(record: PointerRecord): Promise<void> {
  const pathname = recordBlobVersionPathname(
    record.tokenHash,
    Date.now(),
    randomBytes(4).toString("hex"),
  );
  await put(pathname, JSON.stringify(record), {
    access: "public",
    addRandomSuffix: false,
    allowOverwrite: false,
    contentType: "application/json",
    abortSignal: AbortSignal.timeout(BLOB_TIMEOUT_MS),
  });
  const { superseded } = await blobListVersions(record.tokenHash);
  const legacy = await legacyBlobUrl(record.tokenHash).catch(() => undefined);
  await blobDeleteQuietly([...superseded, ...(legacy ? [legacy] : [])]);
}

async function blobLoad(tokenHash: string): Promise<unknown> {
  const { newest } = await blobListVersions(tokenHash);
  if (newest) return blobReadJson(newest.pathname);
  // Tenants that have not pushed since the v3 rollout still resolve through
  // their v2 record (possibly CDN-stale) until their next push replaces it.
  return blobReadJson(recordBlobPathname(tokenHash));
}

async function blobDelete(tokenHash: string): Promise<void> {
  const { newest, superseded } = await blobListVersions(tokenHash);
  const legacy = await legacyBlobUrl(tokenHash);
  const urls = [
    ...(newest ? [newest.url] : []),
    ...superseded,
    ...(legacy ? [legacy] : []),
  ];
  if (urls.length > 0) {
    await del(urls, { abortSignal: AbortSignal.timeout(BLOB_TIMEOUT_MS) });
  }
}

// --- Public API -------------------------------------------------------------

function isExpired(record: PointerRecord): boolean {
  const expiresAt = Date.parse(record.expiresAt);
  return Number.isFinite(expiresAt) && expiresAt <= Date.now();
}

export async function savePointerRecord(record: PointerRecord): Promise<void> {
  if (redisEnv()) {
    await redisCommand([
      "SET",
      redisKey(record.tokenHash),
      JSON.stringify(record),
      "EX",
      POINTER_TTL_SECONDS,
    ]);
  } else {
    await blobSave(record);
  }
  cacheSet(record.tokenHash, record);
}

export async function loadPointerRecord(
  tokenHash: string,
): Promise<PointerRecord | undefined> {
  const cached = cache.get(tokenHash);
  if (cached && cached.expiresAt > Date.now())
    return cached.record && !isExpired(cached.record)
      ? cached.record
      : undefined;
  let record: PointerRecord | undefined;
  try {
    const raw = redisEnv()
      ? await redisCommand(["GET", redisKey(tokenHash)])
      : await blobLoad(tokenHash);
    const value = typeof raw === "string" ? JSON.parse(raw) : raw;
    if (value !== undefined && value !== null) {
      const parsed = pointerRecordSchema.parse(value);
      if (!isExpired(parsed)) record = parsed;
    }
  } catch (error) {
    if (!(error instanceof BlobNotFoundError)) throw error;
  }
  cacheSet(tokenHash, record);
  return record;
}

export async function deletePointerRecord(tokenHash: string): Promise<void> {
  if (redisEnv()) {
    await redisCommand(["DEL", redisKey(tokenHash)]);
  } else {
    await blobDelete(tokenHash);
  }
  cache.delete(tokenHash);
}

// Backward compatibility: read the single-tenant record stored under the
// deployment-wide PUSH_SECRET so an existing install keeps working until its
// first v2 push.
export async function loadLegacyPointer(
  pushSecret: string,
): Promise<LegacyPointerRecord | undefined> {
  try {
    const value = await blobReadJson(blobPathname(pushSecret));
    if (value === undefined || value === null) return undefined;
    return legacyPointerRecordSchema.parse(value);
  } catch (error) {
    if (error instanceof BlobNotFoundError) return undefined;
    throw error;
  }
}
