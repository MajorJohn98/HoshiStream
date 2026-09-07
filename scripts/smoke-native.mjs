// Starts an isolated empty stack. Never registers torrents or uses user state.
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { createServer } from "node:net";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { setTimeout as delay } from "node:timers/promises";

const checkout = dirname(dirname(fileURLToPath(import.meta.url)));

export function smokeOptions(args) {
  const options = {};
  for (const arg of args) {
    const [key, ...value] = arg.split("=");
    if (
      !["--runtime-root", "--state-parent", "--dev", "--control-stop"].includes(
        key,
      ) ||
      Object.hasOwn(options, key) ||
      (["--dev", "--control-stop"].includes(key)
        ? value.length
        : !value.join("="))
    )
      throw new Error("Invalid native smoke arguments");
    options[key] = value.join("=") || true;
  }
  if (options["--runtime-root"] && options["--dev"])
    throw new Error("Packaged acceptance cannot use source mode");
  return {
    root: resolve(options["--runtime-root"] || checkout),
    stateParent: resolve(
      options["--state-parent"] || join(checkout, "build/native-smoke"),
    ),
    packaged: Boolean(options["--runtime-root"]),
    dev: Boolean(options["--dev"]),
    controlStop: Boolean(options["--control-stop"]),
  };
}

export function smokeEnvironment(state, packaged, inherited = process.env) {
  const environment = {};
  for (const key of ["SystemRoot", "SYSTEMROOT", "WINDIR", "ComSpec"])
    if (inherited[key]) environment[key] = inherited[key];
  return {
    ...environment,
    PATH:
      process.platform === "win32"
        ? `${inherited.SystemRoot || inherited.SYSTEMROOT || "C:\\Windows"}\\System32`
        : packaged
          ? "/usr/bin:/bin:/usr/sbin:/sbin"
          : inherited.PATH || "",
    HOME: state,
    USERPROFILE: state,
    APPDATA: join(state, "AppData/Roaming"),
    LOCALAPPDATA: join(state, "AppData/Local"),
    TMPDIR: state,
    TEMP: state,
    TMP: state,
  };
}

async function reservePorts() {
  const reservations = [];
  try {
    for (let i = 0; i < 3; i++) {
      const server = createServer();
      reservations.push(server);
      await new Promise((resolveListen, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", resolveListen);
      });
    }
    return reservations.map((server) => server.address().port);
  } finally {
    await Promise.all(
      reservations.map(
        (server) => new Promise((resolveClose) => server.close(resolveClose)),
      ),
    );
  }
}

async function missing(path) {
  return readFile(path).then(
    () => false,
    (error) => {
      if (error.code === "ENOENT") return true;
      throw error;
    },
  );
}

export async function runNativeSmoke(options) {
  let stage = "candidate validation";
  let state, child, exit, helpers, ports;
  let exited = false;
  let cleanupVerified = false;
  let result;
  try {
    const root = await realpath(options.root);
    const stateParent = resolve(options.stateParent);
    if (options.packaged) {
      const inside = relative(root, stateParent);
      if (!inside || (!inside.startsWith(`..${sep}`) && inside !== ".."))
        throw new Error("State must be outside the candidate");
      const node = join(
        root,
        "bin",
        process.platform === "win32" ? "node.exe" : "node",
      );
      if ((await realpath(process.execPath)) !== (await realpath(node)))
        throw new Error("Run with the candidate's own Node");
    }
    await mkdir(stateParent, { recursive: true });
    if (options.packaged) {
      const inside = relative(root, await realpath(stateParent));
      if (!inside || (!inside.startsWith(`..${sep}`) && inside !== ".."))
        throw new Error("State must be outside the candidate");
    }
    helpers = await import(
      pathToFileURL(join(root, "scripts/native-runtime.mjs")).href
    );
    const { restrictAccess } = await import(
      pathToFileURL(join(root, "scripts/private-files.mjs")).href
    );
    const { releaseInfo } = await import(
      pathToFileURL(
        join(
          root,
          options.dev ? "addon/src/release.ts" : "addon/dist/release.js",
        ),
      ).href
    );
    if (options.packaged && releaseInfo.buildId === "source")
      throw new Error("Packaged acceptance requires a stamped identity");
    stage = "disposable setup";
    state = await mkdtemp(join(stateParent, "hoshi-smoke-"));
    await restrictAccess(state, { directory: true });
    ports = await reservePorts();
    const [addonPort, torrServerPort, peerPort] = ports;
    const settings = JSON.parse(
      await readFile(join(root, "packaging/torrserver-settings.json"), "utf8"),
    );
    settings.BitTorr.PeersListenPort = peerPort;
    settings.BitTorr.DisableDHT = true;
    settings.BitTorr.DisablePEX = true;
    const config = join(state, "torrserver/config");
    await mkdir(config, { recursive: true });
    await writeFile(join(config, "settings.json"), JSON.stringify(settings), {
      mode: 0o600,
    });
    await writeFile(
      join(state, ".env"),
      `ACCESS_TOKEN=${randomBytes(32).toString("hex")}\nADDON_PORT=${addonPort}\nMEDIA_DIR=${join(state, "media")}\nMDNS_ENABLED=false\n`,
      { mode: 0o600 },
    );
    stage = "startup";
    const started = performance.now();
    child = spawn(
      process.execPath,
      [
        join(root, "scripts/native-server.mjs"),
        `--project-root=${state}`,
        `--state-dir=${state}`,
        `--torrserver-port=${torrServerPort}`,
        "--parent-control",
        ...(options.dev ? ["--dev"] : []),
      ],
      {
        env: smokeEnvironment(state, options.packaged),
        // Suppress child output entirely: startup errors can contain private URLs.
        stdio: ["pipe", "ignore", "ignore"],
        windowsHide: true,
      },
    );
    child.stdin.on("error", () => {});
    exit = new Promise((resolveExit) => {
      child.once("error", () => {
        exited = true;
        resolveExit({ code: null });
      });
      child.once("exit", (code) => {
        exited = true;
        resolveExit({ code });
      });
    });
    await helpers.waitForRuntime(state, 45_000, child.pid);
    const { info } = await helpers.runtimeStatus(state);
    ports.push(info.port);
    const response = await fetch(`http://127.0.0.1:${addonPort}/ready`, {
      signal: AbortSignal.timeout(2_000),
      redirect: "error",
    });
    if (!response.ok) throw new Error("Readiness failed");
    await response.body?.cancel();
    const library = JSON.parse(
      await readFile(join(state, "library.json"), "utf8"),
    );
    if (!Array.isArray(library) || library.length)
      throw new Error("Expected empty library");
    const startupMs = Math.round(performance.now() - started);
    stage = "shutdown";
    const stopping = performance.now();
    if (options.controlStop) {
      if (!(await helpers.stopRuntime(state)))
        throw new Error("Control shutdown was not acknowledged");
    } else child.stdin.end('{"version":1,"command":"shutdown"}\n');
    const stopped = await Promise.race([
      exit,
      delay(15_000, null, { ref: false }),
    ]);
    if (!stopped || stopped.code !== 0)
      throw new Error("Runtime did not stop cleanly");
    const shutdownMs = Math.round(performance.now() - stopping);
    stage = "ownership and port release";
    for (const name of ["runtime.lock", "control.json"])
      if (!(await missing(join(state, "run", name))))
        throw new Error("Ownership was not released");
    await helpers.ensurePortsFree(ports);
    cleanupVerified = true;
    result = {
      event: "native_smoke_passed",
      mode: options.packaged ? "packaged" : options.dev ? "source" : "built",
      shutdown: options.controlStop
        ? "authenticated-control"
        : "parent-control",
      release: releaseInfo,
      node: process.version,
      platform: process.platform,
      arch: process.arch,
      startupMs,
      shutdownMs,
      emptyLibrary: true,
      ownershipReleased: true,
      tcpPortsReleased: true,
    };
  } catch {
    // Only fixed stage names are exposed; never forward child logs or errors.
    throw new Error(
      `Native smoke failed during ${stage}; child output withheld.`,
    );
  } finally {
    if (child && !exited) {
      child.stdin.end();
      await Promise.race([exit, delay(15_000, null, { ref: false })]);
    }
    if (state && (!child || (exited && cleanupVerified))) {
      await rm(state, { recursive: true, force: true });
    } else if (state) {
      console.error(
        "Disposable smoke state preserved under --state-parent; inspect locally before cleanup. No process was force-killed.",
      );
    }
  }
  return { ...result, disposableStateRemoved: true };
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  try {
    console.log(
      JSON.stringify(await runNativeSmoke(smokeOptions(process.argv.slice(2)))),
    );
  } catch (error) {
    console.error(
      /^Native smoke failed during [a-z ]+; child output withheld\.$/.test(
        error.message,
      )
        ? error.message
        : "Native smoke failed; check arguments and private local state. Error details withheld.",
    );
    process.exitCode = 1;
  }
}
