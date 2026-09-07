import { createServer, type Server } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Library } from "../src/library.ts";
import { SourceChecks } from "../src/source-checks.ts";
import { TorrServerClient, TorrServerError } from "../src/torrserver-client.ts";
import { NativePicker } from "../src/native-picker.ts";
import { createHandler } from "../src/routes.ts";
import { MediaProbeError } from "../src/media-probe.ts";
import { defaultAnalyzer, LibraryAnalysis } from "../src/library-analysis.ts";

let server: Server | undefined;
let checks: SourceChecks | undefined;
let root: string | undefined;
const token = "source-check-api-fixture-token";
const headers = {
  authorization: "Bearer " + token,
  "content-type": "application/json",
};
const technical = {
  sizeBytes: 100,
  container: "mov",
  videoCodec: "h264",
  audioCodec: "aac",
  videoProfile: "Main",
  pixelFormat: "yuv420p",
  decodedVideoFrames: 1,
};

async function fixture() {
  root = await mkdtemp(join(process.cwd(), ".test-check-adapters-"));
  const library = new Library(join(root, "library.json"));
  const entry = await library.create({
    name: "Authorized fixture",
    type: "movie",
    magnetUri: `magnet:?xt=urn:btih:${"a".repeat(40)}`,
  });
  const torrServer = new TorrServerClient("http://127.0.0.1:1");
  const file = { id: 1, path: "fixture.mp4", length: 100 };
  const status = {
    hash: "a".repeat(40),
    title: "Fixture",
    stat: 1,
    stat_string: "Ready",
    file_stats: [file],
  };
  vi.spyOn(torrServer, "addMagnet").mockResolvedValue(status);
  vi.spyOn(torrServer, "waitForFiles").mockResolvedValue(status);
  const inspect = vi.fn().mockResolvedValue({
    hash: status.hash,
    name: "Fixture",
    files: [file],
    selectedFiles: [file],
  });
  const probe = vi.fn().mockResolvedValue(technical);
  checks = new SourceChecks(library, torrServer, { inspect, probe });
  const analysis = new LibraryAnalysis(library, defaultAnalyzer(checks));
  server = createServer(
    createHandler({
      library,
      torrServer,
      sourceChecks: checks,
      analysis,
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
  await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing port");
  const base = `http://127.0.0.1:${address.port}`;
  return {
    library,
    entry,
    checks,
    analysis,
    torrServer,
    inspect,
    probe,
    base,
    item: `${base}/api/library/${encodeURIComponent(entry.id)}`,
  };
}

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
  vi.restoreAllMocks();
});

describe("source check API", () => {
  it("validates explicit extended mode and keeps the default basic", async () => {
    const { item, checks, entry } = await fixture();
    for (const mode of ["automatic", 180, null]) {
      expect(
        (
          await fetch(`${item}/check`, {
            method: "POST",
            headers,
            body: JSON.stringify({ mode }),
          })
        ).status,
      ).toBe(400);
    }
    const basic = await fetch(`${item}/check`, {
      method: "POST",
      headers,
      body: "{}",
    });
    expect((await basic.json()).mode).toBe("basic");
    await vi.waitFor(async () =>
      expect((await checks.get(entry.id)).phase).toBe("complete"),
    );
    const extended = await fetch(`${item}/check`, {
      method: "POST",
      headers,
      body: JSON.stringify({ mode: "extended" }),
    });
    expect(extended.status).toBe(202);
    expect((await extended.json()).mode).toBe("extended");
  });

  it("adapts legacy technical inspection to the same in-flight check", async () => {
    const { item, checks, entry, probe, inspect } = await fixture();
    let finish!: () => void;
    probe.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = () => resolve(technical);
        }),
    );
    const checkAdapter = vi.spyOn(checks, "check");
    try {
      expect(
        (await fetch(`${item}/check`, { method: "POST", headers, body: "{}" }))
          .status,
      ).toBe(202);
      await vi.waitFor(() => expect(probe).toHaveBeenCalledOnce());
      const legacy = fetch(`${item}/inspect?probe=true`, {
        method: "POST",
        headers,
      });
      await vi.waitFor(() => expect(checkAdapter).toHaveBeenCalledOnce());
      finish();
      const response = await legacy;
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({
        hash: "a".repeat(40),
        files: [{ id: 1 }],
        selectedFiles: [{ id: 1 }],
        technical: { decodedVideoFrames: 1 },
        directPlay: { compatibility: "direct" },
        sourceCheck: { outcome: "observed", mode: "basic" },
      });
      expect(probe).toHaveBeenCalledOnce();
      expect(inspect).toHaveBeenCalledOnce();
      expect((await checks.get(entry.id)).phase).toBe("complete");
    } finally {
      finish?.();
    }
  });

  it("leaves plain inspection metadata-only", async () => {
    const { item, probe, inspect, torrServer } = await fixture();
    const response = await fetch(`${item}/inspect`, {
      method: "POST",
      headers,
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      files: [{ id: 1 }],
      selectedFiles: [{ id: 1 }],
    });
    expect(probe).not.toHaveBeenCalled();
    expect(inspect).not.toHaveBeenCalled();
    expect(torrServer.waitForFiles).toHaveBeenCalledOnce();
  });

  it.each([
    ["unavailable", 503],
    ["metadata_timeout", 504],
    ["not_found", 404],
  ])(
    "keeps legacy metadata failures as HTTP errors (%s)",
    async (code, status) => {
      const { item, inspect, probe } = await fixture();
      inspect.mockRejectedValue(
        new TorrServerError("Metadata unavailable", String(code)),
      );
      const response = await fetch(`${item}/inspect?probe=true`, {
        method: "POST",
        headers,
      });
      expect(response.status).toBe(status);
      const result = await response.json();
      expect(result.error).toBeTruthy();
      expect(result.files).toBeUndefined();
      expect(result.sourceCheck.code).toBe(code);
      expect(probe).not.toHaveBeenCalled();
    },
  );

  it("preserves the legacy technical-error response while reporting inconclusive", async () => {
    const { item, probe, library, entry } = await fixture();
    probe.mockRejectedValue(new MediaProbeError("Timeout", "probe_timeout"));
    const response = await fetch(`${item}/inspect?probe=true`, {
      method: "POST",
      headers,
    });
    expect(response.status).toBe(200);
    const result = await response.json();
    expect(result).toMatchObject({
      files: [{ id: 1 }],
      technical: { error: expect.any(String) },
      sourceCheck: {
        phase: "complete",
        outcome: "inconclusive",
        code: "probe_timeout",
      },
    });
    expect(result.directPlay).toBeUndefined();
    expect((await library.get(entry.id))?.mediaFacts).toBeUndefined();
  });

  it("rejects caller-owned media facts on create and patch", async () => {
    const { item, base } = await fixture();
    expect(
      (
        await fetch(item, {
          method: "PATCH",
          headers,
          body: JSON.stringify({ mediaFacts: [] }),
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await fetch(`${base}/api/library`, {
          method: "POST",
          headers,
          body: JSON.stringify({
            name: "Injected",
            type: "movie",
            magnetUri: `magnet:?xt=urn:btih:${"b".repeat(40)}`,
            mediaFacts: [],
          }),
        })
      ).status,
    ).toBe(400);
  });

  it("awaits Analysis cancellation before accepting an immediate restart", async () => {
    const { base, probe, analysis } = await fixture();
    let finish!: () => void;
    probe.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = () => resolve(technical);
        }),
    );
    try {
      expect(
        (
          await fetch(`${base}/api/analysis`, {
            method: "POST",
            headers,
            body: "{}",
          })
        ).status,
      ).toBe(200);
      await vi.waitFor(() => expect(probe).toHaveBeenCalledOnce());
      const cancelled = fetch(`${base}/api/analysis`, {
        method: "DELETE",
        headers,
      });
      await vi.waitFor(() => expect(analysis.status().cancelled).toBe(true));
      expect(
        (
          await fetch(`${base}/api/analysis`, {
            method: "POST",
            headers,
            body: "{}",
          })
        ).status,
      ).toBe(409);
      finish();
      expect((await cancelled).status).toBe(200);
      expect(analysis.status().running).toBe(false);
      expect(
        (
          await fetch(`${base}/api/analysis`, {
            method: "POST",
            headers,
            body: JSON.stringify({ force: true }),
          })
        ).status,
      ).toBe(200);
      await vi.waitFor(() => expect(analysis.status().running).toBe(false));
      expect(probe).toHaveBeenCalledTimes(2);
    } finally {
      finish?.();
      await analysis.cancel();
    }
  });

  it("authenticates, starts a check and exposes a persisted result without source URLs", async () => {
    root = await mkdtemp(join(process.cwd(), ".test-hoshi-check-api-"));
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
        videoProfile: "Main",
        pixelFormat: "yuv420p",
        decodedVideoFrames: 1,
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
