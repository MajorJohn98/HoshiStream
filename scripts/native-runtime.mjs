import { randomBytes, timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { mkdir, link, readFile, unlink, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { restrictAccess } from "./private-files.mjs";

const { z } = createRequire(new URL("../addon/package.json", import.meta.url))(
  "zod",
);
const identitySchema = z.object({
  version: z.literal(1),
  pid: z.number().int().positive(),
  instance: z.string().regex(/^[a-f0-9]{48}$/),
});
const controlSchema = identitySchema.extend({
  port: z.number().int().min(1).max(65535),
  secret: z.string().regex(/^[a-f0-9]{64}$/),
});
const statusSchema = identitySchema.extend({
  ready: z.boolean(),
  stopping: z.boolean(),
  addonPort: z.number().int().min(1).max(65535),
});

export function nativeOptions(args) {
  return Object.fromEntries(
    args
      .filter((value) => value.startsWith("--"))
      .map((value) => {
        const [key, ...rest] = value.slice(2).split("=");
        return [key, rest.join("=") || "true"];
      }),
  );
}

export function portNumber(value) {
  return z.coerce.number().int().min(1).max(65535).parse(value);
}

export async function loadAddon(
  url,
  signal,
  importer = (entry) => import(entry),
) {
  signal.throwIfAborted();
  const loaded = await importer(url);
  signal.throwIfAborted();
  return loaded;
}

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error.code === "ESRCH") return false;
    if (error.code === "EPERM") return true;
    throw error;
  }
}

async function readJson(path, schema) {
  const text = await readFile(path, "utf8");
  if (text.length > 4_096) throw new Error("Invalid native runtime metadata");
  return schema.parse(JSON.parse(text));
}

async function removeOwned(path, instance) {
  try {
    const value = await readJson(path, identitySchema);
    if (value.instance === instance) await unlink(path);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
}

// Publish complete metadata atomically. A hard link has create-if-absent
// semantics on both NTFS and POSIX, without an empty-file startup window.
async function publish(path, value) {
  const temporary = `${path}.${randomBytes(8).toString("hex")}.tmp`;
  try {
    await writeFile(temporary, JSON.stringify(value), {
      flag: "wx",
      mode: 0o600,
    });
    await restrictAccess(temporary);
    await link(temporary, path);
  } finally {
    await unlink(temporary).catch((error) => {
      if (error.code !== "ENOENT") throw error;
    });
  }
}

async function claimFile(path, identity, depth = 0) {
  try {
    await publish(path, identity);
    return;
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
  }
  const existing = await readJson(path, identitySchema);
  if (isAlive(existing.pid))
    throw new Error(
      "Another HoshiStream process owns this state directory. Stop it before starting another instance.",
    );
  if (depth >= 3)
    throw new Error("Stale runtime recovery locks need manual inspection");
  // Serialize stale-lock recovery so simultaneous launches cannot unlink
  // each other's newly acquired lock.
  const recovery = `${path}.recovery`;
  await claimFile(recovery, identity, depth + 1);
  try {
    let current;
    try {
      current = await readJson(path, identitySchema);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    if (current) {
      if (current.instance !== existing.instance || isAlive(current.pid))
        throw new Error("Another HoshiStream instance started during recovery");
      await unlink(path);
    }
    await publish(path, identity);
  } finally {
    await removeOwned(recovery, identity.instance);
  }
}

export async function claimRuntimeState(stateRoot) {
  const run = join(resolve(stateRoot), "run");
  await mkdir(run, { recursive: true, mode: 0o700 });
  await restrictAccess(run, { directory: true });
  const path = join(run, "runtime.lock");
  const identity = {
    version: 1,
    pid: process.pid,
    instance: randomBytes(24).toString("hex"),
  };
  await claimFile(path, identity);
  return {
    ...identity,
    release: () => removeOwned(path, identity.instance),
  };
}

export async function ensurePortsFree(ports) {
  for (const port of new Set(ports)) {
    for (const host of ["127.0.0.1", "0.0.0.0"]) {
      const probe = createServer();
      try {
        await new Promise((resolveListen, reject) => {
          probe.once("error", reject);
          probe.listen({ host, port, exclusive: true }, resolveListen);
        });
      } catch (error) {
        if (error.code === "EADDRINUSE")
          throw new Error(
            `Port ${port} is already in use. Stop the existing app or change the configured port.`,
          );
        throw error;
      } finally {
        if (probe.listening)
          await new Promise((resolveClose) => probe.close(resolveClose));
      }
    }
  }
}

export async function waitForService(url, { signal, timeoutMs = 30_000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    signal?.throwIfAborted();
    try {
      const requestSignal = AbortSignal.timeout(
        Math.max(1, Math.min(1_000, deadline - Date.now())),
      );
      const response = await fetch(url, {
        signal: signal
          ? AbortSignal.any([signal, requestSignal])
          : requestSignal,
        redirect: "error",
      });
      await response.body?.cancel();
      if (response.ok) return;
    } catch (error) {
      if (signal?.aborted) throw error;
    }
    await delay(150, undefined, { signal });
  }
  throw new Error(`Service did not become ready on port ${new URL(url).port}`);
}

export async function createRuntimeControl({
  stateRoot,
  identity,
  addonPort,
  shutdown,
}) {
  const path = join(stateRoot, "run", "control.json");
  const secret = randomBytes(32).toString("hex");
  let ready = false;
  let stopping = false;
  const server = createServer((request, response) => {
    const supplied = request.headers.authorization ?? "";
    const expected = `Bearer ${secret}`;
    const suppliedBytes = Buffer.from(supplied);
    const expectedBytes = Buffer.from(expected);
    if (
      suppliedBytes.length !== expectedBytes.length ||
      !timingSafeEqual(suppliedBytes, expectedBytes) ||
      request.headers.origin ||
      request.headers["transfer-encoding"] ||
      (request.headers["content-length"] ?? "0") !== "0"
    ) {
      response.writeHead(403).end();
      return;
    }
    if (request.url === "/status" && request.method === "GET") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          version: 1,
          pid: identity.pid,
          instance: identity.instance,
          ready,
          stopping,
          addonPort,
        }),
      );
    } else if (request.url === "/stop" && request.method === "POST") {
      stopping = true;
      response.writeHead(202).end();
      setImmediate(shutdown);
    } else {
      response.writeHead(404).end();
    }
  });
  server.requestTimeout = 2_000;
  server.headersTimeout = 2_000;
  server.maxHeadersCount = 16;
  server.on("connection", (socket) =>
    socket.setTimeout(2_000, () => socket.destroy()),
  );
  await new Promise((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolveListen);
  });
  try {
    // State ownership has already been acquired, so stale control metadata
    // belongs to a previous, dead runtime, not a concurrently running one.
    await unlink(path).catch((error) => {
      if (error.code !== "ENOENT") throw error;
    });
    await publish(path, {
      version: 1,
      pid: identity.pid,
      instance: identity.instance,
      port: server.address().port,
      secret,
    });
  } catch (error) {
    server.close();
    throw error;
  }
  return {
    markReady() {
      ready = true;
    },
    async close() {
      stopping = true;
      server.closeAllConnections();
      await new Promise((resolveClose) => server.close(resolveClose));
      await removeOwned(path, identity.instance);
    },
  };
}

export async function runtimeStatus(stateRoot) {
  const info = await readJson(
    join(stateRoot, "run", "control.json"),
    controlSchema,
  );
  const response = await fetch(`http://127.0.0.1:${info.port}/status`, {
    headers: { Authorization: `Bearer ${info.secret}` },
    signal: AbortSignal.timeout(1_500),
    redirect: "error",
  });
  if (!response.ok)
    throw new Error("Native runtime control rejected the request");
  const status = statusSchema.parse(await response.json());
  if (status.instance !== info.instance || status.pid !== info.pid)
    throw new Error("Native runtime identity changed; retry the command");
  return { info, status };
}

export async function waitForRuntime(
  stateRoot,
  timeoutMs = 45_000,
  expectedPid,
) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (expectedPid && !isAlive(expectedPid))
      throw new Error(
        "Native server exited before readiness. Inspect its logs.",
      );
    try {
      const { status } = await runtimeStatus(stateRoot);
      if (expectedPid && status.pid !== expectedPid)
        throw new Error("Another native runtime owns this state directory");
      if (status.stopping)
        throw new Error("Native runtime stopped during startup");
      if (status.ready) return status;
    } catch (error) {
      if (
        error.code !== "ENOENT" &&
        !(error instanceof TypeError && error.cause?.code === "ECONNREFUSED")
      )
        throw error;
    }
    await delay(200);
  }
  throw new Error(
    "Native server did not become ready. Inspect the state directory logs.",
  );
}

export async function stopRuntime(stateRoot, timeoutMs = 15_000) {
  let current;
  try {
    current = await runtimeStatus(stateRoot);
  } catch (error) {
    if (error.code === "ENOENT") {
      let owner;
      try {
        owner = await readJson(
          join(stateRoot, "run", "runtime.lock"),
          identitySchema,
        );
      } catch (lockError) {
        if (lockError.code !== "ENOENT") throw lockError;
      }
      if (owner && isAlive(owner.pid))
        throw new Error(
          "Native runtime owns the state directory but control is not ready. Retry shutdown shortly.",
        );
      return false;
    }
    throw error;
  }
  const response = await fetch(`http://127.0.0.1:${current.info.port}/stop`, {
    method: "POST",
    headers: { Authorization: `Bearer ${current.info.secret}` },
    signal: AbortSignal.timeout(2_000),
    redirect: "error",
  });
  if (response.status !== 202)
    throw new Error("Native server refused the shutdown request");
  await response.body?.cancel();
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const identity = await readJson(
        join(stateRoot, "run", "runtime.lock"),
        identitySchema,
      );
      if (identity.instance !== current.info.instance)
        throw new Error(
          "Another runtime started while stopping; it was not terminated",
        );
    } catch (error) {
      if (error.code === "ENOENT") return true;
      throw error;
    }
    await delay(150);
  }
  throw new Error(
    "Native server did not stop in time. No unverified process was force-terminated; inspect its logs.",
  );
}
