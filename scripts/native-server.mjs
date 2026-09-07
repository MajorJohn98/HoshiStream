import { spawn } from "node:child_process";
import {
  access,
  copyFile,
  mkdir,
  readFile,
  rename,
  unlink,
  writeFile,
} from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath, pathToFileURL } from "node:url";
import { defaultMediaDir, ensureFirstRunSetup } from "./bootstrap.mjs";
import { lanIp } from "./lan-ip.mjs";
import {
  claimRuntimeState,
  createRuntimeControl,
  ensurePortsFree,
  loadAddon,
  nativeOptions,
  portNumber,
  waitForService,
} from "./native-runtime.mjs";

const runtimeRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const options = nativeOptions(process.argv.slice(2));
const torrServerPort = portNumber(options["torrserver-port"] ?? 8090);
// --dev runs the add-on straight from addon/src via Node's type stripping,
// skipping the tsc build. Only meaningful from a checkout; packaged bundles
// ship dist/ alone.
const devMode = options.dev === "true";
// Upper bound on shutdown before the process terminates itself.
const SHUTDOWN_TIMEOUT_MS = 10_000;
const projectRoot = resolve(options["project-root"] ?? runtimeRoot);
const stateRoot = resolve(
  options["state-dir"] ?? join(projectRoot, "native-data"),
);
const identity = await claimRuntimeState(stateRoot);
// First run on a new machine has no .env: create the state directory and a
// generated access token rather than failing to start.
const { environment: projectEnvironment, firstRun } = await ensureFirstRunSetup(
  {
    projectRoot,
    pointerStateRoot: stateRoot,
    mediaDir: defaultMediaDir(),
  },
);
if (options["register-browser-bridge"] === "true") {
  try {
    const { registerBrowserBridge } =
      await import("./register-browser-bridge.mjs");
    await registerBrowserBridge({ runtimeRoot, projectRoot, stateRoot });
    console.log(
      JSON.stringify({ level: "info", event: "chrome_bridge_registered" }),
    );
  } catch {
    console.error(
      JSON.stringify({
        level: "warn",
        event: "chrome_bridge_registration_failed",
      }),
    );
  }
}
const addonPort = portNumber(
  options["addon-port"] ?? projectEnvironment.ADDON_PORT ?? 7001,
);
const mediaRoot = resolve(
  options["media-root"] ??
    projectEnvironment.MEDIA_DIR ??
    join(projectRoot, "media"),
);
const uploadRoot = join(projectRoot, "data", "media");
const libraryPath = join(stateRoot, "library.json");
const torrServerRoot = join(stateRoot, "torrserver");
const configRoot = join(torrServerRoot, "config");
const torrentsRoot = join(torrServerRoot, "torrents");
const pidPath = join(stateRoot, "hoshistream.pid");
const binary = join(
  runtimeRoot,
  "vendor/torrserver",
  `${process.platform}-${process.arch}`,
  process.platform === "win32" ? "TorrServer.exe" : "TorrServer",
);

// The vendored, pinned ffmpeg when fetch-ffmpeg.mjs has installed it,
// otherwise "ffmpeg" from PATH so dev setups keep working.
async function ffmpegBinary() {
  return vendoredTool("ffmpeg");
}

async function ffprobeBinary() {
  return vendoredTool("ffprobe");
}

async function vendoredTool(tool) {
  const vendored = join(
    runtimeRoot,
    "vendor/ffmpeg",
    `${process.platform}-${process.arch}`,
    process.platform === "win32" ? `${tool}.exe` : tool,
  );
  try {
    await access(vendored);
    return vendored;
  } catch {
    return tool;
  }
}

function existingToken() {
  const token = projectEnvironment.ACCESS_TOKEN;
  if (!token || token.length < 20)
    throw new Error("A valid ACCESS_TOKEN is required in .env");
  return token;
}

function redactTorrServerLine(line) {
  return line.replace(/magnet:\?\S+/g, "[redacted-magnet]");
}
if (redactTorrServerLine("add magnet:?xt=secret").includes("magnet:?"))
  throw new Error("TorrServer log redaction failed");

async function migrateLibrary() {
  try {
    await access(libraryPath);
    return;
  } catch {}
  const sourcePath = join(projectRoot, "data/library.json");
  // A fresh install has nothing to migrate; start from an empty library.
  const source = await readFile(sourcePath, "utf8").catch(() => "[]");
  const entries = JSON.parse(source);
  const migrated = entries.map((entry) => ({
    ...entry,
    ...(entry.localFilePath && {
      localFilePath: entry.localFilePath.startsWith("/media/")
        ? join(mediaRoot, entry.localFilePath.slice("/media/".length))
        : entry.localFilePath.startsWith("/data/media/")
          ? join(
              projectRoot,
              "data/media",
              entry.localFilePath.slice("/data/media/".length),
            )
          : entry.localFilePath,
    }),
    ...(entry.localFolderPath && {
      localFolderPath: entry.localFolderPath.startsWith("/data/media/")
        ? join(
            projectRoot,
            "data/media",
            entry.localFolderPath.slice("/data/media/".length),
          )
        : entry.localFolderPath,
    }),
    ...(entry.torrentFilePath && {
      torrentFilePath: entry.torrentFilePath.startsWith("/data/")
        ? join(
            projectRoot,
            "data",
            entry.torrentFilePath.slice("/data/".length),
          )
        : entry.torrentFilePath,
    }),
  }));
  const temporary = `${libraryPath}.tmp`;
  await writeFile(temporary, `${JSON.stringify(migrated, null, 2)}\n`, {
    mode: 0o600,
  });
  await rename(temporary, libraryPath);
}

async function seedTorrServerConfig() {
  // Ships with the app rather than living beside a deployment; TorrServer
  // creates config.db itself when it is missing.
  const settingsPath = join(configRoot, "settings.json");
  try {
    await access(settingsPath);
  } catch {
    await copyFile(
      join(runtimeRoot, "packaging/torrserver-settings.json"),
      settingsPath,
    );
  }
  const settings = JSON.parse(await readFile(settingsPath, "utf8"));
  settings.BitTorr.TorrentsSavePath = torrentsRoot;
  await writeFile(settingsPath, `${JSON.stringify(settings, null, 2)}\n`, {
    mode: 0o600,
  });
}

await access(binary);
const accessToken = existingToken();
if (addonPort === torrServerPort)
  throw new Error("The add-on and TorrServer must use different ports");
await ensurePortsFree([addonPort, torrServerPort]);
await mkdir(uploadRoot, { recursive: true });
await mkdir(mediaRoot, { recursive: true });
await mkdir(configRoot, { recursive: true });
await mkdir(torrentsRoot, { recursive: true });
await migrateLibrary();
await seedTorrServerConfig();
await writeFile(pidPath, `${process.pid}\n`, { mode: 0o600 });

const address = lanIp() ?? "127.0.0.1";
const torrServer = spawn(
  binary,
  [
    "--port",
    String(torrServerPort),
    "--ip",
    "0.0.0.0",
    "--path",
    configRoot,
    "--torrentsdir",
    torrentsRoot,
    "--dontkill",
  ],
  { stdio: ["ignore", "pipe", "pipe"], windowsHide: true },
);
for (const output of [torrServer.stdout, torrServer.stderr]) {
  createInterface({ input: output }).on("line", (line) =>
    console.log(redactTorrServerLine(line)),
  );
}

let addon;
let addonStartup;
let control;
let controlStartup;
let parentInput;
let stopping = false;
const startup = new AbortController();

async function stop(exitCode = 0) {
  if (stopping) return;
  stopping = true;
  startup.abort();
  parentInput?.close();
  if (options["parent-control"] === "true") process.stdin.destroy();
  if (parentWatchdog) clearInterval(parentWatchdog);
  // A daemon that fails to exit keeps holding the ports, so the next launch
  // silently serves the old process. Guarantee termination even when a child
  // or a socket refuses to close.
  const forceExit = setTimeout(() => {
    console.error(
      JSON.stringify({ level: "warn", event: "forced_exit", exitCode }),
    );
    if (
      torrServer.pid &&
      torrServer.exitCode === null &&
      torrServer.signalCode === null
    )
      torrServer.kill("SIGKILL");
    process.exit(1);
  }, SHUTDOWN_TIMEOUT_MS);
  forceExit.unref();
  try {
    if (addonStartup) addon = await addonStartup;
    await addon?.close();
  } catch {
    exitCode = 1;
    console.error(
      JSON.stringify({ level: "error", event: "addon_shutdown_failed" }),
    );
  }
  if (
    torrServer.pid &&
    torrServer.exitCode === null &&
    torrServer.signalCode === null
  ) {
    const exited = new Promise((resolveExit) =>
      torrServer.once("exit", resolveExit),
    );
    let childTimeout;
    torrServer.kill("SIGTERM");
    try {
      await Promise.race([
        exited,
        new Promise((resolveWait) => {
          childTimeout = setTimeout(resolveWait, 5_000);
        }),
      ]);
    } finally {
      clearTimeout(childTimeout);
    }
    if (torrServer.exitCode === null && torrServer.signalCode === null) {
      torrServer.kill("SIGKILL");
      await exited;
    }
  }
  await unlink(pidPath).catch(() => undefined);
  try {
    if (controlStartup) control = await controlStartup;
    await control?.close();
  } catch {
    exitCode = 1;
    console.error(
      JSON.stringify({
        level: "error",
        event: "native_control_cleanup_failed",
      }),
    );
  }
  await identity.release();
  clearTimeout(forceExit);
  process.exitCode = exitCode;
}

// The macOS app shuts this down cleanly on Quit, but a crash or a raw signal
// bypasses AppKit's termination path entirely. Without this watchdog the
// supervisor and TorrServer are orphaned, keep holding the ports, and a later
// launch silently serves the old code while the new one fails to bind.
// start-native.sh launches with --detached, where re-parenting to PID 1 is
// expected and the watchdog must stay off.
const initialParentPid = process.ppid;
const parentWatchdog =
  process.platform !== "win32" &&
  initialParentPid > 1 &&
  options.detached !== "true"
    ? setInterval(() => {
        if (process.ppid === initialParentPid) return;
        console.error(
          JSON.stringify({
            level: "warn",
            event: "parent_exited",
            initialParentPid,
          }),
        );
        requestStop();
      }, 2_000)
    : undefined;
parentWatchdog?.unref();

// Watch mode and the terminal can deliver the same signal. Keep handlers
// installed until asynchronous child cleanup has finished.
function requestStop(exitCode = 0) {
  void stop(exitCode).catch(() => {
    console.error(
      JSON.stringify({ level: "error", event: "native_shutdown_failed" }),
    );
    process.exit(1);
  });
}
process.on("SIGINT", () => requestStop());
process.on("SIGTERM", () => requestStop());
process.on("SIGHUP", () => requestStop());
torrServer.once("error", () => {
  console.error(
    JSON.stringify({ level: "error", event: "torrserver_spawn_failed" }),
  );
  requestStop(1);
});
torrServer.once("exit", (code) => {
  if (!stopping) requestStop(code || 1);
});

try {
  controlStartup = createRuntimeControl({
    stateRoot,
    identity,
    addonPort,
    shutdown: () => requestStop(),
  });
  control = await controlStartup;
  if (options["parent-control"] === "true") {
    parentInput = createInterface({ input: process.stdin });
    parentInput.on("line", (line) => {
      if (line.length > 256) return requestStop(1);
      try {
        const command = JSON.parse(line);
        if (command.version !== 1 || command.command !== "shutdown")
          return requestStop(1);
        requestStop();
      } catch {
        requestStop(1);
      }
    });
    parentInput.once("close", () => requestStop());
  }
  await waitForService(`http://127.0.0.1:${torrServerPort}/echo`, {
    signal: startup.signal,
  });
  // This instance belongs to its selected state directory, never an inherited
  // developer shell's pointer endpoint or credentials.
  delete process.env.POINTER_URL;
  delete process.env.POINTER_PUSH_SECRET;
  Object.assign(process.env, {
    ADDON_PORT: String(addonPort),
    TORRSERVER_INTERNAL_URL: `http://127.0.0.1:${torrServerPort}`,
    PUBLIC_TORRSERVER_URL: `http://${address}:${torrServerPort}`,
    PUBLIC_ADDON_URL: `http://${address}:${addonPort}`,
    ACCESS_TOKEN: accessToken,
    LIBRARY_PATH: libraryPath,
    ONBOARDING_PATH: join(stateRoot, "onboarding.json"),
    TAGS_PATH: join(stateRoot, "tags.json"),
    DEVICE_NAMES_PATH: join(stateRoot, "device-names.json"),
    VOLUMES_PATH: join(stateRoot, "volumes.json"),
    DISK_CLEANUP_PATH: join(stateRoot, "disk-cleanup.json"),
    DISK_SCHEDULE_PATH: join(stateRoot, "disk-schedule.json"),
    ONBOARDING_FIRST_RUN: firstRun ? "true" : "false",
    MEDIA_ROOT: mediaRoot,
    UPLOAD_ROOT: uploadRoot,
    NATIVE_PICKER_SOCKET:
      process.env.NATIVE_PICKER_SOCKET ??
      join(stateRoot, "run", "supervisor.sock"),
    HOME_SPEED_MBPS: projectEnvironment.HOME_SPEED_MBPS ?? "10",
    LAN_REDIRECT: projectEnvironment.LAN_REDIRECT ?? "auto",
    MDNS_ENABLED: projectEnvironment.MDNS_ENABLED ?? "true",
    PLAYER: projectEnvironment.PLAYER ?? "auto",
    ...(projectEnvironment.PLAYER_PATH
      ? { PLAYER_PATH: projectEnvironment.PLAYER_PATH }
      : {}),
    LOG_LEVEL: "info",
    // Opt-in stream repair (ADR 0010): forwarded from .env, defaulting to
    // off. The vendored ffmpeg wins over PATH when it has been fetched.
    TRANSCODE_ENABLED: projectEnvironment.TRANSCODE_ENABLED ?? "false",
    ...(projectEnvironment.TRANSCODE_MAX_SESSIONS
      ? { TRANSCODE_MAX_SESSIONS: projectEnvironment.TRANSCODE_MAX_SESSIONS }
      : {}),
    TRANSCODE_DIR: join(stateRoot, "transcode"),
    TORRSERVER_CACHE_DIR: torrentsRoot,
    // Remote pointer (ADR 0012): forwarded only when configured in .env;
    // pushes remain manual either way.
    ...(projectEnvironment.POINTER_URL
      ? { POINTER_URL: projectEnvironment.POINTER_URL }
      : {}),
    ...(projectEnvironment.POINTER_PUSH_SECRET
      ? { POINTER_PUSH_SECRET: projectEnvironment.POINTER_PUSH_SECRET }
      : {}),
    POINTER_STATE_PATH: join(stateRoot, "pointer-state.json"),
    POINTER_SETTINGS_PATH: join(stateRoot, "pointer-settings.json"),
    FFMPEG_PATH: await ffmpegBinary(),
    FFPROBE_PATH: await ffprobeBinary(),
  });
  startup.signal.throwIfAborted();
  const addonEntry = devMode ? "addon/src/index.ts" : "addon/dist/index.js";
  const { startHoshiStream } = await loadAddon(
    new URL(addonEntry, `${pathToFileURL(runtimeRoot)}/`),
    startup.signal,
  );
  addonStartup = startHoshiStream();
  addon = await addonStartup;
  if (!stopping) {
    await waitForService(`http://127.0.0.1:${addonPort}/ready`, {
      signal: startup.signal,
    });
    control.markReady();
    console.log(
      JSON.stringify({
        level: "info",
        event: "native_ready",
        address,
        addonPort,
        torrServerPort,
        stateRoot,
        ...(devMode ? { devMode, addonEntry } : {}),
      }),
    );
  }
} catch (error) {
  if (!stopping) {
    console.error(
      JSON.stringify({
        level: "error",
        event: "native_start_failed",
        error: error instanceof Error ? error.message : String(error),
      }),
    );
    requestStop(1);
  }
}
