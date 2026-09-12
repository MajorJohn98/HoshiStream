// Local-first client observability (plan C): every add-on and playback
// request is remembered in a small in-memory ring so the Devices panel can
// show which clients talked to this server recently. Nothing is persisted
// and nothing leaves the Mac.

export type ClientResource =
  "manifest" | "catalog" | "meta" | "stream" | "subtitles" | "playback";

export interface ClientActivity {
  ip: string;
  device: string;
  userAgent: string;
  firstSeen: string;
  lastSeen: string;
  requests: number;
  lastResource: ClientResource;
}

const MAX_CLIENTS = 100;

const clients = new Map<string, ClientActivity>();

// Coarse, dependency-free user-agent labeling; unknown agents stay "Unknown
// device" rather than guessing.
export function deviceLabel(userAgent: string): string {
  const ua = userAgent.toLowerCase();
  if (!ua) return "Unknown device";
  if (ua.includes("nuvio")) return "Nuvio";
  if (ua.includes("stremio")) return "Stremio";
  if (ua.includes("vlc")) return "VLC";
  if (ua.includes("mpv")) return "mpv";
  if (ua.includes("exoplayer")) return "ExoPlayer (Android)";
  if (ua.includes("crkey") || ua.includes("chromecast")) return "Chromecast";
  if (ua.includes("appletv") || ua.includes("tvos")) return "Apple TV";
  if (ua.includes("tizen")) return "Samsung TV";
  if (ua.includes("webos") || ua.includes("web0s")) return "LG TV";
  if (ua.includes("android tv") || ua.includes("androidtv"))
    return "Android TV";
  if (ua.includes("android")) return "Android";
  if (ua.includes("iphone") || ua.includes("ipad")) return "iPhone/iPad";
  if (ua.includes("firefox")) return "Firefox";
  if (ua.includes("edg/")) return "Edge";
  if (ua.includes("chrome")) return "Chrome";
  if (ua.includes("safari")) return "Safari";
  if (ua.includes("node")) return "Node client";
  return "Unknown device";
}

export function recordClient(
  ip: string | undefined,
  userAgent: string | undefined,
  resource: ClientResource,
  now = Date.now(),
): void {
  const address = ip ?? "unknown";
  const agent = userAgent ?? "";
  const key = `${address}\u0000${agent}`;
  const timestamp = new Date(now).toISOString();
  const existing = clients.get(key);
  if (existing) {
    existing.lastSeen = timestamp;
    existing.requests += 1;
    existing.lastResource = resource;
    // Refresh insertion order so eviction drops the least recently seen.
    clients.delete(key);
    clients.set(key, existing);
    return;
  }
  if (clients.size >= MAX_CLIENTS) {
    const oldest = clients.keys().next().value;
    if (oldest !== undefined) clients.delete(oldest);
  }
  clients.set(key, {
    ip: address,
    device: deviceLabel(agent),
    userAgent: agent,
    firstSeen: timestamp,
    lastSeen: timestamp,
    requests: 1,
    lastResource: resource,
  });
}

export function listClients(): ClientActivity[] {
  return [...clients.values()].sort((a, b) =>
    b.lastSeen.localeCompare(a.lastSeen),
  );
}

export function resetClients(): void {
  clients.clear();
}
