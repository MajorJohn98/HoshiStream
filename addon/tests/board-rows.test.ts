import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getCatalog } from "../src/catalog.ts";
import { IdentityStore } from "../src/identity.ts";
import { Library } from "../src/library.ts";
import {
  manifest,
  manifestForLibrary,
  RECENTLY_ADDED_ID,
  tagCatalogId,
  UNWATCHED_ID,
} from "../src/manifest.ts";
import { getMetadata } from "../src/metadata.ts";
import { NativePicker } from "../src/native-picker.ts";
import { createHandler } from "../src/routes.ts";
import type { AddonInterface } from "../src/server-types.ts";
import { PINNED_TAGS_MAX, Tags } from "../src/tags.ts";
import type { TorrServerClient } from "../src/torrserver-client.ts";

let stateDir: string;
beforeEach(async () => {
  stateDir = await mkdtemp(join(tmpdir(), "hoshi-board-"));
});
afterEach(async () => {
  await rm(stateDir, { recursive: true, force: true });
});

describe("manifestForLibrary", () => {
  it("adds Board rows per type, pinned tags in pin order, and identity", () => {
    const served = manifestForLibrary(
      manifest,
      ["Action", "Anime"],
      ["Anime", "Action"],
      { addonUrl: "https://addon.test", contactEmail: " me@example.com " },
    );
    const ids = (type: string) =>
      served.catalogs
        .filter((catalog) => catalog.type === type)
        .map((catalog) => catalog.id);
    expect(ids("movie")).toEqual([
      "private-movies",
      "continue-watching",
      RECENTLY_ADDED_ID,
      UNWATCHED_ID,
      "tag-anime",
      "tag-action",
    ]);
    expect(ids("series")).toEqual([
      "private-series",
      "continue-watching",
      RECENTLY_ADDED_ID,
      UNWATCHED_ID,
      "tag-anime",
      "tag-action",
    ]);
    const anime = served.catalogs.find((c) => c.id === "tag-anime");
    expect(anime?.name).toBe("Anime");
    expect(anime?.extra.map((extra) => extra.name)).toEqual(["skip"]);
    // Genre options still fill the picker catalogs.
    expect(
      served.catalogs[0].extra.find((extra) => extra.name === "genre"),
    ).toMatchObject({ options: ["Action", "Anime"] });
    expect(served.logo).toBe("https://addon.test/assets/hoshistream-logo.png");
    expect(served.contactEmail).toBe("me@example.com");
  });

  it("omits identity fields when unset and keeps the base untouched", () => {
    const served = manifestForLibrary(manifest, [], []);
    expect(served).not.toHaveProperty("logo");
    expect(served).not.toHaveProperty("contactEmail");
    expect(served.catalogs.map((c) => c.id)).toEqual([
      "private-movies",
      "continue-watching",
      RECENTLY_ADDED_ID,
      UNWATCHED_ID,
      "private-series",
      "continue-watching",
      RECENTLY_ADDED_ID,
      UNWATCHED_ID,
    ]);
    expect(manifest.catalogs).toHaveLength(4);
  });

  it("keys tag catalogs case-insensitively", () => {
    expect(tagCatalogId("game show")).toBe("tag-game show");
  });
});

describe("Board catalogs", () => {
  const day = (n: number) =>
    `2026-01-${String(n).padStart(2, "0")}T00:00:00.000Z`;
  const entries = [
    {
      id: "hoshi:a",
      type: "movie" as const,
      name: "Old but edited",
      magnetUri: "magnet:?xt=urn:btih:a",
      createdAt: day(1),
      updatedAt: day(9),
      tags: ["Anime"],
    },
    {
      id: "hoshi:b",
      type: "movie" as const,
      name: "Newest",
      magnetUri: "magnet:?xt=urn:btih:b",
      createdAt: day(5),
      updatedAt: day(5),
      watchStates: [{ fileId: 1, state: "started" as const, at: day(6) }],
    },
    {
      id: "hoshi:c",
      type: "movie" as const,
      name: "Middle",
      magnetUri: "magnet:?xt=urn:btih:c",
      createdAt: day(3),
      updatedAt: day(3),
      tags: ["anime", "Drama"],
    },
    {
      id: "hoshi:d",
      type: "series" as const,
      name: "A show",
      magnetUri: "magnet:?xt=urn:btih:d",
      createdAt: day(8),
      updatedAt: day(8),
      tags: ["Anime"],
    },
  ];
  const library = { list: async () => entries } as never;
  const ids = (result: { metas: { id: string }[] }) =>
    result.metas.map((meta) => meta.id);

  it("Recently added orders by creation, not by edits", async () => {
    expect(
      ids(await getCatalog(library, "movie", {}, RECENTLY_ADDED_ID)),
    ).toEqual(["hoshi:b", "hoshi:c", "hoshi:a"]);
    expect(ids(await getCatalog(library, "movie", {}))).toEqual([
      "hoshi:a",
      "hoshi:b",
      "hoshi:c",
    ]);
  });

  it("Unwatched drops anything with watch history", async () => {
    expect(ids(await getCatalog(library, "movie", {}, UNWATCHED_ID))).toEqual([
      "hoshi:a",
      "hoshi:c",
    ]);
    expect(
      ids(await getCatalog(library, "movie", { skip: "1" }, UNWATCHED_ID)),
    ).toEqual(["hoshi:c"]);
  });

  it("tag rows filter by the pinned tag per type, ignoring genre and search", async () => {
    expect(
      ids(
        await getCatalog(
          library,
          "movie",
          { genre: "Drama" },
          tagCatalogId("anime"),
        ),
      ),
    ).toEqual(["hoshi:a", "hoshi:c"]);
    expect(
      ids(await getCatalog(library, "series", {}, tagCatalogId("anime"))),
    ).toEqual(["hoshi:d"]);
    expect(
      ids(await getCatalog(library, "movie", {}, tagCatalogId("western"))),
    ).toEqual([]);
  });
});

describe("Tags pinning", () => {
  it("pins in order, caps at the limit, and cascades rename and delete", async () => {
    const path = join(stateDir, "tags.json");
    const names = Array.from(
      { length: PINNED_TAGS_MAX + 1 },
      (_, i) => `T${i}`,
    );
    await writeFile(path, JSON.stringify({ tags: names }));
    const tags = new Tags(path);
    expect(await tags.pinned()).toEqual([]);
    expect(await tags.setPinned("t1", true)).toBe("T1");
    await tags.setPinned("T0", true);
    expect(await tags.pinned()).toEqual(["T1", "T0"]);
    // Re-pinning is a no-op, not a duplicate.
    await tags.setPinned("T1", true);
    expect(await tags.pinned()).toEqual(["T1", "T0"]);
    for (const name of names.slice(2, PINNED_TAGS_MAX))
      await tags.setPinned(name, true);
    await expect(tags.setPinned(names[PINNED_TAGS_MAX], true)).rejects.toThrow(
      /Up to 8 tags/,
    );
    await expect(tags.setPinned("Nope", true)).rejects.toThrow(/not found/);
    await tags.rename("T1", "Renamed");
    await tags.remove("T0");
    const pinned = await tags.pinned();
    expect(pinned[0]).toBe("Renamed");
    expect(pinned).not.toContain("T0");
    expect(pinned).toHaveLength(PINNED_TAGS_MAX - 1);
    // Persisted and reloaded; pins that no longer exist are dropped.
    expect(JSON.parse(await readFile(path, "utf8")).pinned).toEqual(pinned);
    await writeFile(
      path,
      JSON.stringify({ tags: ["Action"], pinned: ["action", "Ghost"] }),
    );
    expect(await new Tags(path).pinned()).toEqual(["Action"]);
    await tags.setPinned("Renamed", false);
    expect(await tags.pinned()).not.toContain("Renamed");
  });
});

describe("IdentityStore", () => {
  it("defaults to an empty address, validates, and persists", async () => {
    const store = new IdentityStore(join(stateDir, "identity.json"));
    expect(await store.read()).toEqual({ contactEmail: "" });
    await expect(store.update({ contactEmail: "nope" })).rejects.toThrow();
    expect(await store.update({ contactEmail: " me@example.com " })).toEqual({
      contactEmail: "me@example.com",
    });
    expect(
      await new IdentityStore(join(stateDir, "identity.json")).read(),
    ).toEqual({ contactEmail: "me@example.com" });
    expect(await store.update({ contactEmail: "" })).toEqual({
      contactEmail: "",
    });
  });
});

describe("Board routes", () => {
  const TOKEN = "an-access-token-for-board-tests";
  const addon: AddonInterface = {
    manifest,
    get: async (resource, type) => ({ resource, type, metas: [] }),
  };
  const torrServer = {
    health: async () => "1.0",
    list: async () => [],
  } as unknown as TorrServerClient;
  let server: Server;
  let baseUrl: string;

  beforeEach(async () => {
    const tagsPath = join(stateDir, "tags.json");
    await writeFile(tagsPath, JSON.stringify({ tags: ["Action", "Drama"] }));
    server = createServer(
      createHandler({
        library: new Library(join(stateDir, "library.json")),
        addon,
        torrServer,
        accessToken: TOKEN,
        homeSpeedMbps: 100,
        nativePicker: new NativePicker(join(stateDir, "missing.sock")),
        publicUrls: {
          addonUrl: "http://addon.test",
          torrServerUrl: "http://torrserver.test",
        },
        lanRedirect: "off",
        tags: new Tags(tagsPath),
        identity: new IdentityStore(join(stateDir, "identity.json")),
      }),
    );
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("no port");
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  afterEach(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  const api = (path: string, init: RequestInit = {}) =>
    fetch(`${baseUrl}${path}`, {
      ...init,
      headers: {
        authorization: `Bearer ${TOKEN}`,
        "content-type": "application/json",
        ...(init.headers ?? {}),
      },
    });

  it("pins tags through PATCH and advertises them in the served manifest", async () => {
    const pin = await api("/api/tags/drama", {
      method: "PATCH",
      body: JSON.stringify({ pinned: true }),
    });
    expect(pin.status).toBe(200);
    expect(await pin.json()).toEqual({
      name: "Drama",
      pinned: true,
      pinnedTags: ["Drama"],
    });
    const list = await (await api("/api/tags")).json();
    expect(list.pinned).toEqual(["Drama"]);
    expect(list.pinnedLimit).toBe(PINNED_TAGS_MAX);
    expect(list.tags).toEqual([
      { name: "Action", count: 0, pinned: false },
      { name: "Drama", count: 0, pinned: true },
    ]);
    await api("/api/identity", {
      method: "PUT",
      body: JSON.stringify({ contactEmail: "me@example.com" }),
    });
    const served = await (
      await fetch(`${baseUrl}/addon/${TOKEN}/manifest.json`)
    ).json();
    expect(
      served.catalogs.filter((c: { id: string }) => c.id === "tag-drama"),
    ).toHaveLength(2);
    // The logo points at the origin the client used, not the configured one.
    expect(served.logo).toBe(`${baseUrl}/assets/hoshistream-logo.png`);
    expect(served.contactEmail).toBe("me@example.com");
    const unpin = await api("/api/tags/Drama", {
      method: "PATCH",
      body: JSON.stringify({ pinned: false }),
    });
    expect((await unpin.json()).pinnedTags).toEqual([]);
  });

  it("validates identity updates", async () => {
    expect((await api("/api/identity")).status).toBe(200);
    const bad = await api("/api/identity", {
      method: "PUT",
      body: JSON.stringify({ contactEmail: "not-an-address" }),
    });
    expect(bad.status).toBe(400);
    expect((await bad.json()).code).toBe("invalid_body");
    expect((await fetch(`${baseUrl}/api/identity`)).status).toBe(401);
  });
});

describe("embedded episode streams", () => {
  const directories: string[] = [];
  afterEach(async () => {
    await Promise.all(
      directories
        .splice(0)
        .map((directory) => rm(directory, { recursive: true, force: true })),
    );
  });
  const status = {
    title: "Show",
    hash: "abc123",
    stat: 1,
    stat_string: "Torrent working",
    file_stats: [
      { id: 1, path: "Show/S01E01.mkv", length: 100 },
      { id: 2, path: "Show/S01E02.mkv", length: 100 },
    ],
  };
  const fakeTorrServer = () =>
    ({
      addMagnet: vi.fn().mockResolvedValue(status),
      waitForFiles: vi.fn().mockResolvedValue(status),
      get: vi.fn().mockResolvedValue(status),
      streamUrl: (hash: string, file: { id: number }) =>
        `http://127.0.0.1:8090/play/${hash}/${file.id}`,
    }) as unknown as TorrServerClient;
  const embed = (torrServer: TorrServerClient) => ({
    torrServer,
    publicTorrServerUrl: "https://ts.example",
    publicAddonUrl: "https://addon.example",
    accessToken: "token",
  });

  it("embeds streams only once the inspection is cached", async () => {
    const directory = resolve(`.test-board-data-${randomUUID()}`);
    directories.push(directory);
    await mkdir(directory);
    const library = new Library(join(directory, "library.json"));
    const entry = await library.create({
      type: "series",
      name: "Show",
      magnetUri: "magnet:?xt=urn:btih:show",
    });
    const torrServer = fakeTorrServer();
    // First meta call: no cache yet, so videos carry no streams even though
    // embedding was requested (the inspection itself just ran).
    const fresh = await getMetadata(
      library,
      torrServer,
      "series",
      entry.id,
      embed(torrServer),
    );
    expect(fresh.meta?.videos).toHaveLength(2);
    expect(fresh.meta?.videos?.[0]).not.toHaveProperty("streams");
    // Second call: cached, so each episode carries its stream list.
    const cached = await getMetadata(
      library,
      torrServer,
      "series",
      entry.id,
      embed(torrServer),
    );
    const videos = cached.meta?.videos ?? [];
    expect(videos).toHaveLength(2);
    for (const video of videos) {
      expect(video.streams).toHaveLength(1);
      expect(video.streams?.[0].url).toBe(
        `https://ts.example:8090/play/abc123/${video.episode}`,
      );
      expect(video.streams?.[0].name).toBe("HoshiStream");
    }
    // Without embed options the meta stays lean.
    const plain = await getMetadata(library, torrServer, "series", entry.id);
    expect(plain.meta?.videos?.[0]).not.toHaveProperty("streams");
  });

  it("never embeds for local series", async () => {
    const directory = resolve(`.test-board-data-${randomUUID()}`);
    directories.push(directory);
    await mkdir(directory, { recursive: true });
    const library = new Library(join(directory, "library.json"));
    const folder = join(directory, "Local Show");
    await mkdir(folder);
    await writeFile(join(folder, "S01E01.mkv"), "x");
    const entry = await library.create({
      type: "series",
      name: "Local Show",
      localFolderPath: folder,
    });
    const torrServer = fakeTorrServer();
    const meta = await getMetadata(
      library,
      torrServer,
      "series",
      entry.id,
      embed(torrServer),
    );
    expect(meta.meta?.videos?.length ?? 0).toBeGreaterThan(0);
    expect(meta.meta?.videos?.[0]).not.toHaveProperty("streams");
    expect(torrServer.get).not.toHaveBeenCalled();
  });
});
