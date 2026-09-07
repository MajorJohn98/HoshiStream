import { createServer, type Server } from "node:http";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Library } from "../src/library.ts";
import { NativePicker } from "../src/native-picker.ts";
import { PointerClient } from "../src/pointer.ts";
import { createHandler } from "../src/routes.ts";
import type { AddonInterface } from "../src/server-types.ts";
import type { TorrServerClient } from "../src/torrserver-client.ts";

const token = "pointer-setup-test-private-token";
let root: string;
let server: Server;
let origin: string;
let upstream: ReturnType<typeof vi.fn<typeof fetch>>;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "hoshi-pointer-api-"));
  upstream = vi.fn<typeof fetch>().mockImplementation(async () =>
    Response.json({
      ok: true,
      updatedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 90 * 86400000).toISOString(),
    }),
  );
  const pointer = new PointerClient({
    token,
    pushSecret: "fixture-per-install-push-secret",
    port: 7001,
    statePath: join(root, "pointer-state.json"),
    fetchImpl: upstream,
    lanIp: () => "192.168.1.42",
  });
  server = createServer(
    createHandler({
      library: new Library(join(root, "library.json")),
      addon: {
        manifest: { id: "fixture", version: "0.14.0", catalogs: [] },
        get: async () => ({ metas: [] }),
      } as unknown as AddonInterface,
      torrServer: {
        health: async () => "fixture",
        list: async () => [],
      } as unknown as TorrServerClient,
      accessToken: token,
      homeSpeedMbps: 10,
      nativePicker: new NativePicker(join(root, "missing.sock")),
      publicUrls: {
        addonUrl: "http://192.168.1.42:7001",
        torrServerUrl: "http://192.168.1.42:8090",
      },
      pointer,
    }),
  );
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No test port");
  origin = `http://127.0.0.1:${address.port}`;
});
afterEach(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await rm(root, { recursive: true, force: true });
});
const api = (path: string, input?: object) =>
  fetch(origin + "/api/" + path, {
    method: input ? "POST" : "GET",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: input ? JSON.stringify(input) : undefined,
  });

describe("installed pointer setup API", () => {
  it("authenticates setup and status, saves locally, and only contacts the service after a manual push", async () => {
    for (const path of ["pointer/settings", "pointer/status", "pointer/push"]) {
      expect(
        (
          await fetch(origin + "/api/" + path, {
            method: path.endsWith("status") ? "GET" : "POST",
          })
        ).status,
      ).toBe(401);
    }
    const initial = await api("pointer/status");
    expect(initial.headers.get("cache-control")).toContain("no-store");
    expect(await initial.json()).toMatchObject({
      configured: false,
      suggestedUrl: "https://hoshistream-pointer.vercel.app",
    });
    const saved = await api("pointer/settings", {
      enabled: true,
      pointerUrl: "https://selfhost.example",
    });
    expect(saved.status).toBe(200);
    expect(await saved.json()).toMatchObject({
      configured: true,
      usable: false,
    });
    expect(upstream).not.toHaveBeenCalled();
    expect(
      await readFile(join(root, "pointer-settings.json"), "utf8"),
    ).not.toContain(token);
    const pushed = await api("pointer/push", {});
    expect(pushed.status).toBe(200);
    expect(await pushed.json()).toMatchObject({
      state: "registered",
      usable: true,
    });
    expect(upstream).toHaveBeenCalledOnce();
    expect(
      (
        await api("pointer/settings", {
          enabled: false,
          pointerUrl: "https://selfhost.example",
        })
      ).status,
    ).toBe(200);
    expect(await (await api("pointer/status")).json()).toMatchObject({
      configured: false,
      usable: false,
      state: "disabled",
    });
    expect((await api("pointer/push", {})).status).toBe(409);
    expect(upstream).toHaveBeenCalledOnce();
  });

  it("rejects credential-bearing endpoints and unknown settings without echoing secrets", async () => {
    for (const input of [
      { enabled: true, pointerUrl: "https://operator:secret@pointer.example" },
      { enabled: true, pointerUrl: "https://pointer.example?secret=fixture" },
      {
        enabled: true,
        pointerUrl: "https://pointer.example",
        pushSecret: "must-not-be-a-browser-setting",
      },
    ]) {
      const response = await api("pointer/settings", input);
      expect(response.status).toBe(400);
      expect(await response.text()).not.toContain(
        "must-not-be-a-browser-setting",
      );
    }
    expect(upstream).not.toHaveBeenCalled();
  });

  it("keeps the library available and reports corrupt pointer setup explicitly", async () => {
    await writeFile(join(root, "pointer-settings.json"), "{broken");
    const pointer = await api("pointer/status");
    expect(pointer.status).toBeGreaterThanOrEqual(400);
    expect(await readFile(join(root, "pointer-settings.json"), "utf8")).toBe(
      "{broken",
    );
    const status = await api("status");
    expect(status.status).toBe(200);
    expect(await status.json()).toMatchObject({
      status: "online",
      pointer: { configured: false, state: "storage-error" },
    });
  });
});
