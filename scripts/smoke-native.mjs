// Starts an isolated empty stack. Never registers torrents or uses user state.
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { waitForRuntime, stopRuntime } from "./native-runtime.mjs";
import { restrictAccess } from "./private-files.mjs";

const runtimeArgument = process.argv
  .slice(2)
  .find((arg) => arg.startsWith("--runtime-root="));
const root = runtimeArgument
  ? resolve(runtimeArgument.slice("--runtime-root=".length))
  : dirname(dirname(fileURLToPath(import.meta.url)));
const state = await mkdtemp(join(tmpdir(), "hoshi-smoke-"));
await restrictAccess(state, { directory: true });
const reservations = [];
for (let i = 0; i < 3; i++) {
  const server = createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  reservations.push(server);
}
const [addonPort, torrServerPort, peerPort] = reservations.map(
  (server) => server.address().port,
);
await Promise.all(
  reservations.map((server) => new Promise((resolve) => server.close(resolve))),
);
const settings = JSON.parse(
  await readFile(join(root, "packaging/torrserver-settings.json"), "utf8"),
);
settings.BitTorr.PeersListenPort = peerPort;
settings.BitTorr.DisableDHT = true;
settings.BitTorr.DisablePEX = true;
const config = join(state, "torrserver", "config");
await mkdir(config, { recursive: true });
await writeFile(join(config, "settings.json"), JSON.stringify(settings));
await writeFile(
  join(state, ".env"),
  `ACCESS_TOKEN=${randomBytes(32).toString("hex")}\nADDON_PORT=${addonPort}\nMEDIA_DIR=${join(state, "media")}\nMDNS_ENABLED=false\n`,
  { mode: 0o600 },
);
const child = spawn(
  process.execPath,
  [
    join(root, "scripts/native-server.mjs"),
    `--project-root=${state}`,
    `--state-dir=${state}`,
    `--torrserver-port=${torrServerPort}`,
    "--parent-control",
    ...(process.argv.includes("--dev") ? ["--dev"] : []),
  ],
  { stdio: ["pipe", "pipe", "pipe"], windowsHide: true },
);
let exited = false;
const exit = new Promise((resolve, reject) => {
  child.once("error", reject);
  child.once("exit", (code, signal) => {
    exited = true;
    resolve({ code, signal });
  });
});
let logs = "";
for (const output of [child.stdout, child.stderr])
  output.on("data", (bytes) => {
    logs = (logs + bytes.toString()).slice(-16_000);
  });
try {
  await waitForRuntime(state, 45_000, child.pid);
  const response = await fetch(`http://127.0.0.1:${addonPort}/ready`);
  if (!response.ok) throw new Error("Readiness failed");
  await response.body?.cancel();
  if (process.argv.includes("--control-stop")) await stopRuntime(state);
  else child.stdin.end('{"version":1,"command":"shutdown"}\n');
  const result = await Promise.race([
    exit,
    delay(15_000, null, { ref: false }),
  ]);
  if (!result || result.code !== 0)
    throw new Error("Runtime did not stop cleanly");
  const remaining = await readFile(
    join(state, "run", "runtime.lock"),
    "utf8",
  ).then(
    () => true,
    (error) => {
      if (error.code === "ENOENT") return false;
      throw error;
    },
  );
  if (remaining) throw new Error("Runtime ownership was not released");
  console.log(
    `Native ${process.argv.includes("--dev") ? "source" : "built"} startup and shutdown succeeded.`,
  );
} catch (error) {
  console.error(logs);
  throw error;
} finally {
  if (!exited) {
    child.stdin.end();
    await Promise.race([exit, delay(15_000, null, { ref: false })]);
  }
  if (exited) await rm(state, { recursive: true, force: true });
  else
    console.error(
      `Runtime still active; temporary state preserved at ${state}`,
    );
}
