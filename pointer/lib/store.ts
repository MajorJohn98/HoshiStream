import { head, put } from "@vercel/blob";
import {
  blobPathname,
  pointerRecordSchema,
  type PointerRecord,
} from "./relay.js";

// Serverless instances are reused between invocations; a short-lived cache
// keeps redirect latency low without making stale pointers linger after a
// push (pushes are rare and manual).
const CACHE_TTL_MS = 10_000;

interface Cached {
  record: PointerRecord | undefined;
  expiresAt: number;
}

let cache: Cached | undefined;

export function resetPointerCache(): void {
  cache = undefined;
}

export async function savePointer(
  pushSecret: string,
  record: PointerRecord,
): Promise<void> {
  await put(blobPathname(pushSecret), JSON.stringify(record), {
    access: "public",
    addRandomSuffix: false,
    allowOverwrite: true,
    contentType: "application/json",
    cacheControlMaxAge: 60,
  });
  cache = { record, expiresAt: Date.now() + CACHE_TTL_MS };
}

export async function loadPointer(
  pushSecret: string,
): Promise<PointerRecord | undefined> {
  if (cache && cache.expiresAt > Date.now()) return cache.record;
  let record: PointerRecord | undefined;
  try {
    const blob = await head(blobPathname(pushSecret));
    const response = await fetch(`${blob.url}?ts=${Date.now()}`, {
      signal: AbortSignal.timeout(5_000),
    });
    if (response.ok) record = pointerRecordSchema.parse(await response.json());
  } catch {
    record = undefined;
  }
  cache = { record, expiresAt: Date.now() + CACHE_TTL_MS };
  return record;
}
