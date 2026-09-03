import { homedir } from "node:os";
import { join, posix, win32 } from "node:path";
import { z } from "zod";

// Where HoshiStream keeps its own state when nothing is configured. The native
// supervisor passes explicit paths; these defaults matter for a bare `npm start`
// and for documenting what the app actually uses.
export function stateRoot(
  platform: NodeJS.Platform = process.platform,
  environment: NodeJS.ProcessEnv = process.env,
): string {
  // Use the target platform's path flavour rather than the host's, so the
  // result is correct even when computed for a platform we are not running on.
  if (platform === "win32") {
    return win32.join(
      environment.LOCALAPPDATA ?? win32.join(homedir(), "AppData", "Local"),
      "HoshiStream",
    );
  }
  if (platform === "darwin") {
    return posix.join(
      homedir(),
      "Library",
      "Application Support",
      "HoshiStream",
    );
  }
  return posix.join(
    environment.XDG_DATA_HOME ?? posix.join(homedir(), ".local", "share"),
    "hoshistream",
  );
}

const root = stateRoot();

const httpUrl = z
  .string()
  .url()
  .refine((value) => ["http:", "https:"].includes(new URL(value).protocol), {
    message: "URL must use HTTP or HTTPS",
  });

export const configSchema = z.object({
  ADDON_PORT: z.coerce.number().int().min(1).max(65535).default(7000),
  TORRSERVER_INTERNAL_URL: httpUrl,
  PUBLIC_TORRSERVER_URL: httpUrl,
  PUBLIC_ADDON_URL: httpUrl,
  ACCESS_TOKEN: z.string().min(20),
  LIBRARY_PATH: z.string().min(1).default(join(root, "library.json")),
  MEDIA_ROOT: z.string().min(1).default(join(homedir(), "Movies")),
  UPLOAD_ROOT: z.string().min(1).default(join(root, "media")),
  NATIVE_PICKER_SOCKET: z
    .string()
    .min(1)
    .default(join(root, "run", "supervisor.sock")),
  // Which player handles "Play on this Mac". "auto" drives mpv when it can be
  // found (full control), otherwise hands off to an installed player.
  PLAYER: z.enum(["auto", "mpv", "iina", "vlc", "system"]).default("auto"),
  HOME_SPEED_MBPS: z.coerce.number().positive().default(10),
  LAN_REDIRECT: z.enum(["auto", "off"]).default("auto"),
  LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),
  // Opt-in stream repair (ADR 0010). Off by default: direct play is always
  // preferred and the repair pipeline only runs when explicitly enabled.
  TRANSCODE_ENABLED: z
    .string()
    .default("false")
    .transform((value) => value === "true" || value === "1"),
  TRANSCODE_MAX_SESSIONS: z.coerce.number().int().min(1).max(8).default(2),
  TRANSCODE_VIDEO_BITRATE_MBPS: z.coerce.number().min(1).max(40).default(8),
  TRANSCODE_DIR: z.string().min(1).default(join(root, "transcode")),
  FFMPEG_PATH: z.string().min(1).default("ffmpeg"),
  // Where TorrServer keeps its disk cache; reported on the status page.
  TORRSERVER_CACHE_DIR: z
    .string()
    .min(1)
    .default(join(root, "torrserver", "torrents")),
  // LAN discovery (ADR 0011): advertise _hoshistream._tcp so setup helpers
  // can find the box. LAN-multicast only; never carries the token.
  MDNS_ENABLED: z
    .string()
    .default("true")
    .transform((value) => value === "true" || value === "1"),
  // Stable manifest URL via a self-controlled Vercel pointer server
  // (ADR 0012). Both must be set to enable the manual "Update Remote
  // Pointer" push; nothing is sent automatically.
  POINTER_URL: httpUrl.optional(),
  POINTER_PUSH_SECRET: z.string().min(20).optional(),
  POINTER_STATE_PATH: z
    .string()
    .min(1)
    .default(join(root, "pointer-state.json")),
  // User-assigned device names shown in the Devices panel, keyed by IP.
  DEVICE_NAMES_PATH: z.string().min(1).default(join(root, "device-names.json")),
  // Registered storage volumes for the disk library (external drives are
  // identified by an on-disk marker, not by mount path).
  VOLUMES_PATH: z.string().min(1).default(join(root, "volumes.json")),
  // Deferred disk-copy deletions, applied when the target drive reconnects.
  DISK_CLEANUP_PATH: z.string().min(1).default(join(root, "disk-cleanup.json")),
});

// Compose used to resolve `torrserver` and `addon` as container hostnames. They
// cannot resolve now, and the failure would otherwise surface only as a
// confusing connection error at the first stream request.
const CONTAINER_HOSTNAMES = ["addon", "torrserver"];

export function containerHostnameWarning(
  url: string,
  variable: string,
): string | undefined {
  let hostname: string;
  try {
    hostname = new URL(url).hostname;
  } catch {
    return undefined;
  }
  return CONTAINER_HOSTNAMES.includes(hostname)
    ? `${variable} points at "${hostname}", a Docker Compose hostname. HoshiStream no longer runs in containers — use 127.0.0.1 or the machine's LAN IP.`
    : undefined;
}

export function parseConfig(environment: NodeJS.ProcessEnv) {
  const config = configSchema.parse(environment);
  for (const variable of [
    "TORRSERVER_INTERNAL_URL",
    "PUBLIC_TORRSERVER_URL",
    "PUBLIC_ADDON_URL",
  ] as const) {
    const warning = containerHostnameWarning(config[variable], variable);
    if (warning)
      console.error(
        JSON.stringify({
          level: "warn",
          event: "stale_container_hostname",
          message: warning,
        }),
      );
  }
  return config;
}
