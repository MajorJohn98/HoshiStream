// Fetches the pinned ffmpeg (and ffprobe) build for this platform into
// vendor/ffmpeg/<platform-arch>/, checksum-verified like fetch-torrserver.mjs.
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const root = dirname(dirname(fileURLToPath(import.meta.url)));
const lock = JSON.parse(
  await readFile(join(root, "packaging/ffmpeg-lock.json"), "utf8"),
);
// HOSHISTREAM_TARGET (e.g. win32-x64) assembles another platform's vendor
// tree from this machine; defaults to the host platform.
const target =
  process.env.HOSHISTREAM_TARGET ?? `${process.platform}-${process.arch}`;
const targetPlatform = target.split("-")[0];
const pin = lock[target];
if (!pin) throw new Error(`No pinned ffmpeg build for ${target}`);

const outputDir = join(root, "vendor/ffmpeg", target);
await mkdir(outputDir, { recursive: true });

async function download(asset) {
  const response = await fetch(asset.url, { redirect: "follow" });
  if (!response.ok)
    throw new Error(`ffmpeg download failed: ${response.status}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  const digest = createHash("sha256").update(bytes).digest("hex");
  if (digest !== asset.sha256)
    throw new Error(`ffmpeg checksum mismatch for ${asset.name}`);
  return bytes;
}

if (targetPlatform === "darwin") {
  // Riedl builds ship one zip per tool containing a single binary.
  for (const tool of ["ffmpeg", "ffprobe"]) {
    const archive = join(outputDir, `${tool}.zip`);
    await writeFile(archive, await download(pin[tool]));
    await execFileAsync("unzip", ["-o", "-q", archive, "-d", outputDir]);
    await chmod(join(outputDir, tool), 0o755);
    await rm(archive);
  }
} else {
  // BtbN bundles ffmpeg.exe and ffprobe.exe under <name>/bin/ in one zip.
  const archive = join(outputDir, pin.bundle.name);
  await writeFile(archive, await download(pin.bundle));
  // Windows 10+ ships bsdtar, which extracts zip archives.
  await execFileAsync("tar", ["-xf", archive, "-C", outputDir]);
  const extracted = pin.bundle.name.replace(/\.zip$/, "");
  for (const tool of ["ffmpeg.exe", "ffprobe.exe"]) {
    const bytes = await readFile(join(outputDir, extracted, "bin", tool));
    await writeFile(join(outputDir, tool), bytes);
  }
  await rm(join(outputDir, extracted), { recursive: true, force: true });
  await rm(archive);
}

console.log(`Installed ffmpeg ${pin.version} for ${target}`);
