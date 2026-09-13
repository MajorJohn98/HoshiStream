import { createServer, type Server } from "node:http";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { markStreamActivity } from "../src/activity.ts";
import { Library } from "../src/library.ts";
import { NativePicker } from "../src/native-picker.ts";
import { createHandler } from "../src/routes.ts";
import type { AddonInterface } from "../src/server-types.ts";
import type {
  TorrentStatus,
  TorrServerClient,
} from "../src/torrserver-client.ts";

const TOKEN = "an-access-token-for-route-tests";

const addon: AddonInterface = {
  manifest: { id: "test", name: "Test" } as AddonInterface["manifest"],
  get: async (resource, type) => ({ resource, type, metas: [] }),
};

let torrents: TorrentStatus[] = [];
const torrServer = {
  health: async () => "1.0",
  list: async () => torrents,
  get: async () => {
    throw new Error("unknown");
  },
  streamUrl: () => "http://torrserver/play",
} as unknown as TorrServerClient;

let server: Server;
let baseUrl: string;
let library: Library;
let libraryPath: string;

beforeEach(async () => {
  torrents = [];
  const directory = await mkdtemp(join(tmpdir(), "hoshistream-routes-"));
  libraryPath = join(directory, "library.json");
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

  it("serves playback telemetry as an uncacheable, token-guarded list", async () => {
    expect((await fetch(`${baseUrl}/api/playback/telemetry`)).status).toBe(401);
    const response = await api("/api/playback/telemetry");
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(await response.json()).toEqual({ streams: [] });
  });

  it("credits a torrent shared by several entries to the one streaming", async () => {
    const hash = "c".repeat(40);
    const stamp = new Date().toISOString();
    const entry = (id: string) => ({
      id,
      type: "series",
      name: id,
      sourceHash: hash,
      magnetUri: `magnet:?xt=urn:btih:${hash}`,
      createdAt: stamp,
      updatedAt: stamp,
      inspectionCache: {
        hash,
        inspectedAt: stamp,
        selectedFiles: [{ id: 0, path: "S01E01.mkv", length: 1000 }],
      },
    });
    await writeFile(
      libraryPath,
      JSON.stringify([entry("hoshi:first"), entry("hoshi:second")]),
    );
    torrents = [
      { title: "shared", hash, stat: 3, stat_string: "Torrent working" },
    ];
    const idle = await (await api("/api/playback")).json();
    expect(idle.sessions).toMatchObject([
      { hash, entryId: "hoshi:first", activity: "idle" },
    ]);
    markStreamActivity(Date.now(), "hoshi:second");
    const streaming = await (await api("/api/playback")).json();
    expect(streaming.sessions).toMatchObject([
      { hash, entryId: "hoshi:second", activity: "streaming" },
    ]);
  });

  it("maps a torrent to an entry through its magnet link before inspection", async () => {
    const hash = "b".repeat(40);
    const extra = "e".repeat(40);
    const stamp = new Date().toISOString();
    await writeFile(
      libraryPath,
      JSON.stringify([
        {
          id: "hoshi:uninspected",
          type: "series",
          name: "Uninspected",
          magnetUri: `magnet:?xt=urn:btih:${hash}`,
          extraSources: [{ magnetUri: `magnet:?xt=urn:btih:${extra}` }],
          createdAt: stamp,
          updatedAt: stamp,
        },
      ]),
    );
    torrents = [
      { title: "main", hash, stat: 3, stat_string: "Torrent working" },
      {
        title: "extra",
        hash: extra.toUpperCase(),
        stat: 3,
        stat_string: "Torrent working",
      },
    ];
    markStreamActivity(Date.now(), "hoshi:uninspected");
    const { sessions } = await (await api("/api/playback")).json();
    expect(sessions).toMatchObject([
      { entryId: "hoshi:uninspected", activity: "streaming" },
      { entryId: "hoshi:uninspected", activity: "streaming" },
    ]);
  });

  it("reports status and falls through to 404 for unknown paths", async () => {
    const status = await api("/api/status");
    expect(status.status).toBe(200);
    expect(await status.json()).toMatchObject({
      status: "online",
      torrServer: { online: true, version: "1.0" },
      libraryCount: 0,
      lineFit: { lineMbps: expect.any(Number), fitMbps: expect.any(Number) },
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

describe("playback position", () => {
  it("stores, returns, and clears the resume point", async () => {
    const created = await api("/api/library", {
      method: "POST",
      body: JSON.stringify({
        type: "series",
        name: "Show",
        magnetUri: "magnet:?xt=urn:btih:show",
      }),
    });
    const { id } = await created.json();
    const put = await api(`/api/library/${encodeURIComponent(id)}/playback`, {
      method: "PUT",
      body: JSON.stringify({ positionSeconds: 754.6, fileId: 3 }),
    });
    expect(put.status).toBe(200);
    expect(await put.json()).toMatchObject({
      positionSeconds: 754,
      fileId: 3,
      source: "browser",
    });
    const entry = await (
      await api(`/api/library/${encodeURIComponent(id)}`)
    ).json();
    expect(entry.playback).toMatchObject({ positionSeconds: 754, fileId: 3 });
    const cleared = await api(
      `/api/library/${encodeURIComponent(id)}/playback`,
      { method: "DELETE" },
    );
    expect(cleared.status).toBe(204);
    const after = await (
      await api(`/api/library/${encodeURIComponent(id)}`)
    ).json();
    expect(after.playback).toBeUndefined();
    expect(
      (
        await api(`/api/library/hoshi%3Anope/playback`, {
          method: "PUT",
          body: JSON.stringify({ positionSeconds: 1 }),
        })
      ).status,
    ).toBe(404);
  });
});
