import { createServer, type Server } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Library } from "../src/library.ts";
import { SourceChecks } from "../src/source-checks.ts";
import { TorrServerClient } from "../src/torrserver-client.ts";
import { NativePicker } from "../src/native-picker.ts";
import { createHandler } from "../src/routes.ts";

let server: Server | undefined;
let checks: SourceChecks | undefined;
let root: string | undefined;
const token = "source-check-api-fixture-token";

afterEach(async () => {
  if (server) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server!.close(() => resolve()));
  }
  await checks?.close();
  if (root) await rm(root, { recursive: true });
  server = undefined;
  checks = undefined;
  root = undefined;
});

describe("source check API", () => {
  it("authenticates, starts a check and exposes a persisted result without source URLs", async () => {
    root = await mkdtemp(join(tmpdir(), "hoshi-check-api-"));
    const library = new Library(join(root, "library.json"));
    const entry = await library.create({
      name: "Authorized fixture",
      type: "movie",
      magnetUri: "magnet:?xt=urn:btih:" + "a".repeat(40),
    });
    const torrServer = new TorrServerClient("http://127.0.0.1:1");
    const file = { id: 1, path: "fixture.mp4", length: 100 };
    checks = new SourceChecks(library, torrServer, {
      inspect: vi.fn().mockResolvedValue({
        hash: "a".repeat(40),
        name: "Fixture",
        files: [file],
        selectedFiles: [file],
      }),
      probe: vi.fn().mockResolvedValue({
        sizeBytes: 100,
        container: "mov",
        videoCodec: "h264",
        audioCodec: "aac",
      }),
    });
    server = createServer(
      createHandler({
        library,
        sourceChecks: checks,
        torrServer,
        addon: {
          manifest: { id: "fixture", name: "Fixture" },
          get: async () => ({}),
        },
        nativePicker: new NativePicker(join(root, "missing.sock")),
        accessToken: token,
        homeSpeedMbps: 100,
        publicUrls: {
          addonUrl: "http://localhost",
          torrServerUrl: "http://localhost",
        },
      }),
    );
    await new Promise<void>((resolve) =>
      server!.listen(0, "127.0.0.1", resolve),
    );
    const address = server.address();
    if (!address || typeof address === "string")
      throw new Error("Missing port");
    const url = `http://127.0.0.1:${address.port}/api/library/${encodeURIComponent(entry.id)}/check`;
    expect((await fetch(url)).status).toBe(401);
    const headers = {
      authorization: "Bearer " + token,
      "content-type": "application/json",
    };
    const invalid = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify({ probe: "yes" }),
    });
    expect(invalid.status).toBe(400);
    const started = await fetch(url, { method: "POST", headers, body: "{}" });
    expect(started.status).toBe(202);
    expect(started.headers.get("cache-control")).toContain("no-store");
    await vi.waitFor(async () => {
      const report = await (await fetch(url, { headers })).json();
      expect(report.phase).toBe("complete");
      expect(report.browserSupport).toBe("likely");
      expect(JSON.stringify(report)).not.toContain("magnet:");
    });
    expect((await library.get(entry.id))?.sourceCheck?.phase).toBe("complete");
    expect((await fetch(url, { method: "DELETE", headers })).status).toBe(200);
    expect((await checks.get(entry.id)).phase).toBe("complete");
  });
});
