import { redisEnv, redisPipeline } from "./store.js";

// Fixed-window rate limiter. Uses Redis (shared across serverless instances)
// when configured, otherwise a best-effort in-memory window per instance.
// Fails open on backend errors: rate limiting protects against abuse, it must
// never take the service down.

const memory = new Map<string, { count: number; window: number }>();
const MEMORY_MAX_ENTRIES = 4096;

export async function allowRequest(
  bucket: string,
  max: number,
  windowSeconds: number,
): Promise<boolean> {
  const window = Math.floor(Date.now() / 1000 / windowSeconds);
  if (redisEnv()) {
    try {
      const key = `hoshistream:rl:${bucket}:${window}`;
      const [count] = await redisPipeline([
        ["INCR", key],
        ["EXPIRE", key, windowSeconds * 2, "NX"],
      ]);
      return typeof count === "number" ? count <= max : true;
    } catch {
      return true;
    }
  }
  const entry = memory.get(bucket);
  if (!entry || entry.window !== window) {
    if (memory.size >= MEMORY_MAX_ENTRIES) memory.clear();
    memory.set(bucket, { count: 1, window });
    return true;
  }
  entry.count += 1;
  return entry.count <= max;
}

export function resetRateLimits(): void {
  memory.clear();
}
