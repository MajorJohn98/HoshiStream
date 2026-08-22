// Real-time stream repair (ADR 0010, tiers R and A): ffmpeg remuxes or fixes
// the audio of an entry into an HLS session directory that routes.ts serves.
// Video bytes are never re-encoded here; tier V is a later phase.
import { spawn as nodeSpawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdir, readFile, rm, stat } from "node:fs/promises";
import { join } from "node:path";

export type RepairTier = "remux" | "audio";

// Audio codecs that commonly play silent or force software decoding on TVs;
// mirrors RISKY_AUDIO in direct-play.ts.
const AUDIO_FIX = new Set(["dts", "dtshd", "truehd", "mlp", "pcm_bluray"]);
// Containers TVs commonly reject even when the codecs inside are fine.
const REMUX_CONTAINERS = new Set(["matroska", "avi"]);

export function repairTier(directPlay?: {
  container?: string;
  audioCodec?: string;
}): RepairTier | undefined {
  if (!directPlay) return undefined;
  const audio = directPlay.audioCodec?.toLowerCase();
  if (audio && AUDIO_FIX.has(audio)) return "audio";
  const container = directPlay.container?.toLowerCase();
  if (container && REMUX_CONTAINERS.has(container)) return "remux";
  return undefined;
}

export function repairDescription(tier: RepairTier): string {
  return tier === "audio"
    ? "Compatible • AC3 audio for TV playback"
    : "Compatible • TV-friendly container";
}

// Arguments are relative to the session directory, which is ffmpeg's cwd, so
// no output paths need quoting or containment checks.
export function ffmpegArgs(tier: RepairTier, input: string): string[] {
  return [
    "-hide_banner",
    "-loglevel",
    "error",
    "-nostdin",
    "-i",
    input,
    "-map",
    "0:v:0",
    "-map",
    "0:a:0?",
    ...(tier === "audio"
      ? ["-c:v", "copy", "-c:a", "ac3", "-b:a", "640k"]
      : ["-c", "copy"]),
    "-f",
    "hls",
    "-hls_time",
    "6",
    "-hls_playlist_type",
    "event",
    "-hls_segment_type",
    "fmp4",
    "-hls_fmp4_init_filename",
    "init.mp4",
    "-hls_segment_filename",
    "seg-%d.m4s",
    "index.m3u8",
  ];
}

export interface TranscodeSession {
  id: string;
  key: string;
  entryId: string;
  fileId: number;
  tier: RepairTier;
  dir: string;
  startedAt: number;
  lastAccess: number;
  exited: boolean;
  failed: boolean;
}

type SpawnFn = (
  command: string,
  args: string[],
  options: { cwd: string },
) => ChildProcess;

export class TranscodeBusyError extends Error {
  constructor(max: number) {
    super(`Transcode session limit of ${max} reached`);
  }
}

interface ManagerOptions {
  dir: string;
  ffmpegPath: string;
  maxSessions: number;
  idleTimeoutMs?: number;
  reaperIntervalMs?: number;
  spawnFn?: SpawnFn;
}

function log(event: string, session: TranscodeSession, extra = {}) {
  console.log(
    JSON.stringify({
      level: "info",
      event,
      entryId: session.entryId,
      fileId: session.fileId,
      tier: session.tier,
      ...extra,
    }),
  );
}

export class TranscodeManager {
  readonly #sessions = new Map<string, TranscodeSession>();
  readonly #processes = new Map<string, ChildProcess>();
  readonly #options: Required<ManagerOptions>;
  #reaper: NodeJS.Timeout | undefined;

  constructor(options: ManagerOptions) {
    this.#options = {
      idleTimeoutMs: 60_000,
      reaperIntervalMs: 15_000,
      spawnFn: (command, args, spawnOptions) =>
        nodeSpawn(command, args, { ...spawnOptions, stdio: "ignore" }),
      ...options,
    };
  }

  // Deletes leftovers from a previous run and starts the idle reaper.
  async start(): Promise<void> {
    await rm(this.#options.dir, { recursive: true, force: true });
    await mkdir(this.#options.dir, { recursive: true });
    this.#reaper = setInterval(() => {
      void this.reap();
    }, this.#options.reaperIntervalMs);
    this.#reaper.unref();
  }

  get(entryId: string, fileId: number): TranscodeSession | undefined {
    return this.#sessions.get(`${entryId}:${fileId}`);
  }

  list(): TranscodeSession[] {
    return [...this.#sessions.values()];
  }

  touch(session: TranscodeSession): void {
    session.lastAccess = Date.now();
  }

  async ensure(request: {
    entryId: string;
    fileId: number;
    tier: RepairTier;
    input: string;
  }): Promise<TranscodeSession> {
    const key = `${request.entryId}:${request.fileId}`;
    const existing = this.#sessions.get(key);
    if (existing && !existing.failed) return existing;
    if (existing) await this.remove(existing);
    if (this.#sessions.size >= this.#options.maxSessions)
      throw new TranscodeBusyError(this.#options.maxSessions);

    const id = randomBytes(16).toString("hex");
    const dir = join(this.#options.dir, id);
    await mkdir(dir, { recursive: true });
    const session: TranscodeSession = {
      id,
      key,
      entryId: request.entryId,
      fileId: request.fileId,
      tier: request.tier,
      dir,
      startedAt: Date.now(),
      lastAccess: Date.now(),
      exited: false,
      failed: false,
    };
    const child = this.#options.spawnFn(
      this.#options.ffmpegPath,
      ffmpegArgs(request.tier, request.input),
      { cwd: dir },
    );
    this.#sessions.set(key, session);
    this.#processes.set(key, child);
    log("transcode_started", session);
    child.on("error", (error: Error) => {
      session.exited = true;
      session.failed = true;
      this.#processes.delete(key);
      log("transcode_spawn_failed", session, { error: error.message });
    });
    child.on("exit", (code) => {
      session.exited = true;
      // A non-zero exit before any output means the repair failed; a clean
      // exit means the whole file has been written and serving can continue.
      if (code !== 0) session.failed = true;
      this.#processes.delete(key);
      log("transcode_exited", session, { code });
    });
    return session;
  }

  // Resolves when the playlist and init segment exist, or throws when ffmpeg
  // failed or the deadline passes.
  async waitForPlaylist(session: TranscodeSession, timeoutMs = 15_000) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      if (session.failed) throw new Error("Stream repair failed to start");
      try {
        const [playlist] = await Promise.all([
          stat(join(session.dir, "index.m3u8")),
          stat(join(session.dir, "init.mp4")),
        ]);
        if (playlist.size > 0) return;
      } catch {
        // not written yet
      }
      if (Date.now() > deadline)
        throw new Error("Stream repair did not start in time");
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }

  async readAsset(
    session: TranscodeSession,
    asset: string,
  ): Promise<Buffer | undefined> {
    // Assets are matched against a strict allowlist by the route, so this is
    // a second line of defense only.
    if (!/^(index\.m3u8|init\.mp4|seg-\d+\.m4s)$/.test(asset)) return undefined;
    try {
      return await readFile(join(session.dir, asset));
    } catch {
      return undefined;
    }
  }

  async reap(now = Date.now()): Promise<void> {
    for (const session of this.#sessions.values()) {
      const idle = now - session.lastAccess;
      if (idle > this.#options.idleTimeoutMs) {
        log("transcode_reaped", session, { idleMs: idle });
        await this.remove(session);
      }
    }
  }

  async remove(session: TranscodeSession): Promise<void> {
    const child = this.#processes.get(session.key);
    if (child) child.kill("SIGTERM");
    this.#processes.delete(session.key);
    this.#sessions.delete(session.key);
    await rm(session.dir, { recursive: true, force: true }).catch(
      () => undefined,
    );
  }

  async close(): Promise<void> {
    if (this.#reaper) clearInterval(this.#reaper);
    for (const session of this.#sessions.values()) await this.remove(session);
  }
}
