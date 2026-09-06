import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Onboarding } from "../src/onboarding.ts";
import { Library } from "../src/library.ts";
import { NativePicker } from "../src/native-picker.ts";
import { createHandler } from "../src/routes.ts";
import type { AddonInterface } from "../src/server-types.ts";
import type { TorrServerClient } from "../src/torrserver-client.ts";
import {
  onboardingReport,
  setupProgress,
} from "../assets/manage/onboarding-state.js";

const roots: string[] = [];
async function root() {
  const path = await mkdtemp(join(tmpdir(), "hoshistream-onboarding-"));
  roots.push(path);
  return path;
}
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("local onboarding state", () => {
  it("offers welcome only on fresh installs and persists dismissal across restarts", async () => {
    const directory = await root();
    const path = join(directory, "onboarding.json");
    const state = new Onboarding(path, true);
    expect((await state.read()).welcomePending).toBe(true);
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    await state.update({ action: "dismiss" }, false);
    const reopened = new Onboarding(path, true);
    expect(await reopened.read()).toMatchObject({
      status: "dismissed",
      welcomePending: false,
    });
    expect(
      (await new Onboarding(join(directory, "existing-install.json")).read())
        .welcomePending,
    ).toBe(false);
    await reopened.update({ action: "resume" }, false);
    expect(await reopened.read()).toMatchObject({
      status: "active",
      welcomePending: false,
    });
  });

  it("requires real media plus explicit player confirmation, not copying a URL", async () => {
    const state = new Onboarding(join(await root(), "onboarding.json"));
    await expect(state.update({ action: "finish" }, false)).rejects.toThrow(
      "Add a title",
    );
    await expect(state.update({ action: "finish" }, true)).rejects.toThrow(
      "confirm",
    );
    await state.update({ action: "confirm-client", client: "nuvio" }, false);
    await expect(state.update({ action: "finish" }, false)).rejects.toThrow(
      "Add a title",
    );
    await state.update({ action: "finish" }, true);
    expect((await state.read()).status).toBe("complete");
    await state.update({ action: "select-client", client: "stremio" }, true);
    expect(await state.read()).toMatchObject({
      client: "stremio",
      clientConfirmed: false,
      status: "active",
    });
    await expect(
      state.update({ action: "confirm-client", client: "nuvio" }, true),
    ).rejects.toThrow("selection changed");
  });

  it("serializes updates and keeps malformed state intact", async () => {
    const path = join(await root(), "onboarding.json");
    const state = new Onboarding(path, true);
    await Promise.all([
      state.update({ action: "welcome-shown" }, false),
      state.update({ action: "select-client", client: "stremio" }, false),
      state.update({ action: "confirm-client", client: "stremio" }, false),
    ]);
    expect(await state.read()).toMatchObject({
      welcomePending: false,
      client: "stremio",
      clientConfirmed: true,
    });
    const broken = join(await root(), "onboarding.json");
    await writeFile(broken, "{invalid");
    await expect(new Onboarding(broken, true).read()).rejects.toThrow();
    expect(await readFile(broken, "utf8")).toBe("{invalid");
  });
});

describe("onboarding API", () => {
  it("guards setup and its private LAN address, derives progress, and never adds media", async () => {
    const directory = await root();
    const libraryPath = join(directory, "library.json");
    await writeFile(libraryPath, "[]");
    const library = new Library(libraryPath);
    const onboarding = new Onboarding(join(directory, "onboarding.json"), true);
    const token = "private-onboarding-fixture-token";
    const server = createServer(
      createHandler({
        library,
        onboarding,
        addon: {
          manifest: { id: "fixture" },
          get: async () => ({ metas: [] }),
        } as unknown as AddonInterface,
        torrServer: {
          health: async () => "fixture",
          list: async () => [],
        } as unknown as TorrServerClient,
        accessToken: token,
        homeSpeedMbps: 100,
        nativePicker: new NativePicker(join(directory, "missing.sock")),
        publicUrls: {
          addonUrl: "http://192.168.1.42:7001",
          torrServerUrl: "http://192.168.1.42:8090",
        },
      }),
    );
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    const address = server.address();
    if (!address || typeof address === "string")
      throw Error("Missing test port");
    const base = `http://127.0.0.1:${address.port}`;
    const headers = {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    };
    try {
      expect((await fetch(`${base}/api/onboarding`)).status).toBe(401);
      const response = await fetch(`${base}/api/onboarding`, { headers });
      expect(response.headers.get("cache-control")).toContain("no-store");
      const report = await response.json();
      expect(report).toMatchObject({
        hasMedia: false,
        loopbackOnly: false,
        addonUrl: `http://192.168.1.42:7001/addon/${token}/manifest.json`,
      });
      expect(onboardingReport(report)).toEqual(report);
      expect(setupProgress([], report).count).toBe(0);
      const status = await (
        await fetch(`${base}/api/status`, { headers })
      ).json();
      expect(status.onboarding).toEqual({
        available: true,
        welcomePending: true,
      });
      const update = await fetch(`${base}/api/onboarding`, {
        method: "POST",
        headers,
        body: JSON.stringify({ action: "finish" }),
      });
      expect(update.status).toBe(409);
      const invalid = await fetch(`${base}/api/onboarding`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          action: "select-client",
          client: "unsupported",
        }),
      });
      expect(invalid.status).toBe(400);
      await fetch(`${base}/api/onboarding`, {
        method: "POST",
        headers,
        body: JSON.stringify({ action: "dismiss" }),
      });
      expect(await library.list()).toEqual([]);
      expect((await onboarding.read()).welcomePending).toBe(false);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});

describe("onboarding browser boundary", () => {
  it("rejects invalid state and non-HTTP add-on destinations", () => {
    expect(() => onboardingReport(null)).toThrow("unexpected");
    const report = {
      state: {
        version: 1,
        status: "active",
        client: "nuvio",
        clientConfirmed: false,
        welcomePending: false,
      },
      hasMedia: true,
      loopbackOnly: false,
      observedClient: null,
      addonUrl: "javascript:alert(1)",
    };
    expect(() => onboardingReport(report)).toThrow("not supported");
    expect(setupProgress([], { ...report, hasMedia: true }).count).toBe(0);
  });
});
