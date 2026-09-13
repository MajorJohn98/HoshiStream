import { createServer, type Server } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  installConsoleTap,
  LogRing,
  redactDiagnostics,
  redactText,
} from "../src/diagnostics.ts";
import { Library } from "../src/library.ts";
import { NativePicker } from "../src/native-picker.ts";
import { createHandler } from "../src/routes.ts";
import { TorrServerClient } from "../src/torrserver-client.ts";

const ACCESS_TOKEN = "fixture-access-token-0123456789abcdef";
const PUSH_SECRET = "fixture-pointer-push-secret-9876543210";
const HOME = "/Users/someone";
const secrets = {
  accessToken: ACCESS_TOKEN,
  pushSecret: PUSH_SECRET,
  homeDir: HOME,
};

describe("redactText", () => {
  it("removes the access token and push secret wherever they appear", () => {
    const text = `manifest http://host/${ACCESS_TOKEN}/manifest.json secret=${PUSH_SECRET}`;
    const out = redactText(text, secrets);
    expect(out).not.toContain(ACCESS_TOKEN);
    expect(out).not.toContain(PUSH_SECRET);
    expect(out).toContain("http://host/[redacted]/manifest.json");
  });

  it("blanks Authorization header values in JSON and raw form", () => {
    const json = redactText(
      JSON.stringify({ authorization: "Bearer abc.def-123" }),
      secrets,
    );
    expect(json).toBe('{"authorization":"[redacted]"}');
    expect(redactText("Authorization: Bearer zzz", secrets)).toBe(
      "Authorization: [redacted]",
    );
    expect(redactText("got Bearer tok_en=", secrets)).toBe(
      "got Bearer [redacted]",
    );
  });

  it("collapses complete magnet URIs but leaves bare hashes", () => {
    const hash = "c".repeat(40);
    const out = redactText(
      `add magnet:?xt=urn:btih:${hash}&dn=Show&tr=udp://tracker hash=${hash}`,
      secrets,
    );
    expect(out).toBe(`add magnet:[redacted] hash=${hash}`);
  });

  it("hides query tokens and env-style assignments", () => {
    expect(redactText("http://x/api?token=abc&other=1", secrets)).toBe(
      "http://x/api?token=[redacted]&other=1",
    );
    expect(redactText("ACCESS_TOKEN=abcdefghijklmnopqrstu", secrets)).toBe(
      "ACCESS_TOKEN=[redacted]",
    );
    expect(redactText('POINTER_PUSH_SECRET: "xyz-987654321"', secrets)).toBe(
      'POINTER_PUSH_SECRET: "[redacted]"',
    );
  });

  it("replaces the home directory, including JSON-escaped Windows paths", () => {
    expect(
      redactText(`${HOME}/Library/Application Support/HoshiStream`, secrets),
    ).toBe("~/Library/Application Support/HoshiStream");
    const windows = { homeDir: "C:\\Users\\someone" };
    expect(
      redactText(JSON.stringify({ path: "C:\\Users\\someone\\x" }), windows),
    ).toBe('{"path":"~\\\\x"}');
    expect(redactText("C:\\Users\\someone\\x", windows)).toBe("~\\x");
  });
});

describe("redactDiagnostics", () => {
  it("walks nested values and keys", () => {
    const bundle = {
      pointer: {
        manifestUrl: `https://p.example/${ACCESS_TOKEN}/manifest.json`,
      },
      logs: [
        `{"event":"request","authorization":"Bearer ${ACCESS_TOKEN}"}`,
        `magnet:?xt=urn:btih:${"d".repeat(40)}`,
      ],
      [`${HOME}/state`]: { nested: [PUSH_SECRET, 42, null, true] },
    };
    const text = JSON.stringify(redactDiagnostics(bundle, secrets));
    expect(text).not.toContain(ACCESS_TOKEN);
    expect(text).not.toContain(PUSH_SECRET);
    expect(text).not.toContain("magnet:?");
    expect(text).not.toContain(HOME);
    expect(text).toContain('"~/state"');
    expect(text).toContain("42");
  });
});

describe("LogRing and console tap", () => {
  it("keeps the last N lines and restores the console", () => {
    const ring = new LogRing(3);
    const spy = vi
      .spyOn(process.stdout, "write")
      .mockImplementation(() => true);
    const original = console.log;
    const restore = installConsoleTap(ring);
    try {
      for (let i = 0; i < 5; i++) console.log(JSON.stringify({ i }));
      console.warn("plain", { k: 1 });
    } finally {
      restore();
      spy.mockRestore();
    }
    expect(console.log).toBe(original);
    const lines = ring.lines();
    expect(lines).toHaveLength(3);
    expect(lines[0]).toMatch(/Z \{"i":3\}$/);
    expect(lines[2]).toMatch(/Z plain \{"k":1\}$/);
  });
});

describe("GET /api/diagnostics", () => {
  let server: Server | undefined;
  let fake: Server | undefined;
  let root: string | undefined;

  afterEach(async () => {
    for (const s of [server, fake]) {
      if (!s) continue;
      s.closeAllConnections();
      await new Promise<void>((resolve) => s.close(() => resolve()));
    }
    if (root) await rm(root, { recursive: true, force: true });
    server = fake = root = undefined;
  });

  it("assembles a redacted bundle with TorrServer settings and logs", async () => {
    fake = createServer((request, response) => {
      if (request.url === "/echo") return void response.end("MatriX.141");
      if (request.url === "/settings") {
        response.setHeader("content-type", "application/json");
        return void response.end(
          JSON.stringify({
            UploadRateLimit: 512,
            TorznabUrls: [{ Host: "https://idx", Key: "torznab-secret" }],
            TMDBSettings: { APIKey: "tmdb-secret" },
          }),
        );
      }
      response.writeHead(404).end();
    });
    await new Promise<void>((resolve) => fake!.listen(0, "127.0.0.1", resolve));
    const torrServer = new TorrServerClient(
      `http://127.0.0.1:${(fake.address() as AddressInfo).port}`,
      2_000,
      1,
    );
    root = await mkdtemp(join(tmpdir(), "hoshistream-diagnostics-"));
    const library = new Library(join(root, "library.json"));
    await library.create({
      name: "Show",
      type: "series",
      magnetUri: `magnet:?xt=urn:btih:${"e".repeat(40)}`,
    });
    const logs = new LogRing();
    logs.push(
      `{"event":"request","authorization":"Bearer ${ACCESS_TOKEN}","path":"${HOME}/x"}`,
    );
    logs.push(`magnet:?xt=urn:btih:${"f".repeat(40)}&dn=x`);
    server = createServer(
      createHandler({
        library,
        torrServer,
        addon: {
          manifest: { id: "fixture", name: "Fixture" },
          get: async () => ({}),
        },
        nativePicker: new NativePicker(join(root, "missing.sock")),
        accessToken: ACCESS_TOKEN,
        homeSpeedMbps: 100,
        publicUrls: {
          addonUrl: "http://localhost",
          torrServerUrl: "http://localhost",
        },
        diagnostics: { logs, pushSecret: PUSH_SECRET },
      }),
    );
    await new Promise<void>((resolve) =>
      server!.listen(0, "127.0.0.1", resolve),
    );
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    expect((await fetch(`${base}/api/diagnostics`)).status).toBe(401);
    const response = await fetch(`${base}/api/diagnostics`, {
      headers: { authorization: `Bearer ${ACCESS_TOKEN}` },
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toContain("no-store");
    const text = await response.text();
    const bundle = JSON.parse(text);

    // Exit criterion: no token, secret, Authorization value or magnet URI.
    expect(text).not.toContain(ACCESS_TOKEN);
    expect(text).not.toContain(PUSH_SECRET);
    expect(text).not.toContain("magnet:?");
    expect(text).not.toMatch(/Bearer (?!\[redacted\])/);
    expect(text).not.toContain("torznab-secret");
    expect(text).not.toContain("tmdb-secret");

    expect(bundle.app.release).toBeDefined();
    expect(bundle.app.node).toBe(process.version);
    expect(bundle.torrServer).toMatchObject({
      online: true,
      version: "MatriX.141",
      settings: { UploadRateLimit: 512 },
    });
    expect(bundle.library).toMatchObject({ entries: 1, series: 1 });
    expect(bundle.logs).toHaveLength(2);
    expect(bundle.logs[0]).toContain('"authorization":"[redacted]"');
    expect(bundle.logs[1]).toBe("magnet:[redacted]");
    expect(bundle.disk).toEqual({
      volumes: undefined,
      jobs: undefined,
      schedule: null,
    });
  });
});
