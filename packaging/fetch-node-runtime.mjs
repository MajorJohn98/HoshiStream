import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmod,
  mkdir,
  readFile,
  rename,
  rm,
  unlink,
  writeFile,
} from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const lock = JSON.parse(
  await readFile(join(root, "packaging/node-lock.json"), "utf8"),
);
// HOSHISTREAM_TARGET (e.g. win32-x64) assembles another platform's vendor
// tree from this machine; defaults to the host platform.
const target =
  process.env.HOSHISTREAM_TARGET ?? `${process.platform}-${process.arch}`;
const targetPlatform = target.split("-")[0];
const asset = lock[target];
if (!asset) throw new Error(`No pinned Node.js runtime for ${target}`);

// Windows ships a .zip with node.exe at the root of the extracted folder;
// every other platform ships a .tar.gz with the binary under bin/.
const isZip = asset.name.endsWith(".zip");
const binaryName = targetPlatform === "win32" ? "node.exe" : "node";
const output = join(root, "vendor/node", target, binaryName);
const archive = `${output}${isZip ? ".zip" : ".tar.gz"}`;
const unpacked = asset.name.replace(/\.(zip|tar\.gz)$/, "");
const extracted = isZip
  ? join(dirname(output), unpacked, binaryName)
  : join(dirname(output), unpacked, "bin", binaryName);
await mkdir(dirname(output), { recursive: true });

const response = await fetch(asset.url, { redirect: "follow" });
if (!response.ok) throw new Error(`Node.js download failed: ${response.status}`);
const bytes = Buffer.from(await response.arrayBuffer());
const digest = createHash("sha256").update(bytes).digest("hex");
if (digest !== asset.sha256)
  throw new Error(`Node.js checksum mismatch for ${asset.name}`);

try {
  await writeFile(archive, bytes, { mode: 0o600 });
  const [command, args] = isZip
    ? ["tar", ["-xf", archive, "-C", dirname(output)]]
    : ["tar", ["-xzf", archive, "-C", dirname(output)]];
  await new Promise((resolveExtract, rejectExtract) => {
    const child = spawn(command, args);
    child.once("error", rejectExtract);
    child.once("exit", (code) =>
      code === 0
        ? resolveExtract()
        : rejectExtract(new Error(`${command} exited with status ${code}`)),
    );
  });
  await rename(extracted, output);
  await chmod(output, 0o755);
} finally {
  await unlink(archive).catch(() => undefined);
  // The archive unpacks a full distribution; only the binary is kept.
  await rm(join(dirname(output), unpacked), {
    recursive: true,
    force: true,
  }).catch(() => undefined);
}

console.log(`Installed Node.js ${lock.version} for ${target}`);
