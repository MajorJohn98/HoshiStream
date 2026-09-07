import { BlobNotFoundError, del, head, put } from "@vercel/blob";
import { z } from "zod";
import {
  POINTER_TTL_SECONDS,
  blobPathname,
  legacyPointerRecordSchema,
  pointerRecordSchema,
  recordBlobPathname,
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

async function blobRead(pathname: string): Promise<unknown> {
  const blob = await head(pathname);
  const response = await fetch(`${blob.url}?ts=${Date.now()}`, {
    signal: AbortSignal.timeout(5_000),
  });
  if (response.status === 404) return undefined;
  if (!response.ok) throw new Error("Pointer storage read failed");
  return (await response.json()) as unknown;
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
    await put(recordBlobPathname(record.tokenHash), JSON.stringify(record), {
      access: "public",
      addRandomSuffix: false,
      allowOverwrite: true,
      contentType: "application/json",
      cacheControlMaxAge: 60,
    });
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
      : await blobRead(recordBlobPathname(tokenHash));
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
    try {
      const blob = await head(recordBlobPathname(tokenHash));
      await del(blob.url);
    } catch (error) {
      if (!(error instanceof BlobNotFoundError)) throw error;
    }
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
    const value = await blobRead(blobPathname(pushSecret));
    if (value === undefined || value === null) return undefined;
    return legacyPointerRecordSchema.parse(value);
  } catch (error) {
    if (error instanceof BlobNotFoundError) return undefined;
    throw error;
  }
}
