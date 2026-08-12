import { isIP } from "node:net";

const TRACE_URL = "https://www.cloudflare.com/cdn-cgi/trace";
const SUCCESS_TTL_MS = 5 * 60 * 1000;
const FAILURE_TTL_MS = 30 * 1000;
const TIMEOUT_MS = 2_000;

interface CachedLookup {
  ip: string | null;
  expiresAt: number;
}

let cache: CachedLookup | undefined;

export function parseTraceIp(traceBody: string): string | null {
  for (const line of traceBody.split("\n")) {
    if (!line.startsWith("ip=")) continue;
    const ip = line.slice(3).trim();
    return isIP(ip) ? ip : null;
  }
  return null;
}

export function resetPublicIpCache(): void {
  cache = undefined;
}

export async function ownPublicIp(
  fetchImpl: typeof fetch = fetch,
  now: () => number = Date.now,
): Promise<string | null> {
  if (cache && cache.expiresAt > now()) return cache.ip;
  let ip: string | null = null;
  try {
    const response = await fetchImpl(TRACE_URL, {
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (response.ok) ip = parseTraceIp(await response.text());
  } catch {
    ip = null;
  }
  cache = {
    ip,
    expiresAt: now() + (ip ? SUCCESS_TTL_MS : FAILURE_TTL_MS),
  };
  console.log(
    JSON.stringify({
      level: ip ? "info" : "warn",
      event: "public_ip_lookup",
      resolved: ip !== null,
    }),
  );
  return ip;
}
