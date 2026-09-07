import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { access, mkdir, rm } from "node:fs/promises";
import { constants } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { PlayerIpc } from "./player-ipc.ts";
import { windowsPowerShellPath } from "./windows-platform.ts";

export class PlayerError extends Error {}

const IS_WINDOWS = process.platform === "win32";
// mpv keeps the swarm's latency hidden behind a large demuxer buffer, which
// matters far more for a torrent stream than for a local file.
const STREAM_ARGS = [
  "--cache=yes",
  "--cache-secs=60",
  "--demuxer-max-bytes=400MiB",
  "--demuxer-readahead-secs=30",
];
const positionEventSchema = z.object({
  name: z.literal("time-pos"),
  data: z.number().nonnegative(),
});

export type PlayerChoice = "auto" | "mpv" | "iina" | "vlc" | "system";

export type PlayerStatus = {
  running: boolean;
  entryId?: string;
  fileId?: number;
  title?: string;
  positionSeconds?: number;
  durationSeconds?: number;
  paused?: boolean;
};

async function executable(path: string): Promise<boolean> {
  return access(path, constants.X_OK).then(
    () => true,
    () => false,
  );
}

// Resolution order: explicit override, then a bundled binary, then PATH.
// Only "auto" and "mpv" drive a player directly; the rest are handoffs.
export async function resolvePlayerBinary(
  override = process.env.PLAYER_PATH,
  choice: PlayerChoice = "auto",
): Promise<string | undefined> {
  if (choice !== "auto" && choice !== "mpv") return undefined;
  if (override) return (await executable(override)) ? override : undefined;
  const bundled = bundledPlayerPath();
  if (await executable(bundled)) return bundled;
  return (await onPath("mpv")) ? "mpv" : undefined;
}

function onPath(binary: string): Promise<boolean> {
  return new Promise((resolveCheck) => {
    const probe = spawn(IS_WINDOWS ? "where" : "which", [binary], {
      stdio: "ignore",
      windowsHide: true,
      timeout: 5_000,
    });
    probe.on("error", () => resolveCheck(false));
    probe.on("close", (code) => resolveCheck(code === 0));
  });
}

// Video players that handle both file paths and stream URLs, tried before the
// generic OS handler. Without this a torrent's http:// URL opens in the default
// browser rather than a player.
const MACOS_PLAYERS = ["IINA", "VLC", "mpv"];
const IINA_CLI = "/Applications/IINA.app/Contents/MacOS/iina-cli";

// Keep user-controlled URLs/paths out of cmd.exe and PowerShell source text.
// ShellExecute delegates a file/HTTP URL to its registered application.
const WINDOWS_OPEN_SCRIPT = `
$ErrorActionPreference = 'Stop'
$info = New-Object System.Diagnostics.ProcessStartInfo
$info.FileName = $env:HOSHISTREAM_PLAYER_TARGET
$info.UseShellExecute = $true
[System.Diagnostics.Process]::Start($info) | Out-Null
`;

export function bundledPlayerPath(
  moduleUrl = import.meta.url,
  platform = process.platform,
  arch = process.arch,
): string {
  const runtimeRoot = resolve(dirname(fileURLToPath(moduleUrl)), "..", "..");
  return join(
    runtimeRoot,
    "vendor",
    "mpv",
    `${platform}-${arch}`,
    platform === "win32" ? "mpv.exe" : "mpv",
  );
}

async function macosPlayerApp(
  choice: PlayerChoice = "auto",
): Promise<string | undefined> {
  const wanted =
    choice === "vlc" ? ["VLC"] : choice === "iina" ? ["IINA"] : MACOS_PLAYERS;
  for (const app of wanted) {
    const bundle = `/Applications/${app}.app`;
    if (
      await access(bundle).then(
        () => true,
        () => false,
      )
    )
      return bundle;
  }
  return undefined;
}

// `open -a IINA a b c` opens one window per file. IINA's own CLI builds a
// single playlist instead, which is what a series needs, and forwards mpv
// options so the streaming buffers still apply. It blocks reading stdin unless
// told not to, and then reports "Cannot open file or stream".
export function systemPlayerCommand(
  target: string,
  queue: string[],
  options: {
    platform?: NodeJS.Platform;
    iinaCli?: boolean;
    playerApp?: string;
    choice?: PlayerChoice;
  } = {},
): [string, string[]] {
  const platform = options.platform ?? process.platform;
  const choice = options.choice ?? "auto";
  if (choice === "system") {
    if (platform === "win32") return windowsOpenCommand();
    return [platform === "darwin" ? "open" : "xdg-open", [target]];
  }
  if (platform === "darwin" && options.iinaCli && choice !== "vlc") {
    const tuning = target.startsWith("http")
      ? STREAM_ARGS.map((option) => `--mpv-${option.slice(2)}`)
      : [];
    return [IINA_CLI, ["--no-stdin", ...tuning, target, ...queue]];
  }
  if (platform === "darwin" && options.playerApp) {
    return ["open", ["-a", options.playerApp, target, ...queue]];
  }
  if (platform === "win32") return windowsOpenCommand();
  if (platform === "darwin") return ["open", [target]];
  return ["xdg-open", [target]];
}

function windowsOpenCommand(): [string, string[]] {
  return [
    windowsPowerShellPath(),
    [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      WINDOWS_OPEN_SCRIPT,
    ],
  ];
}

export async function handOffToSystem(
  target: string,
  queue: string[] = [],
  choice: PlayerChoice = "auto",
): Promise<void> {
  const darwin = process.platform === "darwin";
  const [command, args] = systemPlayerCommand(target, queue, {
    choice,
    iinaCli: darwin && (await executable(IINA_CLI)),
    playerApp: darwin ? await macosPlayerApp(choice) : undefined,
  });
  await new Promise<void>((resolveSpawn, reject) => {
    const child = spawn(command, args, {
      stdio: "ignore",
      detached: true,
      windowsHide: true,
      env:
        process.platform === "win32"
          ? { ...process.env, HOSHISTREAM_PLAYER_TARGET: target }
          : process.env,
    });
    child.on("error", reject);
    child.on("close", (code) =>
      code === 0
        ? resolveSpawn()
        : reject(new PlayerError(`System player exited with code ${code}`)),
    );
    child.unref();
  });
}

export class Player {
  private process?: ChildProcess;
  private ipc?: PlayerIpc;
  private socketPath?: string;
  private current?: { entryId: string; fileId?: number; title?: string };
  private readonly binary: string;
  private readonly launchArgs: string[];
  private readonly onPosition?: (
    entryId: string,
    positionSeconds: number,
    fileId?: number,
  ) => void;

  constructor(
    binary: string,
    onPosition?: (
      entryId: string,
      positionSeconds: number,
      fileId?: number,
    ) => void,
    launchArgs: string[] = [],
  ) {
    this.binary = binary;
    this.onPosition = onPosition;
    this.launchArgs = launchArgs;
  }

  get running(): boolean {
    return Boolean(this.process && this.ipc?.connected);
  }

  async play(
    target: string,
    context: { entryId: string; fileId?: number; title?: string },
    queue: string[] = [],
  ): Promise<void> {
    if (!this.running) await this.start();
    await this.ipc!.command("loadfile", target, "replace");
    this.current = context;
    // Queue the rest of the season so playback advances on its own.
    for (const next of queue)
      await this.ipc!.command("loadfile", next, "append");
  }

  private async start(): Promise<void> {
    const socketPath = await socketFor();
    this.socketPath = socketPath;
    const child = spawn(
      this.binary,
      [
        ...this.launchArgs,
        `--input-ipc-server=${socketPath}`,
        "--idle=yes",
        "--force-window=yes",
        "--keep-open=no",
        ...STREAM_ARGS,
      ],
      // stderr is captured rather than discarded: without it a player that
      // refuses to start fails as an opaque socket timeout.
      { stdio: ["ignore", "ignore", "pipe"] },
    );
    this.process = child;
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => {
      const message = chunk.trim();
      if (message)
        console.error(
          JSON.stringify({ level: "warn", event: "player_stderr", message }),
        );
    });
    child.on("error", (error) => {
      console.error(
        JSON.stringify({
          level: "error",
          event: "player_spawn_failed",
          binary: this.binary,
          error: error.message,
        }),
      );
      if (this.process === child) this.reset();
    });
    child.on("exit", (code, signal) => {
      if (code)
        console.error(
          JSON.stringify({
            level: "warn",
            event: "player_exited",
            code,
            signal,
          }),
        );
      if (this.process === child) this.reset();
    });
    this.ipc = new PlayerIpc(socketPath);
    try {
      await this.ipc.connect();
    } catch (error) {
      this.stop();
      throw error;
    }
    this.ipc.onEvent((event) => {
      if (event === "end-file") this.current = undefined;
    });
    await this.ipc
      .command("observe_property", 1, "time-pos")
      .catch(() => undefined);
    this.ipc.onEvent((event, payload) => {
      if (event !== "property-change") return;
      const position = positionEventSchema.safeParse(payload);
      if (this.current && position.success)
        this.onPosition?.(
          this.current.entryId,
          position.data.data,
          this.current.fileId,
        );
    });
  }

  async command(name: string, ...args: Array<string | number | boolean>) {
    if (!this.running) throw new PlayerError("Player is not running");
    return this.ipc!.command(name, ...args);
  }

  async status(): Promise<PlayerStatus> {
    if (!this.running) return { running: false };
    const [position, duration, paused] = await Promise.all([
      this.ipc!.property("time-pos").catch(() => undefined),
      this.ipc!.property("duration").catch(() => undefined),
      this.ipc!.property("pause").catch(() => undefined),
    ]);
    return {
      running: true,
      entryId: this.current?.entryId,
      fileId: this.current?.fileId,
      title: this.current?.title,
      positionSeconds: typeof position === "number" ? position : undefined,
      durationSeconds: typeof duration === "number" ? duration : undefined,
      paused: typeof paused === "boolean" ? paused : undefined,
    };
  }

  stop(): void {
    this.ipc?.close();
    this.process?.kill();
    if (this.socketPath && !IS_WINDOWS)
      void rm(this.socketPath, { force: true }).catch(() => undefined);
    this.reset();
  }

  private reset(): void {
    this.ipc?.close();
    this.process = undefined;
    this.ipc = undefined;
    this.current = undefined;
  }
}

// The path must be unique per launch: a crashed player leaves its socket file
// behind, and reusing the path would make every later start fail to bind.
async function socketFor(): Promise<string> {
  const unique = `${process.pid}-${randomUUID().slice(0, 8)}`;
  if (IS_WINDOWS) return `\\\\.\\pipe\\hoshistream-mpv-${unique}`;
  const directory = join(tmpdir(), "hoshistream");
  await mkdir(directory, { recursive: true });
  const path = join(directory, `mpv-${unique}.sock`);
  await rm(path, { force: true });
  return path;
}
