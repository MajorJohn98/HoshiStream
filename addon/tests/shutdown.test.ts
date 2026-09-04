import { mkdtemp, writeFile } from "node:fs/promises";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
