import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { connect, createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

// src/config.ts parses process.env when it is first imported, and index.ts
// pulls it in, so the environment has to be valid before the dynamic import
// below.
Object.assign(process.env, {
  TORRSERVER_INTERNAL_URL: "http://127.0.0.1:8099",
  PUBLIC_TORRSERVER_URL: "http://127.0.0.1:8099",
  PUBLIC_ADDON_URL: "http://127.0.0.1:7787",
  ACCESS_TOKEN: "a-long-private-token-value",
  MDNS_ENABLED: "false",
});

// Fixed ports: the config schema rejects 0, so an ephemeral port is not an
// option here. Each test uses its own to stay independent.
const PORTS = [7787, 7788, 7789];
let portIndex = 0;
const nextPort = () => PORTS[portIndex++]!;

const closers: (() => Promise<void>)[] = [];

afterEach(async () => {
  while (closers.length)
    await closers
      .pop()?.()
      .catch(() => undefined);
});

async function start() {
  const port = nextPort();
  const { parseConfig } = await import("../src/config-schema.ts");
  const { startHoshiStream } = await import("../src/index.ts");
  const directory = await mkdtemp(join(tmpdir(), "hoshistream-shutdown-"));
  const libraryPath = join(directory, "library.json");
  await writeFile(libraryPath, "[]\n");
  const settings = parseConfig({
    ...process.env,
    PUBLIC_ADDON_URL: `http://127.0.0.1:${port}`,
    ADDON_PORT: String(port),
    LIBRARY_PATH: libraryPath,
  });
  const addon = await startHoshiStream(settings);
  closers.push(addon.close);
  return { addon, port };
}

function within(promise: Promise<unknown>, ms = 5_000) {
  return Promise.race([
    promise.then(() => "closed"),
    new Promise((resolve) => setTimeout(() => resolve("timed out"), ms)),
  ]);
}

// Regression: server.close() alone waits for every socket to disappear, so an
// idle keep-alive client kept the daemon alive after the supervisor exited,
// holding the ports and shadowing the next launch.
describe("startHoshiStream shutdown", () => {
  it("closes while an idle keep-alive connection is held open", async () => {
    const { addon, port } = await start();
    const response = await fetch(`http://127.0.0.1:${port}/health`, {
      headers: { Connection: "keep-alive" },
    });
    await response.text();

    await expect(within(addon.close())).resolves.toBe("closed");
  });

  it("closes while a client holds a request open mid-flight", async () => {
    const { addon, port } = await start();
    const socket = connect(port, "127.0.0.1");
    await new Promise((resolve, reject) => {
      socket.once("connect", resolve);
      socket.once("error", reject);
    });
    // A partial request leaves the connection active rather than idle, so it
    // is not covered by Node's own idle-connection handling on close().
    socket.write("GET /health HTTP/1.1\r\nHost: 127.0.0.1\r\n");
    await new Promise((resolve) => setTimeout(resolve, 100));

    try {
      await expect(within(addon.close())).resolves.toBe("closed");
    } finally {
      socket.destroy();
    }
  });

  it("stops listening once closed", async () => {
    const { addon, port } = await start();
    await addon.close();
    await expect(fetch(`http://127.0.0.1:${port}/health`)).rejects.toThrow();
  });
});

async function freePort(): Promise<number> {
  const probe = createServer();
  await new Promise<void>((done) => probe.listen(0, "127.0.0.1", done));
  const address = probe.address();
  await new Promise((done) => probe.close(done));
  if (!address || typeof address === "string") throw new Error("No port");
  return address.port;
}

// Runs src/index.ts as its own process (npm start / npm run dev). A preload
// script waits until the server answers, then performs `trigger`.
async function runDirect(trigger: string) {
  const root = await mkdtemp(join(tmpdir(), "hoshistream-direct-"));
  closers.push(() => rm(root, { recursive: true, force: true }));
  const port = await freePort();
  const preload = join(root, "trigger.mjs");
  await writeFile(
    preload,
    `const poll = setInterval(() => {
      fetch("http://127.0.0.1:${port}/health").then(() => {
        clearInterval(poll);
        setTimeout(() => { ${trigger} }, 50);
      }, () => undefined);
    }, 100);\n`,
  );
  const token = "a-long-private-token-value";
  const child = spawn(
    process.execPath,
    ["--import", pathToFileURL(preload).href, resolve("src/index.ts")],
    {
      cwd: resolve("."),
      env: {
        ...process.env,
        HOME: root,
        USERPROFILE: root,
        LOCALAPPDATA: root,
        XDG_DATA_HOME: root,
        ADDON_PORT: String(port),
        PUBLIC_ADDON_URL: `http://127.0.0.1:${port}`,
        TORRSERVER_INTERNAL_URL: "http://127.0.0.1:1",
        PUBLIC_TORRSERVER_URL: "http://127.0.0.1:1",
        ACCESS_TOKEN: token,
        MDNS_ENABLED: "false",
      },
      stdio: ["ignore", "ignore", "pipe"],
    },
  );
  let stderr = "";
  child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
  const code = await new Promise<number | null>((done, reject) => {
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`direct run did not exit:\n${stderr}`));
    }, 25_000);
    child.once("exit", (exitCode) => {
      clearTimeout(timer);
      done(exitCode);
    });
  });
  return { code, stderr, port, token };
}

describe("direct run process handling", () => {
  it("shuts down cleanly on an uncaught exception without leaking secrets", async () => {
    const { code, stderr, port, token } = await runDirect(
      `throw new Error("boom magnet:?xt=urn:btih:abcdef&dn=Film ${"a-long-private-token-value"}");`,
    );
    expect(code).toBe(1);
    expect(stderr).toContain('"event":"uncaught_exception"');
    expect(stderr).not.toContain("btih:abcdef");
    expect(stderr).not.toContain(token);
    await expect(fetch(`http://127.0.0.1:${port}/health`)).rejects.toThrow();
  }, 30_000);

  it("shuts down cleanly on an unhandled rejection", async () => {
    const { code, stderr } = await runDirect(
      `Promise.reject(new Error("stray"));`,
    );
    expect(code).toBe(1);
    expect(stderr).toContain('"event":"unhandled_rejection"');
  }, 30_000);

  it.skipIf(process.platform === "win32")(
    "closes and exits 0 on SIGTERM",
    async () => {
      const { code } = await runDirect(`process.kill(process.pid, "SIGTERM");`);
      expect(code).toBe(0);
    },
    30_000,
  );
});
