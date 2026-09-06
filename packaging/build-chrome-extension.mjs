import { mkdir, readFile, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { extensionIdFromKey } from "../scripts/register-browser-bridge.mjs";

const run = promisify(execFile);
const root = dirname(dirname(fileURLToPath(import.meta.url)));
const source = join(root, "addon", "assets", "chrome-extension");
const output = join(root, "build", "HoshiStream-Chrome-Companion.zip");
const manifest = JSON.parse(
  await readFile(join(source, "manifest.json"), "utf8"),
);
if (
  manifest.manifest_version !== 3 ||
  manifest.host_permissions?.length ||
  manifest.externally_connectable
)
  throw new Error("Unexpected Chrome companion permissions");
await mkdir(dirname(output), { recursive: true });
await rm(output, { force: true });
await run("/usr/bin/ditto", ["-c", "-k", "--norsrc", "--noextattr", source, output]);
console.log(
  JSON.stringify({ output, extensionId: extensionIdFromKey(manifest.key) }),
);
