import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmod,
  mkdir,
  readFile,
  rename,
  unlink,
  writeFile,
} from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const lock = JSON.parse(
  await readFile(join(root, "packaging/node-lock.json"), "utf8"),
);
const target = `${process.platform}-${process.arch}`;
const asset = lock[target];
if (!asset) throw new Error(`No pinned Node.js runtime for ${target}`);

const output = join(root, "vendor/node", target, "node");
const archive = `${output}.tar.gz`;
const extracted = join(dirname(output), `${asset.name.slice(0, -7)}/bin/node`);
await mkdir(dirname(output), { recursive: true });

const response = await fetch(asset.url, { redirect: "follow" });
if (!response.ok) throw new Error(`Node.js download failed: ${response.status}`);
const bytes = Buffer.from(await response.arrayBuffer());
const digest = createHash("sha256").update(bytes).digest("hex");
if (digest !== asset.sha256)
  throw new Error(`Node.js checksum mismatch for ${asset.name}`);

try {
  await writeFile(archive, bytes, { mode: 0o600 });
  await new Promise((resolveExtract, rejectExtract) => {
    const child = spawn("tar", ["-xzf", archive, "-C", dirname(output)]);
    child.once("error", rejectExtract);
    child.once("exit", (code) =>
      code === 0
        ? resolveExtract()
        : rejectExtract(new Error(`tar exited with status ${code}`)),
    );
  });
  await rename(extracted, output);
  await chmod(output, 0o755);
} finally {
  await unlink(archive).catch(() => undefined);
}

console.log(`Installed Node.js ${lock.version} for ${target}`);
