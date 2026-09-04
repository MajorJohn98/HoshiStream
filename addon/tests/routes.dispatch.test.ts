import { createServer, type Server } from "node:http";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Library } from "../src/library.ts";
import { NativePicker } from "../src/native-picker.ts";
import { createHandler } from "../src/routes.ts";
import type { AddonInterface } from "../src/server-types.ts";
import type { TorrServerClient } from "../src/torrserver-client.ts";

const TOKEN = "an-access-token-for-route-tests";

const addon: AddonInterface = {
  manifest: { id: "test", name: "Test" } as AddonInterface["manifest"],
  get: async (resource, type) => ({ resource, type, metas: [] }),
};

const torrServer = {
  health: async () => "1.0",
  list: async () => [],
  get: async () => {
    throw new Error("unknown");
  },
  streamUrl: () => "http://torrserver/play",
} as unknown as TorrServerClient;

let server: Server;
let baseUrl: string;
let library: Library;

beforeEach(async () => {
  const directory = await mkdtemp(join(tmpdir(), "hoshistream-routes-"));
  const libraryPath = join(directory, "library.json");
  await writeFile(libraryPath, "[]\n");
  library = new Library(libraryPath);
  server = createServer(
    createHandler({
      library,
      addon,
      torrServer,
      accessToken: TOKEN,
      homeSpeedMbps: 100,
      nativePicker: new NativePicker(join(directory, "missing.sock")),
      publicUrls: {
        addonUrl: "http://addon.test",
        torrServerUrl: "http://torrserver.test",
      },
      lanRedirect: "off",
    }),
  );
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("no port");
  baseUrl = `http://127.0.0.1:${address.port}`;
});

afterEach(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

function api(path: string, init: RequestInit = {}) {
  return fetch(`${baseUrl}${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${TOKEN}`,
      "content-type": "application/json",
      ...(init.headers ?? {}),
    },
  });
}

describe("createHandler dispatch", () => {
  it("serves health without a token", async () => {
    const response = await fetch(`${baseUrl}/health`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "ok" });
  });

  it("rejects the untokenized manifest and serves the tokenized one", async () => {
    expect((await fetch(`${baseUrl}/manifest.json`)).status).toBe(401);
    const tokenized = await fetch(`${baseUrl}/addon/${TOKEN}/manifest.json`);
    expect(tokenized.status).toBe(200);
    expect(tokenized.headers.get("cache-control")).toContain("no-store");
    expect(await tokenized.json()).toMatchObject({ id: "test" });
  });

  it("proxies catalog requests to the add-on interface", async () => {
    const response = await fetch(
      `${baseUrl}/addon/${TOKEN}/catalog/movie/private-movies.json`,
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      resource: "catalog",
      type: "movie",
    });
  });

  it("requires a bearer token for the management API", async () => {
    expect((await fetch(`${baseUrl}/api/library`)).status).toBe(401);
    const wrong = await fetch(`${baseUrl}/api/library`, {
      headers: { authorization: "Bearer nope" },
    });
    expect(wrong.status).toBe(401);
  });

  it("creates, reads, patches, and deletes library entries", async () => {
    const created = await api("/api/library", {
      method: "POST",
      body: JSON.stringify({
        type: "movie",
        name: "Route test",
        magnetUri: "magnet:?xt=urn:btih:routes",
      }),
    });
    expect(created.status).toBe(201);
    const entry = (await created.json()) as { id: string };

    const listed = await api("/api/library");
    expect(await listed.json()).toHaveLength(1);

    const item = await api(`/api/library/${encodeURIComponent(entry.id)}`);
    expect(item.status).toBe(200);

    const patched = await api(`/api/library/${encodeURIComponent(entry.id)}`, {
      method: "PATCH",
      body: JSON.stringify({ name: "Renamed" }),
    });
    expect(await patched.json()).toMatchObject({ name: "Renamed" });

    const removed = await api(`/api/library/${encodeURIComponent(entry.id)}`, {
      method: "DELETE",
    });
    expect(removed.status).toBe(204);
    expect(
      (await api(`/api/library/${encodeURIComponent(entry.id)}`)).status,
    ).toBe(404);
  });

  it("maps validation failures to a generic 400", async () => {
    const response = await api("/api/library", {
      method: "POST",
      body: JSON.stringify({ type: "movie", name: "No source" }),
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "Invalid request" });
    const malformed = await api("/api/library", {
      method: "POST",
      body: "{not json",
    });
    expect(malformed.status).toBe(400);
  });

  it("answers 409 for optional features that are not configured", async () => {
    expect((await api("/api/volumes")).status).toBe(409);
    expect((await api("/api/disk-jobs")).status).toBe(409);
    expect((await api("/api/disk-schedule")).status).toBe(409);
    expect((await api("/api/analysis")).status).toBe(409);
    expect((await api("/api/pointer/remote")).status).toBe(409);
    expect(await (await api("/api/pointer/status")).json()).toEqual({
      configured: false,
    });
  });

  it("reports status and falls through to 404 for unknown paths", async () => {
    const status = await api("/api/status");
    expect(status.status).toBe(200);
    expect(await status.json()).toMatchObject({
      status: "online",
      torrServer: { online: true, version: "1.0" },
      libraryCount: 0,
    });
    expect((await api("/api/nothing-here")).status).toBe(404);
    expect((await fetch(`${baseUrl}/nothing-here`)).status).toBe(404);
    expect((await fetch(`${baseUrl}/manage/wrong-token`)).status).toBe(404);
  });

  it("serves the management page only with the right token", async () => {
    const page = await fetch(`${baseUrl}/manage/${TOKEN}`);
    expect(page.status).toBe(200);
    expect(page.headers.get("content-type")).toContain("text/html");
    expect(page.headers.get("content-security-policy")).toContain(
      "default-src 'self'",
    );
    const asset = await fetch(`${baseUrl}/manage-assets/app.js`);
    expect(asset.status).toBe(200);
    expect(asset.headers.get("content-type")).toContain("text/javascript");
    expect((await fetch(`${baseUrl}/manage-assets/missing.js`)).status).toBe(
      404,
    );
  });
});

describe("management assets", () => {
  it("revalidate with an ETag instead of caching for minutes", async () => {
    const first = await fetch(`${baseUrl}/manage-assets/app.js`);
    expect(first.status).toBe(200);
    expect(first.headers.get("cache-control")).toBe("no-cache");
    const etag = first.headers.get("etag");
    expect(etag).toMatch(/^".+"$/);
    const again = await fetch(`${baseUrl}/manage-assets/app.js`, {
      headers: { "if-none-match": etag! },
    });
    expect(again.status).toBe(304);
  });
});
