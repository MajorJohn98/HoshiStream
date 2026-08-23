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
import { lanIp } from "./lan-ip.mjs";

const runtimeRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const options = Object.fromEntries(
  process.argv
    .slice(2)
    .filter((value) => value.startsWith("--"))
    .map((value) => {
      const [key, ...rest] = value.slice(2).split("=");
      return [key, rest.join("=") || "true"];
    }),
);
const torrServerPort = Number(options["torrserver-port"] ?? 8090);
const projectRoot = resolve(options["project-root"] ?? runtimeRoot);
const stateRoot = resolve(
  options["state-dir"] ?? join(projectRoot, "native-data"),
);
const projectEnvironment = Object.fromEntries(
  (await readFile(join(projectRoot, ".env"), "utf8"))
    .split(/\r?\n/)
    .filter((line) => line && !line.startsWith("#") && line.includes("="))
    .map((line) => {
      const index = line.indexOf("=");
      return [line.slice(0, index), line.slice(index + 1)];
    }),
);
const addonPort = Number(
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
  "TorrServer",
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
  const entries = JSON.parse(await readFile(sourcePath, "utf8"));
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

async function waitFor(url, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {}
    await new Promise((resolveWait) => setTimeout(resolveWait, 250));
  }
  throw new Error(`Service did not become ready on port ${new URL(url).port}`);
}

await access(binary);
const accessToken = existingToken();
await mkdir(uploadRoot, { recursive: true });
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
  { stdio: ["ignore", "pipe", "pipe"] },
);
for (const output of [torrServer.stdout, torrServer.stderr]) {
  createInterface({ input: output }).on("line", (line) =>
    console.log(redactTorrServerLine(line)),
  );
}

let addon;
let stopping = false;

async function stop(exitCode = 0) {
  if (stopping) return;
  stopping = true;
  if (parentWatchdog) clearInterval(parentWatchdog);
  await addon?.close().catch(() => undefined);
  if (torrServer.exitCode === null) {
    torrServer.kill("SIGTERM");
    await Promise.race([
      new Promise((resolveExit) => torrServer.once("exit", resolveExit)),
      new Promise((resolveWait) => setTimeout(resolveWait, 5_000)),
    ]);
    if (torrServer.exitCode === null) torrServer.kill("SIGKILL");
  }
  await unlink(pidPath).catch(() => undefined);
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
  initialParentPid > 1 && options.detached !== "true"
    ? setInterval(() => {
        if (process.ppid === initialParentPid) return;
        console.error(
          JSON.stringify({
            level: "warn",
            event: "parent_exited",
            initialParentPid,
          }),
        );
        void stop();
      }, 2_000)
    : undefined;
parentWatchdog?.unref();

process.once("SIGINT", () => void stop());
process.once("SIGTERM", () => void stop());
process.once("SIGHUP", () => void stop());
torrServer.once("exit", (code) => {
  if (!stopping) void stop(code || 1);
});

try {
  await waitFor(`http://127.0.0.1:${torrServerPort}/echo`);
  Object.assign(process.env, {
    ADDON_PORT: String(addonPort),
    TORRSERVER_INTERNAL_URL: `http://127.0.0.1:${torrServerPort}`,
    PUBLIC_TORRSERVER_URL: `http://${address}:${torrServerPort}`,
    PUBLIC_ADDON_URL: `http://${address}:${addonPort}`,
    ACCESS_TOKEN: accessToken,
    LIBRARY_PATH: libraryPath,
    MEDIA_ROOT: mediaRoot,
    UPLOAD_ROOT: uploadRoot,
    NATIVE_PICKER_SOCKET: join(stateRoot, "run", "supervisor.sock"),
    HOME_SPEED_MBPS: projectEnvironment.HOME_SPEED_MBPS ?? "10",
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
    FFMPEG_PATH: await ffmpegBinary(),
    FFPROBE_PATH: await ffprobeBinary(),
  });
  const { startHoshiStream } = await import(
    new URL("addon/dist/index.js", `${pathToFileURL(runtimeRoot)}/`)
  );
  addon = await startHoshiStream();
  await waitFor(`http://127.0.0.1:${addonPort}/ready`);
  console.log(
    JSON.stringify({
      level: "info",
      event: "native_ready",
      address,
      addonPort,
      torrServerPort,
      stateRoot,
    }),
  );
} catch (error) {
  console.error(
    JSON.stringify({
      level: "error",
      event: "native_start_failed",
      error: error instanceof Error ? error.message : String(error),
    }),
  );
  await stop(1);
}
