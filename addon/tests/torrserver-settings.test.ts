import { createServer, type Server } from "node:http";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { markStreamActivity } from "../src/activity.ts";
import { Library } from "../src/library.ts";
import { NativePicker } from "../src/native-picker.ts";
import { createHandler } from "../src/routes.ts";
import { TorrServerClient } from "../src/torrserver-client.ts";
import {
  loadShippedSettings,
  pickTunableSettings,
  SHIPPED_SETTINGS_URL,
  suggestUploadRateLimit,
  tunablePatchSchema,
} from "../src/torrserver-settings.ts";

vi.mock("../src/speedtest.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/speedtest.ts")>();
  return {
    ...actual,
    currentSpeed: vi.fn(() => ({ mbps: 10, source: "configured" as const })),
  };
});
import { currentSpeed } from "../src/speedtest.ts";

const SHIPPED = {
  UploadRateLimit: 128,
  DownloadRateLimit: 0,
  ConnectionsLimit: 100,
  CacheSize: 4294967296,
  ReaderReadAHead: 75,
  TorrentDisconnectTimeout: 600,
};

describe("torrserver-settings helpers", () => {
  it("reads the six tunables from the shipped packaging file", () => {
    expect(loadShippedSettings(SHIPPED_SETTINGS_URL)).toEqual(SHIPPED);
  });

  it("rejects shipped files missing a tunable", async () => {
    const dir = await mkdtemp(join(tmpdir(), "hoshistream-shipped-"));
    const file = join(dir, "settings.json");
    await writeFile(file, JSON.stringify({ BitTorr: { CacheSize: 1 } }));
    expect(() => loadShippedSettings(pathToFileURL(file))).toThrow(
      /UploadRateLimit/,
    );
    await rm(dir, { recursive: true, force: true });
  });

  it("validates the patch ranges and refuses unknown or empty patches", () => {
    expect(tunablePatchSchema.safeParse({}).success).toBe(false);
    expect(tunablePatchSchema.safeParse({ Foo: 1 }).success).toBe(false);
    expect(tunablePatchSchema.safeParse({ ReaderReadAHead: 4 }).success).toBe(
      false,
    );
    expect(tunablePatchSchema.safeParse({ ReaderReadAHead: 101 }).success).toBe(
      false,
    );
    expect(tunablePatchSchema.safeParse({ ConnectionsLimit: 0 }).success).toBe(
      false,
    );
    expect(tunablePatchSchema.safeParse({ UploadRateLimit: 1.5 }).success).toBe(
      false,
    );
    expect(tunablePatchSchema.safeParse({ UploadRateLimit: -1 }).success).toBe(
      false,
    );
    expect(
      tunablePatchSchema.safeParse({ UploadRateLimit: 0, CacheSize: 1 << 30 })
        .success,
    ).toBe(true);
  });

  it("picks only finite numeric tunables", () => {
    expect(
      pickTunableSettings({
        UploadRateLimit: 5,
        CacheSize: undefined,
        ReaderReadAHead: Number.NaN,
      }),
    ).toEqual({ UploadRateLimit: 5 });
  });

  it("suggests ~10 % of a measured line only while upload is still shipped", () => {
    // 100 Mbit/s ≈ 12 207 KiB/s → 10 % ≈ 1 221 → rounded to 1 224.
    expect(
      suggestUploadRateLimit(SHIPPED, SHIPPED, {
        mbps: 100,
        source: "measured",
      }),
    ).toEqual({ UploadRateLimit: 1224 });
    expect(
      suggestUploadRateLimit(SHIPPED, SHIPPED, {
        mbps: 100,
        source: "configured",
      }),
    ).toBeUndefined();
    expect(
      suggestUploadRateLimit({ ...SHIPPED, UploadRateLimit: 500 }, SHIPPED, {
        mbps: 100,
        source: "measured",
      }),
    ).toBeUndefined();
    expect(suggestUploadRateLimit(SHIPPED, SHIPPED, undefined)).toBeUndefined();
    // Slow lines floor at 64 KiB/s rather than suggesting a starving cap.
    expect(
      suggestUploadRateLimit(SHIPPED, SHIPPED, { mbps: 1, source: "measured" }),
    ).toEqual({ UploadRateLimit: 64 });
  });
});

// A fake TorrServer that answers /settings get/set with a full struct,
// including a secret-bearing field the add-on must carry through untouched.
function fakeTorrServer() {
  let sets: Record<string, unknown> = {
    ...SHIPPED,
    TorznabUrls: ["https://indexer.example/api?apikey=secret"],
    TMDBSettings: { APIKey: "tmdb-secret" },
    StoreSettingsInJson: true,
  };
  const calls: Array<{ action: string; sets?: Record<string, unknown> }> = [];
  const server = createServer((request, response) => {
    if (request.url !== "/settings" || request.method !== "POST") {
      response.writeHead(404).end();
      return;
    }
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      const parsed = JSON.parse(Buffer.concat(chunks).toString()) as {
        action: string;
        sets?: Record<string, unknown>;
      };
      calls.push(parsed);
      if (parsed.action === "get") {
        response
          .writeHead(200, { "content-type": "application/json" })
          .end(JSON.stringify(sets));
        return;
      }
      if (parsed.action === "set" && parsed.sets) {
        sets = parsed.sets;
        response.writeHead(200).end();
        return;
      }
      response.writeHead(400).end();
    });
  });
  return { server, calls, current: () => sets };
}

describe("/api/torrserver/settings", () => {
  let servers: Server[] = [];
  let root: string | undefined;
  let base = "";
  let fake: ReturnType<typeof fakeTorrServer>;
  const token = "torrserver-settings-fixture-token";
  const headers = {
    authorization: "Bearer " + token,
    "content-type": "application/json",
  };

  const listen = (server: Server) =>
    new Promise<number>((resolve) => {
      server.listen(0, "127.0.0.1", () => {
        const address = server.address();
        if (!address || typeof address === "string")
          throw new Error("Missing port");
        resolve(address.port);
      });
    });

  beforeEach(async () => {
    markStreamActivity(0);
    vi.mocked(currentSpeed).mockReturnValue({ mbps: 10, source: "configured" });
    root = await realpath(
      await mkdtemp(join(tmpdir(), "hoshistream-ts-settings-")),
    );
    fake = fakeTorrServer();
    const torrPort = await listen(fake.server);
    const library = new Library(join(root, "library.json"));
    const server = createServer(
      createHandler({
        library,
        torrServer: new TorrServerClient(`http://127.0.0.1:${torrPort}`),
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
    const port = await listen(server);
    servers = [fake.server, server];
    base = `http://127.0.0.1:${port}/api/torrserver/settings`;
  });

  afterEach(async () => {
    markStreamActivity(0);
    for (const server of servers) {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    servers = [];
    if (root) await rm(root, { recursive: true, force: true });
    root = undefined;
  });

  it("requires the bearer token", async () => {
    expect((await fetch(base)).status).toBe(401);
  });

  it("reports current and shipped values with an upload suggestion", async () => {
    vi.mocked(currentSpeed).mockReturnValue({ mbps: 100, source: "measured" });
    const response = await fetch(base, { headers });
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toContain("no-store");
    const payload = (await response.json()) as Record<string, unknown>;
    expect(payload.current).toEqual(SHIPPED);
    expect(payload.shipped).toEqual(SHIPPED);
    expect(payload.suggestion).toEqual({ UploadRateLimit: 1224 });
    // Secrets never leave the client's raw read.
    expect(JSON.stringify(payload)).not.toContain("secret");
  });

  it("writes the full struct back with edits merged, keeping unknown fields", async () => {
    const response = await fetch(base, {
      method: "PUT",
      headers,
      body: JSON.stringify({ UploadRateLimit: 512, ReaderReadAHead: 60 }),
    });
    expect(response.status).toBe(200);
    const payload = (await response.json()) as { current: typeof SHIPPED };
    expect(payload.current).toEqual({
      ...SHIPPED,
      UploadRateLimit: 512,
      ReaderReadAHead: 60,
    });
    expect(JSON.stringify(payload)).not.toContain("secret");
    const set = fake.calls.find((call) => call.action === "set");
    expect(set?.sets).toMatchObject({
      UploadRateLimit: 512,
      ReaderReadAHead: 60,
      ConnectionsLimit: 100,
      TorznabUrls: ["https://indexer.example/api?apikey=secret"],
      TMDBSettings: { APIKey: "tmdb-secret" },
      StoreSettingsInJson: true,
    });
    // Exit criterion: a follow-up `get` reflects the change.
    expect(fake.current().UploadRateLimit).toBe(512);
    const after = (await (await fetch(base, { headers })).json()) as {
      current: typeof SHIPPED;
      suggestion: unknown;
    };
    expect(after.current.UploadRateLimit).toBe(512);
    expect(after.suggestion).toBeNull();
  });

  it("refuses to apply while a stream is active", async () => {
    markStreamActivity();
    const response = await fetch(base, {
      method: "PUT",
      headers,
      body: JSON.stringify({ UploadRateLimit: 1 }),
    });
    expect(response.status).toBe(409);
    expect((await response.json()).code).toBe("streaming_active");
    expect(fake.calls.some((call) => call.action === "set")).toBe(false);
    expect(
      (await fetch(`${base}/reset`, { method: "POST", headers })).status,
    ).toBe(409);
  });

  it("rejects invalid bodies before talking to TorrServer", async () => {
    for (const body of [
      "{}",
      '{"ReaderReadAHead":1}',
      '{"Bogus":1}',
      "not json",
    ]) {
      const response = await fetch(base, { method: "PUT", headers, body });
      expect(response.status).toBe(400);
      expect((await response.json()).code).toBe("invalid_body");
    }
    expect(fake.calls).toHaveLength(0);
  });

  it("resets the six shipped values and nothing else", async () => {
    await fetch(base, {
      method: "PUT",
      headers,
      body: JSON.stringify({ UploadRateLimit: 999, CacheSize: 64 << 20 }),
    });
    const response = await fetch(`${base}/reset`, {
      method: "POST",
      headers,
    });
    expect(response.status).toBe(200);
    expect(((await response.json()) as { current: unknown }).current).toEqual(
      SHIPPED,
    );
    expect(fake.current()).toMatchObject({
      ...SHIPPED,
      TMDBSettings: { APIKey: "tmdb-secret" },
    });
  });

  it("maps TorrServer failures to 503", async () => {
    fake.server.closeAllConnections();
    await new Promise<void>((resolve) => fake.server.close(() => resolve()));
    servers = servers.filter((server) => server !== fake.server);
    const response = await fetch(base, { headers });
    expect(response.status).toBe(503);
    expect((await response.json()).code).toBe("torrserver_unavailable");
  });
});
