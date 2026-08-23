// Builds the portable Windows zip — the counterpart of build-macos-app.sh.
// Runs on macOS or Windows; the win32-x64 runtimes must be fetched first:
//   HOSHISTREAM_TARGET=win32-x64 node packaging/fetch-node-runtime.mjs
//   HOSHISTREAM_TARGET=win32-x64 node packaging/fetch-torrserver.mjs
//   HOSHISTREAM_TARGET=win32-x64 node packaging/fetch-ffmpeg.mjs   (optional)
import { spawn } from "node:child_process";
import { access, cp, mkdir, readFile, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const stage = join(root, "build/windows-stage");
const bundle = join(stage, "HoshiStream");

function run(command, args, cwd = root) {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(command, args, { cwd, stdio: "inherit" });
    child.once("error", rejectRun);
    child.once("exit", (code) =>
      code === 0
        ? resolveRun()
        : rejectRun(new Error(`${command} exited with status ${code}`)),
    );
  });
}

const nodeBinary = join(root, "vendor/node/win32-x64/node.exe");
const torrServerBinary = join(root, "vendor/torrserver/win32-x64/TorrServer.exe");
for (const [binary, fetcher] of [
  [nodeBinary, "fetch-node-runtime.mjs"],
  [torrServerBinary, "fetch-torrserver.mjs"],
]) {
  await access(binary).catch(() => {
    throw new Error(
      `Missing ${binary} — run: HOSHISTREAM_TARGET=win32-x64 node packaging/${fetcher}`,
    );
  });
}

await run("npm", ["run", "build"], join(root, "addon"));
await rm(stage, { recursive: true, force: true });
await mkdir(join(bundle, "bin"), { recursive: true });
await mkdir(join(bundle, "scripts"), { recursive: true });
await mkdir(join(bundle, "packaging"), { recursive: true });
await mkdir(join(bundle, "addon"), { recursive: true });
await mkdir(join(bundle, "vendor/torrserver/win32-x64"), { recursive: true });
await mkdir(join(bundle, "vendor/ffmpeg/win32-x64"), { recursive: true });

await cp(nodeBinary, join(bundle, "bin/node.exe"));
for (const script of [
  "native-server.mjs",
  "bootstrap.mjs",
  "lan-ip.mjs",
  "start-native.ps1",
  "stop-native.ps1",
  "install-login-task.ps1",
  "uninstall-login-task.ps1",
]) {
  await cp(join(root, "scripts", script), join(bundle, "scripts", script));
}
await cp(
  join(root, "packaging/torrserver-settings.json"),
  join(bundle, "packaging/torrserver-settings.json"),
);
await cp(join(root, "addon/dist"), join(bundle, "addon/dist"), {
  recursive: true,
});
await cp(join(root, "addon/assets"), join(bundle, "addon/assets"), {
  recursive: true,
});
await cp(torrServerBinary, join(bundle, "vendor/torrserver/win32-x64/TorrServer.exe"));

// Vendored ffmpeg/ffprobe for stream repair (ADR 0010); optional so the zip
// still builds before fetch-ffmpeg.mjs has run — repair then uses PATH.
for (const tool of ["ffmpeg.exe", "ffprobe.exe"]) {
  const source = join(root, "vendor/ffmpeg/win32-x64", tool);
  await cp(source, join(bundle, "vendor/ffmpeg/win32-x64", tool)).catch(
    () => undefined,
  );
}

// Production-only dependencies, staged from the lockfile exactly as the macOS
// build does — the checkout's node_modules carries devDependencies nothing
// needs at runtime.
const depsStage = join(root, "build/deps-stage");
await mkdir(depsStage, { recursive: true });
await cp(join(root, "addon/package.json"), join(depsStage, "package.json"));
await cp(
  join(root, "addon/package-lock.json"),
  join(depsStage, "package-lock.json"),
);
await run(
  "npm",
  ["ci", "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund"],
  depsStage,
);
await cp(join(depsStage, "node_modules"), join(bundle, "addon/node_modules"), {
  recursive: true,
});

await cp(join(root, "packaging/windows-readme.txt"), join(bundle, "README.txt"));

const { version } = JSON.parse(
  await readFile(join(root, "addon/package.json"), "utf8"),
);
const output = join(root, "build", `HoshiStream-${version}-win-x64.zip`);
await rm(output, { force: true });
// bsdtar writes zip archives and ships with both macOS and Windows 10+.
await run("tar", ["-C", stage, "-a", "-cf", output, "HoshiStream"]);
console.log(output);
