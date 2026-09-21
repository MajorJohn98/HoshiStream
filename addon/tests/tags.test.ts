import { createServer, type Server } from "node:http";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { expectOwnerOnly } from "./helpers/private-files.ts";
import { Library } from "../src/library.ts";
import { manifest, manifestWithGenres } from "../src/manifest.ts";
import { NativePicker } from "../src/native-picker.ts";
import { createHandler } from "../src/routes.ts";
import type { AddonInterface } from "../src/server-types.ts";
import { DEFAULT_TAGS, Tags, dedupeTags } from "../src/tags.ts";
import type { TorrServerClient } from "../src/torrserver-client.ts";

let stateDir: string;

beforeEach(async () => {
  stateDir = await mkdtemp(join(tmpdir(), "hoshi-tags-"));
});

afterEach(async () => {
  await rm(stateDir, { recursive: true, force: true });
});

describe("Tags registry", () => {
  it("seeds the default genre set on first run with owner-only permissions", async () => {
    const path = join(stateDir, "tags.json");
    const tags = new Tags(path);
    expect(await tags.list()).toEqual([...DEFAULT_TAGS]);
    await expectOwnerOnly(path);
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual({
      tags: DEFAULT_TAGS,
      pinned: [],
    });
    expect(DEFAULT_TAGS).toContain("Sci-Fi");
    expect(DEFAULT_TAGS).toContain("Anime");
    expect(DEFAULT_TAGS).not.toContain("Adult");
  });

  it("adds, renames, and removes tags case-insensitively", async () => {
    const path = join(stateDir, "tags.json");
    await writeFile(path, JSON.stringify({ tags: ["Action"] }));
    const tags = new Tags(path);
    expect(await tags.add("  Heist ")).toBe("Heist");
    await expect(tags.add("heist")).rejects.toThrow(/already exists/);
    expect(await tags.rename("HEIST", "Caper")).toBe("Heist");
    await expect(tags.rename("Caper", "action")).rejects.toThrow(
      /already exists/,
    );
    expect(await tags.canonical("caper")).toBe("Caper");
    expect(await tags.remove("caper")).toBe("Caper");
    await expect(tags.remove("Caper")).rejects.toThrow(/not found/);
    expect(await new Tags(path).list()).toEqual(["Action"]);
  });

  it("ensure() registers unknown names and returns registry spelling", async () => {
    const path = join(stateDir, "tags.json");
    await writeFile(path, JSON.stringify({ tags: ["Sci-Fi"] }));
    const tags = new Tags(path);
    expect(await tags.ensure(["sci-fi", "Western", "western"])).toEqual([
      "Sci-Fi",
      "Western",
    ]);
    expect(await tags.list()).toEqual(["Sci-Fi", "Western"]);
  });

  it("dedupes tag lists keeping the first spelling", () => {
    expect(dedupeTags([" Drama", "drama", "", "Comedy", "DRAMA "])).toEqual([
      "Drama",
      "Comedy",
    ]);
  });
});

describe("Library.retag", () => {
  it("renames and strips a tag across entries", async () => {
    const library = new Library(join(stateDir, "library.json"));
    const a = await library.create({
      type: "movie",
      name: "A",
      magnetUri: "magnet:?xt=urn:btih:a",
      tags: ["Crime", "Comedy"],
    });
    const b = await library.create({
      type: "movie",
      name: "B",
      magnetUri: "magnet:?xt=urn:btih:b",
      tags: ["crime"],
    });
    await library.create({
      type: "movie",
      name: "C",
      magnetUri: "magnet:?xt=urn:btih:c",
    });
    expect(await library.retag("Crime", "Heist")).toBe(2);
    expect((await library.get(a.id))?.tags).toEqual(["Heist", "Comedy"]);
    expect((await library.get(b.id))?.tags).toEqual(["Heist"]);
    expect(await library.retag("heist", undefined)).toBe(2);
    expect((await library.get(a.id))?.tags).toEqual(["Comedy"]);
    expect((await library.get(b.id))?.tags).toBeUndefined();
    expect(await library.retag("Nothing", "X")).toBe(0);
  });
});

describe("manifestWithGenres", () => {
  it("fills the genre extra options on every browsing catalog", () => {
    const withGenres = manifestWithGenres(manifest, ["Action", "Drama"]);
    const browsing = withGenres.catalogs.filter(
      (catalog) => catalog.id !== "continue-watching",
    );
    expect(browsing).toHaveLength(2);
    for (const catalog of browsing) {
      const genre = catalog.extra.find((extra) => extra.name === "genre");
      expect(genre).toMatchObject({
        isRequired: false,
        options: ["Action", "Drama"],
      });
    }
    // The base manifest stays untouched.
    expect(
      manifest.catalogs[0].extra.find((extra) => extra.name === "genre"),
    ).not.toHaveProperty("options");
    expect(manifestWithGenres(manifest, [])).toBe(manifest);
  });
});

describe("tags API", () => {
  const TOKEN = "an-access-token-for-tag-tests";
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

  it("lists tags with usage counts and normalizes entry tags", async () => {
    const created = await api("/api/library", {
      method: "POST",
      body: JSON.stringify({
        type: "movie",
        name: "Heat",
        magnetUri: "magnet:?xt=urn:btih:heat",
        tags: ["action", "Crime", "crime"],
      }),
    });
    expect(created.status).toBe(201);
    const entry = await created.json();
    // Registry spelling wins; the unknown tag is registered on the fly.
    expect(entry.tags).toEqual(["Action", "Crime"]);
    const listed = await (await api("/api/tags")).json();
    expect(listed.tags).toEqual([
      { name: "Action", count: 1, pinned: false },
      { name: "Crime", count: 1, pinned: false },
      { name: "Drama", count: 0, pinned: false },
    ]);
    const cleared = await api(`/api/library/${encodeURIComponent(entry.id)}`, {
      method: "PATCH",
      body: JSON.stringify({ tags: null }),
    });
    expect((await cleared.json()).tags).toBeUndefined();
  });

  it("creates, renames with cascade, and deletes tags", async () => {
    const entry = await (
      await api("/api/library", {
        method: "POST",
        body: JSON.stringify({
          type: "series",
          name: "Show",
          magnetUri: "magnet:?xt=urn:btih:show",
          tags: ["Drama"],
        }),
      })
    ).json();
    const created = await api("/api/tags", {
      method: "POST",
      body: JSON.stringify({ name: "Soap" }),
    });
    expect(created.status).toBe(201);
    expect(await created.json()).toEqual({ name: "Soap" });
    const duplicate = await api("/api/tags", {
      method: "POST",
      body: JSON.stringify({ name: "soap" }),
    });
    expect(duplicate.status).toBe(400);
    expect(await duplicate.json()).toEqual({
      error: 'Tag "Soap" already exists',
    });

    const renamed = await api("/api/tags/Drama", {
      method: "PATCH",
      body: JSON.stringify({ name: "Dramedy" }),
    });
    expect(await renamed.json()).toEqual({ name: "Dramedy", entries: 1 });
    expect((await (await api(`/api/library/${entry.id}`)).json()).tags).toEqual(
      ["Dramedy"],
    );

    const deleted = await api("/api/tags/dramedy", { method: "DELETE" });
    expect(await deleted.json()).toEqual({ name: "Dramedy", entries: 1 });
    expect(
      (await (await api(`/api/library/${entry.id}`)).json()).tags,
    ).toBeUndefined();
    expect((await api("/api/tags/Nope", { method: "DELETE" })).status).toBe(
      400,
    );
    expect(
      (await (await api("/api/tags")).json()).tags.map(
        (tag: { name: string }) => tag.name,
      ),
    ).toEqual(["Action", "Soap"]);
  });

  it("advertises the live tag list as catalog genre options", async () => {
    const served = await (
      await fetch(`${baseUrl}/addon/${TOKEN}/manifest.json`)
    ).json();
    expect(
      served.catalogs[0].extra.find(
        (extra: { name: string }) => extra.name === "genre",
      ).options,
    ).toEqual(["Action", "Drama"]);
  });
});
