// Installer hooks use bundled Node rather than a shell or execution-policy change.
import { execFile } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { defaultStateRoot } from "../scripts/bootstrap.mjs";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const exec = promisify(execFile);

export function browserRegistrationArguments(
  runtimeRoot,
  stateRoot,
  unregister = false,
) {
  return [
    join(runtimeRoot, "scripts/register-browser-bridge.mjs"),
    `--runtime-root=${runtimeRoot}`,
    `--project-root=${stateRoot}`,
    `--state-dir=${stateRoot}`,
    ...(unregister ? ["--unregister"] : []),
  ];
}

async function main() {
  if (process.platform !== "win32") throw new Error("Windows is required");
  const command = process.argv[2];
  if (command === "shutdown") {
    await exec(join(root, "HoshiStream.exe"), [`--${command}`], {
      cwd: root,
      windowsHide: true,
      timeout: 35_000,
      maxBuffer: 64 * 1024,
    });
    await exec(
      process.execPath,
      [
        join(root, "scripts/native-control.mjs"),
        "stop",
        `--state-dir=${resolve(process.env.HOSHISTREAM_STATE_DIR ?? defaultStateRoot())}`,
      ],
      { cwd: root, windowsHide: true, timeout: 25_000, maxBuffer: 64 * 1024 },
    );
  } else if (
    command === "register-magnet" ||
    command === "unregister-integrations"
  ) {
    await exec(
      join(root, "HoshiStream.exe"),
      [
        `--${command}`,
        `--state-dir=${resolve(process.env.HOSHISTREAM_STATE_DIR ?? defaultStateRoot())}`,
      ],
      {
        cwd: root,
        windowsHide: true,
        timeout: 20_000,
        maxBuffer: 64 * 1024,
      },
    );
  } else if (
    command === "register-browser" ||
    command === "unregister-browser"
  ) {
    await exec(
      process.execPath,
      browserRegistrationArguments(
        root,
        resolve(process.env.HOSHISTREAM_STATE_DIR ?? defaultStateRoot()),
        command === "unregister-browser",
      ),
      { cwd: root, windowsHide: true, timeout: 30_000, maxBuffer: 64 * 1024 },
    );
  } else throw new Error("Unknown installer operation");
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
)
  await main().catch(() => {
    // Subprocess diagnostics may contain private paths; installation needs only failure.
    console.error(
      "HoshiStream installer operation failed or timed out. Close HoshiStream and try again.",
    );
    process.exitCode = 1;
  });
