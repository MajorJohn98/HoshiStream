import { resolve } from "node:path";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { defaultStateRoot } from "./bootstrap.mjs";
import {
  nativeOptions,
  runtimeStatus,
  stopRuntime,
  waitForRuntime,
} from "./native-runtime.mjs";
import { restrictAccess } from "./private-files.mjs";

const command = process.argv[2];
const options = nativeOptions(process.argv.slice(3));
const stateRoot = resolve(
  options["state-dir"] ??
    process.env.HOSHISTREAM_STATE_DIR ??
    defaultStateRoot(),
);

try {
  if (command === "wait") {
    const pid = options.pid === undefined ? undefined : Number(options.pid);
    if (pid !== undefined && (!Number.isSafeInteger(pid) || pid <= 0))
      throw new Error("Invalid expected process ID");
    await waitForRuntime(stateRoot, 45_000, pid);
    console.log("HoshiStream native server is ready.");
  } else if (command === "stop") {
    const stopped = await stopRuntime(stateRoot);
    console.log(
      stopped
        ? "HoshiStream native server stopped."
        : "HoshiStream native server is not running.",
    );
  } else if (command === "status") {
    const { status } = await runtimeStatus(stateRoot);
    console.log(JSON.stringify(status));
  } else if (command === "prepare") {
    const logs = join(stateRoot, "logs");
    await mkdir(logs, { recursive: true, mode: 0o700 });
    await restrictAccess(logs, { directory: true });
  } else {
    throw new Error(
      "Usage: native-control.mjs wait|stop|status|prepare [--state-dir=PATH]",
    );
  }
} catch (error) {
  // Control metadata contains a capability, so never print arbitrary fetch
  // objects, request headers, or the metadata itself.
  console.error(
    error instanceof Error ? error.message : "Native control failed",
  );
  process.exitCode = 1;
}
