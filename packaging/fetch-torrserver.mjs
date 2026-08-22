import { createHash } from "node:crypto";
import { chmod, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const lock = JSON.parse(
  await readFile(join(root, "packaging/torrserver-lock.json"), "utf8"),
);
const target = `${process.platform}-${process.arch}`;
const asset = lock[target];
if (!asset) throw new Error(`No pinned TorrServer binary for ${target}`);

const output = join(
  root,
  "vendor/torrserver",
  target,
  process.platform === "win32" ? "TorrServer.exe" : "TorrServer",
);
const temporary = `${output}.download`;
await mkdir(dirname(output), { recursive: true });

const response = await fetch(asset.url, { redirect: "follow" });
if (!response.ok) throw new Error(`TorrServer download failed: ${response.status}`);
const bytes = Buffer.from(await response.arrayBuffer());
const digest = createHash("sha256").update(bytes).digest("hex");
if (digest !== asset.sha256)
  throw new Error(`TorrServer checksum mismatch for ${asset.name}`);

try {
  await writeFile(temporary, bytes, { mode: 0o755 });
  await rename(temporary, output);
  await chmod(output, 0o755);
} catch (error) {
  await unlink(temporary).catch(() => undefined);
  throw error;
}

console.log(`Installed TorrServer ${lock.version} for ${target}`);
