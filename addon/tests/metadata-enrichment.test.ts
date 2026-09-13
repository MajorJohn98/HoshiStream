import { createServer, type Server } from "node:http";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ArtworkCache } from "../src/artwork-cache.ts";
import { CinemetaClient, type CinemetaMeta } from "../src/cinemeta.ts";
import { Library } from "../src/library.ts";
import { manifest } from "../src/manifest.ts";
import {
  MetadataEnrichment,
  mapCinemetaMeta,
  mergeEnrichment,
  pickCandidate,
  stripEnrichment,
} from "../src/metadata-enrichment.ts";
import { MetadataSettingsStore } from "../src/metadata-settings.ts";
import { NativePicker } from "../src/native-picker.ts";
import { createHandler } from "../src/routes.ts";
import type { AddonInterface } from "../src/server-types.ts";
import { Tags } from "../src/tags.ts";
import type { TorrServerClient } from "../src/torrserver-client.ts";
import type { EntryMetadata, LibraryEntry } from "../src/types.ts";

const TOKEN = "an-access-token-for-metadata-tests";
const MAGNET = `magnet:?xt=urn:btih:${"a".repeat(40)}&dn=x`;
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
  "base64",
);

const torrServer = {
  health: async () => "1.0",
  list: async () => [],
  get: async () => {
    throw new Error("unknown");
  },
  streamUrl: () => "http://torrserver/play",
} as unknown as TorrServerClient;
const addon: AddonInterface = {
  manifest,
  get: async (resource, type) => ({ resource, type, metas: [] }),
};

const bearMeta: CinemetaMeta = {
  id: "tt14452776",
  imdb_id: "tt14452776",
  type: "series",
  name: "The Bear",
  description: "A young chef returns to Chicago.",
  poster: "https://images.test/bear/poster.png",
  background: "https://images.test/bear/background.png",
  logo: "https://images.test/bear/logo.png",
  releaseInfo: "2022–",
  runtime: "30 min",
  imdbRating: "8.6",
  cast: ["Jeremy Allen White", " Ayo Edebiri ", "Jeremy Allen White"],
  director: [],
  writer: ["Christopher Storer"],
  country: "United States",
  awards: "Won 21 Primetime Emmys",
  genres: ["Comedy", "Drama", "Drama"],
  trailers: [
    { source: "bp7_vNsGrPk", type: "Trailer" },
    { source: "not a youtube id", type: "Trailer" },
  ],
  status: "Continuing",
  videos: [
    {
      season: 1,
      episode: 1,
      name: "System",
      overview: "Carmy takes over.",
      released: "2022-06-23T00:00:00.000Z",
    },
    { season: 1, number: 2, title: "Hands", firstAired: "2022-06-23" },
    { season: 0, episode: 1, name: "Special" },
    { season: 2, episode: 1, name: "Beef" },
  ],
};

// One in-process HTTP server plays both Cinemeta and the image CDN.
interface Stub {
  server: Server;
  url: string;
  requests: string[];
  searchMetas: unknown[];
  meta: unknown;
  fail: boolean;
}
async function startStub(): Promise<Stub> {
  const stub: Partial<Stub> & { requests: string[] } = {
    requests: [],
    searchMetas: [
      {
        id: "tt14452776",
        name: "The Bear",
        releaseInfo: "2022-",
        poster: "https://images.test/bear/poster.png",
      },
    ],
    meta: bearMeta,
    fail: false,
  };
  const server = createServer((request, response) => {
    const path = request.url ?? "/";
    stub.requests.push(path);
    if (stub.fail) {
      response.writeHead(503);
      return response.end();
    }
    if (path.endsWith(".png")) {
      response.writeHead(200, { "content-type": "image/png" });
      return response.end(PNG);
    }
    if (path.startsWith("/catalog/")) {
      response.writeHead(200, { "content-type": "application/json" });
      return response.end(JSON.stringify({ metas: stub.searchMetas }));
    }
    if (path.startsWith("/meta/")) {
      if (stub.meta === null) {
        response.writeHead(404);
        return response.end();
      }
      response.writeHead(200, { "content-type": "application/json" });
      return response.end(JSON.stringify({ meta: stub.meta }));
    }
    response.writeHead(404);
    response.end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("no port");
  stub.server = server;
  stub.url = `http://127.0.0.1:${address.port}`;
  return stub as Stub;
}

let stateDir: string;
let stub: Stub;

beforeEach(async () => {
  stateDir = await mkdtemp(join(tmpdir(), "hoshi-metadata-"));
  stub = await startStub();
});

afterEach(async () => {
  stub.server.closeAllConnections();
  await new Promise<void>((resolve) => stub.server.close(() => resolve()));
  await rm(stateDir, { recursive: true, force: true });
});

function seriesEntry(overrides: Partial<LibraryEntry> = {}): LibraryEntry {
  return {
    id: "hoshi:series:1",
    type: "series",
    name: "The.Bear.2022.S01.1080p.WEB-DL",
    magnetUri: MAGNET,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  } as LibraryEntry;
}

const emptyMetadata = (): EntryMetadata => ({
  provider: "cinemeta",
  status: "matched",
  imdbId: "tt14452776",
  owned: [],
  ownedEpisodes: [],
  ownedTags: [],
});

describe("mapCinemetaMeta", () => {
  it("applies our limits and shapes", () => {
    const mapped = mapCinemetaMeta(bearMeta, seriesEntry());
    expect(mapped.fields).toMatchObject({
      description: "A young chef returns to Chicago.",
      poster: "https://images.test/bear/poster.png",
      background: "https://images.test/bear/background.png",
      releaseInfo: "2022-",
      runtime: "30 min",
      imdbRating: "8.6",
      cast: ["Jeremy Allen White", "Ayo Edebiri"],
      writer: ["Christopher Storer"],
      country: "United States",
      logo: "https://images.test/bear/logo.png",
      awards: "Won 21 Primetime Emmys",
      trailers: [{ source: "bp7_vNsGrPk", type: "Trailer" }],
    });
    expect(mapped.fields.director).toBeUndefined();
    expect(mapped.genres).toEqual(["Comedy", "Drama"]);
    expect(mapped.ongoing).toBe(true);
    // Season 0 is skipped without files mapped to it; episode 2 keeps the
    // `number`/`title`/`firstAired` aliases minus the non-ISO date.
    expect(Object.keys(mapped.episodes).sort()).toEqual(["1:1", "1:2", "2:1"]);
    expect(mapped.episodes["1:1"]).toEqual({
      title: "System",
      overview: "Carmy takes over.",
      released: "2022-06-23T00:00:00.000Z",
    });
    expect(mapped.episodes["1:2"]).toEqual({ title: "Hands" });
  });

  it("drops a zero rating, http images, and movie ongoing", () => {
    const mapped = mapCinemetaMeta(
      {
        ...bearMeta,
        imdbRating: "0",
        poster: "http://insecure.test/p.jpg",
        status: "Continuing",
      },
      { type: "movie" },
    );
    expect(mapped.fields.imdbRating).toBeUndefined();
    expect(mapped.fields.poster).toBeUndefined();
    expect(mapped.ongoing).toBeUndefined();
    expect(mapped.episodes).toEqual({});
  });

  it("includes specials only when the entry maps files to season 0", () => {
    const entry = seriesEntry({
      inspectionCache: {
        hash: "a".repeat(40),
        inspectedAt: "2026-01-01T00:00:00.000Z",
        selectedFiles: [
          { id: 0, path: "s00e01.mkv", length: 1, season: 0, episode: 1 },
        ],
      },
    });
    expect(Object.keys(mapCinemetaMeta(bearMeta, entry).episodes)).toContain(
      "0:1",
    );
  });

  it("caps episodes at 500, preferring seasons with files", () => {
    const videos = [];
    for (let season = 1; season <= 6; season += 1)
      for (let episode = 1; episode <= 100; episode += 1)
        videos.push({ season, episode, name: `S${season}E${episode}` });
    const entry = seriesEntry({
      inspectionCache: {
        hash: "a".repeat(40),
        inspectedAt: "2026-01-01T00:00:00.000Z",
        selectedFiles: [
          { id: 0, path: "s06e01.mkv", length: 1, season: 6, episode: 1 },
        ],
      },
    });
    const mapped = mapCinemetaMeta({ ...bearMeta, videos }, entry);
    const keys = Object.keys(mapped.episodes);
    expect(keys).toHaveLength(500);
    expect(keys).toContain("6:100");
    expect(keys).not.toContain("5:100");
  });
});

describe("mergeEnrichment", () => {
  const mapped = mapCinemetaMeta(bearMeta, seriesEntry());

  it("fill mode writes only empty fields and records ownership", () => {
    const entry = seriesEntry({
      description: "Mine",
      tags: ["Favourites"],
      episodes: { "1:1": { title: "My title" } },
    });
    const { candidate, metadata, written } = mergeEnrichment(
      entry,
      mapped,
      "fill",
      emptyMetadata(),
      ["Comedy", "Drama"],
    );
    expect(candidate.description).toBe("Mine");
    expect(candidate.tags).toEqual(["Favourites"]);
    expect(candidate.poster).toBe("https://images.test/bear/poster.png");
    expect(candidate.ongoing).toBe(true);
    expect((candidate.episodes as Record<string, unknown>)["1:1"]).toEqual({
      title: "My title",
    });
    expect((candidate.episodes as Record<string, unknown>)["1:2"]).toEqual({
      title: "Hands",
    });
    expect(metadata.owned).not.toContain("description");
    expect(metadata.owned).not.toContain("tags");
    expect(metadata.owned).toEqual(
      expect.arrayContaining(["poster", "ongoing", "imdbRating"]),
    );
    expect(metadata.ownedEpisodes.sort()).toEqual(["1:2", "2:1"]);
    expect(written).toContain("poster");
    expect(written).not.toContain("description");
  });

  it("replace mode rewrites owned values, keeps viewer values, and drops stale owned fields", () => {
    const entry = seriesEntry({
      description: "Old fetched",
      imdbRating: "7.0",
      awards: "Fetched awards",
      tags: ["Favourites", "Action"],
      episodes: { "1:1": { title: "Old fetched" } },
    });
    const base: EntryMetadata = {
      ...emptyMetadata(),
      owned: ["description", "awards", "tags"],
      ownedTags: ["Action"],
      ownedEpisodes: ["1:1"],
    };
    const { candidate, metadata } = mergeEnrichment(
      entry,
      { ...mapped, fields: { ...mapped.fields, awards: undefined } },
      "replace",
      base,
      ["Comedy", "Drama"],
    );
    expect(candidate.description).toBe("A young chef returns to Chicago.");
    expect(candidate.imdbRating).toBe("7.0");
    expect(candidate.awards).toBeUndefined();
    expect(candidate.tags).toEqual(["Favourites", "Comedy", "Drama"]);
    expect(metadata.ownedTags).toEqual(["Comedy", "Drama"]);
    expect((candidate.episodes as Record<string, unknown>)["1:1"]).toEqual({
      title: "System",
      overview: "Carmy takes over.",
      released: "2022-06-23T00:00:00.000Z",
    });
    expect(metadata.owned).not.toContain("awards");
    expect(metadata.owned).not.toContain("imdbRating");
  });

  it("stripEnrichment removes only owned values", () => {
    const entry = seriesEntry({
      description: "Fetched",
      awards: "Mine",
      tags: ["Favourites", "Comedy"],
      episodes: { "1:1": { title: "Fetched" }, "1:2": { title: "Mine" } },
      metadata: {
        ...emptyMetadata(),
        owned: ["description", "tags"],
        ownedTags: ["Comedy"],
        ownedEpisodes: ["1:1"],
      },
    });
    const stripped = stripEnrichment(entry);
    expect(stripped.description).toBeUndefined();
    expect(stripped.awards).toBe("Mine");
    expect(stripped.tags).toEqual(["Favourites"]);
    expect(stripped.episodes).toEqual({ "1:2": { title: "Mine" } });
    expect(stripped.metadata).toBeUndefined();
  });
});

describe("pickCandidate", () => {
  const bear = { imdbId: "tt14452776", name: "The Bear", releaseInfo: "2022-" };
  const other = {
    imdbId: "tt0000001",
    name: "Bear Grylls",
    releaseInfo: "2010-",
  };
  it("accepts a single hit or an exact top hit", () => {
    expect(pickCandidate({ title: "Anything" }, [bear])).toBe(bear);
    expect(
      pickCandidate({ title: "the bear", year: 2022 }, [bear, other]),
    ).toBe(bear);
    expect(pickCandidate({ title: "Bear" }, [bear, other])).toBe(bear);
  });
  it("refuses ambiguous or mismatched years", () => {
    expect(pickCandidate({ title: "Bears" }, [bear, other])).toBeUndefined();
    expect(
      pickCandidate({ title: "The Bear", year: 1998 }, [bear, other]),
    ).toBeUndefined();
    expect(pickCandidate({ title: "x" }, [])).toBeUndefined();
  });
});

describe("MetadataEnrichment service", () => {
  let library: Library;
  let tags: Tags;
  let settings: MetadataSettingsStore;
  let service: MetadataEnrichment;
  let artwork: ArtworkCache;

  beforeEach(async () => {
    library = new Library(join(stateDir, "library.json"));
    await writeFile(join(stateDir, "tags.json"), JSON.stringify({ tags: [] }));
    tags = new Tags(join(stateDir, "tags.json"));
    settings = new MetadataSettingsStore(join(stateDir, "metadata.json"));
    const redirectImages: typeof fetch = (input, init) =>
      fetch(String(input).replace("https://images.test", stub.url), init);
    artwork = new ArtworkCache({
      dir: join(stateDir, "artwork"),
      fetch: redirectImages,
    });
    service = new MetadataEnrichment({
      library,
      tags,
      settings,
      client: new CinemetaClient({ baseUrl: stub.url }),
      artwork,
      sleep: async () => undefined,
    });
  });

  it("does nothing while disabled", async () => {
    const entry = await library.create({
      type: "series",
      name: "The Bear S01",
      magnetUri: MAGNET,
    });
    await expect(service.enrich(entry.id, "fill")).rejects.toMatchObject({
      code: "disabled",
    });
    service.queueAuto(entry.id);
    await service.settle();
    expect(stub.requests).toEqual([]);
    expect((await library.get(entry.id))?.metadata).toBeUndefined();
  });

  it("auto-matches, writes fields, genres, episodes and caches artwork", async () => {
    await settings.update({ enabled: true });
    const entry = await library.create({
      type: "series",
      name: "The.Bear.2022.S01.1080p",
      magnetUri: MAGNET,
      tags: [],
    });
    const outcome = await service.enrich(entry.id, "fill");
    expect(outcome.status).toBe("matched");
    const stored = await library.get(entry.id);
    expect(stored?.metadata).toMatchObject({
      provider: "cinemeta",
      imdbId: "tt14452776",
      status: "matched",
      query: { title: "The Bear", year: 2022 },
    });
    expect(stored?.description).toBe("A young chef returns to Chicago.");
    expect(stored?.tags).toEqual(["Comedy", "Drama"]);
    expect(await tags.list()).toEqual(["Comedy", "Drama"]);
    expect(stored?.ongoing).toBe(true);
    expect(stored?.episodes?.["1:1"]?.title).toBe("System");
    expect(stored?.metadata?.artwork?.poster?.file).toBe("poster.png");
    expect(stored?.metadata?.artwork?.logo?.sourceUrl).toBe(
      "https://images.test/bear/logo.png",
    );
    const files = await readdir(
      join(stateDir, "artwork", Buffer.from(entry.id).toString("base64url")),
    );
    expect(files.sort()).toEqual(["background.png", "logo.png", "poster.png"]);
    // Only the cleaned title travels; never the release name.
    expect(stub.requests[0]).toBe("/catalog/series/top/search=The%20Bear.json");
    expect(stub.requests.join(" ")).not.toContain("1080p");
  });

  it("stores candidates for review when the top hit is ambiguous", async () => {
    await settings.update({ enabled: true });
    stub.searchMetas = [
      { id: "tt0000001", name: "Bear Grylls", releaseInfo: "2010-" },
      { id: "tt14452776", name: "The Bear", releaseInfo: "2022-" },
    ];
    const entry = await library.create({
      type: "series",
      name: "Bear S01",
      magnetUri: MAGNET,
    });
    const outcome = await service.enrich(entry.id, "fill");
    expect(outcome.status).toBe("needs-review");
    const stored = await library.get(entry.id);
    expect(stored?.metadata?.candidates).toHaveLength(2);
    expect(stored?.description).toBeUndefined();
    // Apply a chosen candidate in replace mode.
    const applied = await service.apply(entry.id, "tt14452776", "replace");
    expect(applied.status).toBe("matched");
    expect((await library.get(entry.id))?.metadata?.candidates).toBeUndefined();
  });

  it("marks unmatched and unavailable outcomes", async () => {
    await settings.update({ enabled: true });
    stub.searchMetas = [];
    const entry = await library.create({
      type: "movie",
      name: "Obscure Film 1999",
      magnetUri: MAGNET,
    });
    expect((await service.enrich(entry.id, "fill")).status).toBe("unmatched");
    stub.fail = true;
    const other = await library.create({
      type: "movie",
      name: "Another Film",
      magnetUri: MAGNET.replace(/a{40}/, "b".repeat(40)),
    });
    const outcome = await service.enrich(other.id, "fill");
    expect(outcome.status).toBe("unavailable");
    expect(outcome.metadata?.lastError).toBeTruthy();
  });

  it("viewer edits win: PATCH transfers ownership and refresh leaves them alone", async () => {
    await settings.update({ enabled: true });
    const entry = await library.create({
      type: "series",
      name: "The Bear",
      magnetUri: MAGNET,
    });
    await service.enrich(entry.id, "fill");
    // Saving the form re-sends every field; only the changed one transfers.
    const patched = await library.patch(entry.id, {
      description: "My own words",
      imdbRating: "8.6",
      episodes: {
        "1:1": {
          title: "System",
          overview: "Carmy takes over.",
          released: "2022-06-23T00:00:00.000Z",
        },
        "1:2": { title: "My episode title" },
        "2:1": { title: "Beef" },
      },
      tags: ["Comedy"],
    });
    expect(patched?.metadata?.owned).not.toContain("description");
    expect(patched?.metadata?.owned).toContain("imdbRating");
    expect(patched?.metadata?.ownedEpisodes).toContain("1:1");
    expect(patched?.metadata?.ownedEpisodes).not.toContain("1:2");
    expect(patched?.metadata?.ownedTags).toEqual(["Comedy"]);
    stub.meta = { ...bearMeta, description: "Newer text", imdbRating: "9.0" };
    const refreshed = await service.refresh(entry.id);
    expect(refreshed.status).toBe("matched");
    const stored = await library.get(entry.id);
    expect(stored?.description).toBe("My own words");
    expect(stored?.imdbRating).toBe("9.0");
    expect(stored?.episodes?.["1:2"]?.title).toBe("My episode title");
    // Unlink removes only what enrichment still owns.
    const unlinked = await service.unlink(entry.id);
    expect(unlinked.description).toBe("My own words");
    expect(unlinked.imdbRating).toBeUndefined();
    expect(unlinked.episodes?.["1:2"]?.title).toBe("My episode title");
    expect(unlinked.episodes?.["1:1"]).toBeUndefined();
    expect(unlinked.metadata).toBeUndefined();
    await expect(
      readdir(
        join(stateDir, "artwork", Buffer.from(entry.id).toString("base64url")),
      ),
    ).rejects.toThrow();
  });

  it("backfills unmatched entries one at a time", async () => {
    await settings.update({ enabled: true });
    const a = await library.create({
      type: "series",
      name: "The Bear",
      magnetUri: MAGNET,
    });
    const b = await library.create({
      type: "series",
      name: "The Bear S02",
      magnetUri: MAGNET.replace(/a{40}/, "c".repeat(40)),
    });
    const progress = await service.startBackfill();
    expect(progress).toMatchObject({ running: true, total: 2, done: 0 });
    await expect(service.startBackfill()).rejects.toMatchObject({
      code: "busy",
    });
    await service.awaitBackfill();
    expect(service.backfillStatus()).toMatchObject({
      running: false,
      done: 2,
      matched: 2,
    });
    expect((await library.get(a.id))?.metadata?.imdbId).toBe("tt14452776");
    expect((await library.get(b.id))?.metadata?.imdbId).toBe("tt14452776");
  });
});

describe("metadata routes", () => {
  let server: Server;
  let baseUrl: string;
  let library: Library;
  let service: MetadataEnrichment;

  beforeEach(async () => {
    library = new Library(join(stateDir, "library.json"));
    await writeFile(join(stateDir, "tags.json"), JSON.stringify({ tags: [] }));
    const redirectImages: typeof fetch = (input, init) =>
      fetch(String(input).replace("https://images.test", stub.url), init);
    const artwork = new ArtworkCache({
      dir: join(stateDir, "artwork"),
      fetch: redirectImages,
    });
    service = new MetadataEnrichment({
      library,
      tags: new Tags(join(stateDir, "tags.json")),
      settings: new MetadataSettingsStore(join(stateDir, "metadata.json")),
      client: new CinemetaClient({ baseUrl: stub.url }),
      artwork,
      sleep: async () => undefined,
    });
    server = createServer(
      createHandler({
        library,
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
        tags: new Tags(join(stateDir, "tags.json")),
        metadata: service,
        artwork,
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

  it("exposes settings and refuses everything else while disabled", async () => {
    const initial = await api("/api/metadata/settings");
    expect(await initial.json()).toEqual({ enabled: false, autoOnAdd: true });
    const created = await api("/api/library", {
      method: "POST",
      body: JSON.stringify({
        type: "movie",
        name: "Dune 2021",
        magnetUri: MAGNET,
      }),
    });
    expect(created.status).toBe(201);
    const { id } = await created.json();
    await service.settle();
    expect(stub.requests).toEqual([]);
    for (const [path, init] of [
      [`/api/library/${id}/metadata/search`, {}],
      [
        `/api/library/${id}/metadata/apply`,
        { method: "POST", body: JSON.stringify({ imdbId: "tt1160419" }) },
      ],
      [`/api/library/${id}/metadata/refresh`, { method: "POST" }],
      ["/api/metadata/backfill", { method: "POST" }],
    ] as const) {
      const response = await api(path, init);
      expect(response.status).toBe(409);
      expect((await response.json()).code).toBe("metadata-disabled");
    }
    const bad = await api("/api/metadata/settings", {
      method: "PUT",
      body: JSON.stringify({ enabled: "yes" }),
    });
    expect(bad.status).toBe(400);
  });

  it("fetches after an add once enabled, serves artwork, and rejects client-written metadata", async () => {
    const enabled = await api("/api/metadata/settings", {
      method: "PUT",
      body: JSON.stringify({ enabled: true }),
    });
    expect(await enabled.json()).toEqual({ enabled: true, autoOnAdd: true });
    const created = await api("/api/library", {
      method: "POST",
      body: JSON.stringify({
        type: "series",
        name: "The Bear S01",
        magnetUri: MAGNET,
      }),
    });
    expect(created.status).toBe(201);
    const { id } = await created.json();
    await service.settle();
    const stored = await (await api(`/api/library/${id}`)).json();
    expect(stored.metadata.status).toBe("matched");
    expect(stored.poster).toBe("https://images.test/bear/poster.png");

    // Catalog and meta on the tokenized path point at the cached copies, on
    // the origin the client reached us on.
    const catalog = await fetch(
      `${baseUrl}/addon/${TOKEN}/catalog/series/private-series.json`,
    );
    const { metas } = await catalog.json();
    const artworkUrl = `${baseUrl}/artwork/${encodeURIComponent(TOKEN)}/${encodeURIComponent(id)}/poster`;
    expect(metas[0].poster).toBe(artworkUrl);
    const movie = await api("/api/library", {
      method: "POST",
      body: JSON.stringify({
        type: "movie",
        name: "The Bear (2022)",
        magnetUri: MAGNET.replace(/a{40}/, "d".repeat(40)),
      }),
    });
    const movieId = (await movie.json()).id as string;
    await service.settle();
    const meta = await fetch(
      `${baseUrl}/addon/${TOKEN}/meta/movie/${encodeURIComponent(movieId)}.json`,
    );
    expect((await meta.json()).meta.poster).toBe(
      `${baseUrl}/artwork/${encodeURIComponent(TOKEN)}/${encodeURIComponent(movieId)}/poster`,
    );
    expect(
      (await api(`/api/library/${movieId}`, { method: "DELETE" })).status,
    ).toBe(204);
    const art = await fetch(
      `${baseUrl}/artwork/${TOKEN}/${encodeURIComponent(id)}/poster`,
    );
    expect(art.status).toBe(200);
    expect(art.headers.get("content-type")).toBe("image/png");
    const etag = art.headers.get("etag");
    const cached = await fetch(
      `${baseUrl}/artwork/${TOKEN}/${encodeURIComponent(id)}/poster`,
      {
        headers: { "if-none-match": etag ?? "" },
      },
    );
    expect(cached.status).toBe(304);
    expect(
      (
        await fetch(
          `${baseUrl}/artwork/${TOKEN}/${encodeURIComponent(id)}/banner`,
        )
      ).status,
    ).toBe(404);
    expect(
      (await fetch(`${baseUrl}/artwork/wrong/${encodeURIComponent(id)}/poster`))
        .status,
    ).toBe(404);

    const rejected = await api(`/api/library/${id}`, {
      method: "PATCH",
      body: JSON.stringify({
        metadata: { provider: "cinemeta", status: "matched" },
      }),
    });
    expect(rejected.status).toBe(400);

    const search = await api(`/api/library/${id}/metadata/search?q=Bear`);
    expect(await search.json()).toMatchObject({
      query: { title: "Bear" },
      candidates: [{ imdbId: "tt14452776" }],
    });
    const refreshed = await api(`/api/library/${id}/metadata/refresh`, {
      method: "POST",
    });
    expect(refreshed.status).toBe(200);
    const unlinked = await api(`/api/library/${id}/metadata`, {
      method: "DELETE",
    });
    expect(unlinked.status).toBe(200);
    expect((await unlinked.json()).metadata).toBeUndefined();
    const stale = await fetch(
      `${baseUrl}/artwork/${TOKEN}/${encodeURIComponent(id)}/poster`,
    );
    expect(stale.status).toBe(404);

    const backfill = await api("/api/metadata/backfill", { method: "POST" });
    expect(backfill.status).toBe(202);
    await service.awaitBackfill();
    expect(await (await api("/api/metadata/backfill")).json()).toMatchObject({
      running: false,
      total: 1,
      matched: 1,
    });
    const removed = await api(`/api/library/${id}`, { method: "DELETE" });
    expect(removed.status).toBe(204);
    await expect(
      readdir(join(stateDir, "artwork", Buffer.from(id).toString("base64url"))),
    ).rejects.toThrow();
  });
});
