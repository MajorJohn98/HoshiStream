import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  access,
  lstat,
  readdir,
  readFile,
  realpath,
  writeFile,
} from "node:fs/promises";
import { delimiter, dirname, join, resolve } from "node:path";

export function run(command, args, cwd, { capture = false } = {}) {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(command, args, {
      cwd,
      shell: false,
      windowsHide: true,
      stdio: capture ? ["ignore", "pipe", "inherit"] : "inherit",
    });
    let output = "";
    child.stdout?.setEncoding("utf8").on("data", (chunk) => (output += chunk));
    child.once("error", rejectRun);
    child.once("close", (code) =>
      code === 0
        ? resolveRun(output)
        : rejectRun(new Error(`${command} exited with status ${code}`)),
    );
  });
}

export async function npmCommand(env = process.env) {
  const executable = await realpath(process.execPath);
  const candidates = [
    env.npm_execpath,
    join(dirname(executable), "node_modules/npm/bin/npm-cli.js"),
    resolve(dirname(executable), "../lib/node_modules/npm/bin/npm-cli.js"),
    ...String(env.PATH ?? "")
      .split(delimiter)
      .filter(Boolean)
      .flatMap((directory) => [
        join(directory, "node_modules/npm/bin/npm-cli.js"),
        resolve(directory, "../lib/node_modules/npm/bin/npm-cli.js"),
      ]),
  ];
  for (const candidate of candidates) {
    if (!candidate || !candidate.endsWith("npm-cli.js")) continue;
    try {
      await access(candidate);
      return [process.execPath, [candidate]];
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
  throw new Error(
    "Cannot locate npm-cli.js. Install Node with npm to build (not required to run the app).",
  );
}

export function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

export async function downloadPinned(asset) {
  if (!/^[a-f0-9]{64}$/.test(asset.sha256) || !asset.url.startsWith("https://"))
    throw new Error("Invalid pinned download metadata");
  const response = await fetch(asset.url, {
    redirect: "follow",
    signal: AbortSignal.timeout(180_000),
  });
  if (!response.ok)
    throw new Error(`Download failed (${response.status}): ${asset.name}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (sha256(bytes) !== asset.sha256)
    throw new Error(`Checksum mismatch: ${asset.name}`);
  return bytes;
}

export function validateArchiveEntries(listing) {
  const entries = listing.split(/\r?\n/).filter(Boolean);
  if (!entries.length) throw new Error("Empty runtime archive");
  for (const entry of entries) {
    if (
      entry.startsWith("/") ||
      entry.includes("\\") ||
      entry.includes(":") ||
      entry.includes("\0") ||
      entry.split("/").includes("..")
    )
      throw new Error(`Unsafe runtime archive entry: ${entry}`);
  }
}

export async function regularFiles(directory, prefix = "") {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const name = prefix ? `${prefix}/${entry.name}` : entry.name;
    const path = join(directory, entry.name);
    const stat = await lstat(path);
    if (stat.isSymbolicLink() || (!stat.isFile() && !stat.isDirectory()))
      throw new Error(`Unsupported link or special file in payload: ${name}`);
    if (stat.isDirectory()) files.push(...(await regularFiles(path, name)));
    else files.push(name);
  }
  return files.sort();
}

export async function extractArchive(archive, directory) {
  validateArchiveEntries(
    await run("tar", ["-tf", archive], undefined, { capture: true }),
  );
  await run("tar", ["-xf", archive, "-C", directory]);
  await regularFiles(directory);
}

export async function writeChecksum(path) {
  await writeFile(
    `${path}.sha256`,
    `${sha256(await readFile(path))}  ${path.split(/[\\/]/).at(-1)}\n`,
  );
}
