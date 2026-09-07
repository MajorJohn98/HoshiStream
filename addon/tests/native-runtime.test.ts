import { createServer } from "node:http";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import {
  claimRuntimeState,
  createRuntimeControl,
  ensurePortsFree,
  loadAddon,
  nativeOptions,
  portNumber,
  runtimeStatus,
  stopRuntime,
  waitForRuntime,
  waitForService,
} from "../../scripts/native-runtime.mjs";

const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});

async function state() {
  const directory = await mkdtemp(join(tmpdir(), "hoshi-runtime-"));
  cleanup.push(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

describe("native runtime ownership", { timeout: 30_000 }, () => {
  it("publishes a complete exclusive lock and releases only its own identity", async () => {
    const root = await state();
    const owner = await claimRuntimeState(root);
    await expect(claimRuntimeState(root)).rejects.toThrow("owns this state");
    const lock = JSON.parse(
      await readFile(join(root, "run", "runtime.lock"), "utf8"),
    );
    expect(lock.pid).toBe(process.pid);
    expect(lock.instance).toBe(owner.instance);
    await owner.release();
    const next = await claimRuntimeState(root);
    await owner.release();
    await expect(claimRuntimeState(root)).rejects.toThrow("owns this state");
    await next.release();
  });

  it("recovers a dead owner without deleting another live launch", async () => {
    const root = await state();
    const owner = await claimRuntimeState(root);
    await writeFile(
      join(root, "run", "runtime.lock"),
      JSON.stringify({
        version: 1,
        pid: 2_000_000_000,
        instance: owner.instance,
      }),
    );
    const results = await Promise.allSettled([
      claimRuntimeState(root),
      claimRuntimeState(root),
    ]);
    const winners = results.filter((item) => item.status === "fulfilled");
    expect(winners).toHaveLength(1);
    for (const winner of winners) await winner.value.release();
  });

  it("refuses malformed ownership metadata instead of deleting it", async () => {
    const root = await state();
    await claimRuntimeState(root);
    const path = join(root, "run", "runtime.lock");
    await writeFile(path, "not a lock");
    await expect(claimRuntimeState(root)).rejects.toThrow();
    expect(await readFile(path, "utf8")).toBe("not a lock");
  });
});

describe("native control", { timeout: 30_000 }, () => {
  it("does not claim a live starting runtime is stopped before control is published", async () => {
    const root = await state();
    const owner = await claimRuntimeState(root);
    await expect(stopRuntime(root)).rejects.toThrow("control is not ready");
    await owner.release();
    expect(await stopRuntime(root)).toBe(false);
  });
  it("requires a private capability, reports actual readiness and shuts down gracefully", async () => {
    const root = await state();
    const identity = await claimRuntimeState(root);
    let shutdown: Promise<void> | undefined;
    const control = await createRuntimeControl({
      stateRoot: root,
      identity,
      addonPort: 7001,
      shutdown: () => {
        shutdown = (async () => {
          await control.close();
          await identity.release();
        })();
      },
    });
    const { info, status } = await runtimeStatus(root);
    cleanup.push(() => control.close());
    expect(status.ready).toBe(false);
    expect(status).not.toHaveProperty("secret");
    const url = `http://127.0.0.1:${info.port}/stop`;
    expect((await fetch(url, { method: "POST" })).status).toBe(403);
    expect(
      (
        await fetch(url, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${info.secret}`,
            Origin: "http://127.0.0.1:7001",
          },
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await fetch(url, {
          method: "POST",
          headers: { Authorization: "é".repeat(71) },
        })
      ).status,
    ).toBe(403);
    await expect(waitForRuntime(root, 20)).rejects.toThrow(
      "did not become ready",
    );
    control.markReady();
    expect((await waitForRuntime(root)).ready).toBe(true);
    expect(await stopRuntime(root)).toBe(true);
    await shutdown;
    expect(await stopRuntime(root)).toBe(false);
  });

  it("does not stop a process when the private control identity differs", async () => {
    const root = await state();
    const identity = await claimRuntimeState(root);
    const control = await createRuntimeControl({
      stateRoot: root,
      identity,
      addonPort: 7001,
      shutdown: () => {
        throw new Error("Must not stop");
      },
    });
    cleanup.push(() => control.close());
    const path = join(root, "run", "control.json");
    const data = JSON.parse(await readFile(path, "utf8"));
    await writeFile(
      path,
      JSON.stringify({ ...data, instance: "0".repeat(48) }),
    );
    await expect(stopRuntime(root)).rejects.toThrow("identity changed");
  });
});

describe("native startup", () => {
  it("does not start an add-on whose import completes after shutdown", async () => {
    const controller = new AbortController();
    let finishImport!: (value: object) => void;
    const loading = loadAddon(
      "unused",
      controller.signal,
      () =>
        new Promise<object>((resolve) => {
          finishImport = resolve;
        }),
    );
    controller.abort();
    finishImport({
      startHoshiStream: () => {
        throw new Error("Must not start");
      },
    });
    await expect(loading).rejects.toThrow();
  });
  it("parses paths containing spaces and equals without shell interpretation", () => {
    expect(nativeOptions(["--dev", "--state-dir=C:\\A B\\x=y"])).toEqual({
      dev: "true",
      "state-dir": "C:\\A B\\x=y",
    });
    expect(portNumber("7001")).toBe(7001);
    for (const input of ["no", 0, 65536, 7.5])
      expect(() => portNumber(input)).toThrow();
  });

  it("rejects occupied ports instead of adopting an unrelated service", async () => {
    const server = createServer();
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    cleanup.push(
      () => new Promise<void>((resolve) => server.close(() => resolve())),
    );
    const address = server.address();
    if (!address || typeof address === "string")
      throw new Error("Missing port");
    await expect(ensurePortsFree([address.port])).rejects.toThrow(
      "already in use",
    );
  });

  it("bounds readiness requests even when an HTTP server never responds", async () => {
    const server = createServer(() => undefined);
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    cleanup.push(async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    });
    const address = server.address();
    if (!address || typeof address === "string")
      throw new Error("Missing port");
    await expect(
      waitForService(`http://127.0.0.1:${address.port}/ready`, {
        timeoutMs: 30,
      }),
    ).rejects.toThrow("did not become ready");
  });
});
