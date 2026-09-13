import { arch, homedir, platform, release as osRelease } from "node:os";
import type { Archiver } from "./archiver.ts";
import type { ArchiveSchedule } from "./archive-schedule.ts";
import type { Library } from "./library.ts";
import type { PlaybackTelemetry } from "./playback-telemetry.ts";
import type { PointerClient } from "./pointer.ts";
import { releaseInfo } from "./release.ts";
import { currentSpeed, homeSpeedMbps, recentSpeeds } from "./speedtest.ts";
import type { TorrServerClient } from "./torrserver-client.ts";
import type { VolumeRegistry } from "./volumes.ts";

export const LOG_RING_SIZE = 300;
const TORRSERVER_TIMEOUT_MS = 5_000;
const REDACTED = "[redacted]";

/** Last N console lines, kept in memory so a bundle needs no file access. */
export class LogRing {
  readonly #lines: string[] = [];
  readonly #size: number;

  constructor(size = LOG_RING_SIZE) {
    this.#size = size;
  }

  push(line: string): void {
    this.#lines.push(line);
    if (this.#lines.length > this.#size) this.#lines.shift();
  }

  lines(): readonly string[] {
    return this.#lines;
  }
}

function formatArgs(args: unknown[]): string {
  return args
    .map((value) => {
      if (typeof value === "string") return value;
      if (value instanceof Error) return value.stack ?? value.message;
      try {
        return JSON.stringify(value);
      } catch {
        return String(value);
      }
    })
    .join(" ");
}

/**
 * Mirror console output into the ring. The add-on already logs structured
 * JSON through console.*, so this captures every server event without a
 * second logger. Returns a function that restores the original methods.
 */
export function installConsoleTap(ring: LogRing): () => void {
  const methods = ["log", "info", "warn", "error"] as const;
  const originals = Object.fromEntries(
    methods.map((name) => [name, console[name]]),
  ) as Record<(typeof methods)[number], (...args: unknown[]) => void>;
  for (const name of methods) {
    console[name] = (...args: unknown[]) => {
      ring.push(`${new Date().toISOString()} ${formatArgs(args)}`);
      originals[name].apply(console, args);
    };
  }
  return () => {
    for (const name of methods) console[name] = originals[name];
  };
}

export interface RedactionSecrets {
  accessToken?: string;
  pushSecret?: string;
  homeDir?: string;
}

/** Redact one string: known secrets, auth headers, magnet URIs, home paths. */
export function redactText(text: string, secrets: RedactionSecrets): string {
  let out = text;
  for (const secret of [secrets.accessToken, secrets.pushSecret]) {
    if (secret && secret.length >= 8) out = out.replaceAll(secret, REDACTED);
  }
  out = out
    // Authorization headers and their values, in JSON, YAML-ish or raw form.
    .replace(
      /(authorization["']?\s*[:=]\s*["']?)(?:bearer\s+)?[^"'\s,}]+/gi,
      `$1${REDACTED}`,
    )
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/g, `Bearer ${REDACTED}`)
    // Complete magnet URIs are never logged (the hash alone is fine).
    .replace(/magnet:\?[^\s"'<>\\]*/gi, `magnet:${REDACTED}`)
    // Tokens and secrets passed as query values or env-style assignments.
    .replace(
      /([?&](?:token|secret|key|apikey|api_key)=)[^&\s"'<>]+/gi,
      `$1${REDACTED}`,
    )
    .replace(
      /\b((?:ACCESS_TOKEN|POINTER_PUSH_SECRET)\s*[=:]\s*["']?)[^\s"']+/g,
      `$1${REDACTED}`,
    );
  const home = secrets.homeDir ?? homedir();
  if (home && home !== "/") {
    out = out.replaceAll(home, "~");
    // JSON-escaped Windows paths keep doubled backslashes.
    const escaped = JSON.stringify(home).slice(1, -1);
    if (escaped !== home) out = out.replaceAll(escaped, "~");
  }
  return out;
}

/** Walk a JSON-compatible value and redact every string, keys included. */
export function redactDiagnostics<T>(value: T, secrets: RedactionSecrets): T {
  const walk = (node: unknown): unknown => {
    if (typeof node === "string") return redactText(node, secrets);
    if (Array.isArray(node)) return node.map(walk);
    if (node && typeof node === "object") {
      const out: Record<string, unknown> = {};
      for (const [key, child] of Object.entries(node))
        out[redactText(key, secrets)] = walk(child);
      return out;
    }
    return node;
  };
  return walk(JSON.parse(JSON.stringify(value))) as T;
}

export interface DiagnosticsContext {
  library: Library;
  torrServer: TorrServerClient;
  telemetry?: PlaybackTelemetry;
  pointer?: PointerClient;
  volumes?: VolumeRegistry;
  archiver?: Archiver;
  archiveSchedule?: ArchiveSchedule;
  logs?: LogRing;
  secrets: RedactionSecrets;
}

async function attempt<T>(
  work: () => Promise<T>,
): Promise<T | { error: string }> {
  try {
    return await work();
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * Assemble the support bundle. Everything is redacted on the way out, so the
 * result is safe to paste into an issue: no tokens, secrets, auth headers,
 * magnet URIs or home-directory paths. Library contents are counted only.
 */
export async function buildDiagnostics(context: DiagnosticsContext) {
  const { torrServer, library } = context;
  const signal = AbortSignal.timeout(TORRSERVER_TIMEOUT_MS);
  const [entries, torrServerStatus, settings, pointer, volumes, jobs, window] =
    await Promise.all([
      library.list(),
      attempt(() =>
        torrServer.health().then((version) => ({ online: true, version })),
      ),
      attempt(() => torrServer.settings(signal)),
      context.pointer
        ? attempt(() => context.pointer!.status())
        : Promise.resolve(undefined),
      context.volumes
        ? attempt(() => context.volumes!.statusAll())
        : Promise.resolve(undefined),
      context.archiver
        ? attempt(() => context.archiver!.jobs())
        : Promise.resolve(undefined),
      context.archiveSchedule
        ? attempt(() => context.archiveSchedule!.window())
        : Promise.resolve(undefined),
    ]);
  const count = (predicate: (entry: (typeof entries)[number]) => boolean) =>
    entries.filter(predicate).length;
  const bundle = {
    generatedAt: new Date().toISOString(),
    app: {
      release: releaseInfo,
      node: process.version,
      platform: platform(),
      arch: arch(),
      osRelease: osRelease(),
      uptimeSeconds: Math.floor(process.uptime()),
    },
    torrServer: {
      ...("error" in torrServerStatus
        ? { online: false, error: torrServerStatus.error }
        : torrServerStatus),
      settings,
    },
    speed: {
      homeSpeedMbps: homeSpeedMbps(),
      current: currentSpeed(),
      recent: recentSpeeds(),
    },
    telemetry: context.telemetry?.report() ?? [],
    pointer,
    disk: { volumes, jobs, schedule: window ?? null },
    library: {
      entries: entries.length,
      movies: count((entry) => entry.type === "movie"),
      series: count((entry) => entry.type === "series"),
      localMedia: count((entry) =>
        Boolean(entry.localFilePath || entry.localFolderPath),
      ),
      multiSource: count((entry) => Boolean(entry.extraSources?.length)),
      diskCopies: count((entry) => entry.diskCopy?.desired === "keep"),
      diskPolicies: count((entry) => Boolean(entry.diskCopy?.policy)),
      withWatchState: count((entry) => Boolean(entry.watchStates?.length)),
    },
    logs: context.logs?.lines() ?? [],
  };
  return redactDiagnostics(bundle, context.secrets);
}

export type DiagnosticsBundle = Awaited<ReturnType<typeof buildDiagnostics>>;
