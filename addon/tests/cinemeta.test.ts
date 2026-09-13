import { describe, expect, it } from "vitest";
import { CinemetaClient, CinemetaError } from "../src/cinemeta.ts";

type Route = (url: URL, init?: RequestInit) => Response | Promise<Response>;

function client(route: Route, extra: { now?: () => number } = {}) {
  const calls: URL[] = [];
  const fetchStub: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    calls.push(url);
    return route(url, init);
  };
  const instance = new CinemetaClient({
    baseUrl: "https://cinemeta.test/",
    fetch: fetchStub,
    userAgent: "HoshiStream/test",
    ...extra,
  });
  return { client: instance, calls };
}

const json = (value: unknown, init: ResponseInit = {}) =>
  new Response(JSON.stringify(value), {
    status: 200,
    headers: { "content-type": "application/json" },
    ...init,
  });

describe("CinemetaClient.search", () => {
  it("encodes the query, sends our user agent and maps candidates", async () => {
    const { client: cinemeta, calls } = client((url, init) => {
      expect(url.pathname).toBe(
        "/catalog/series/top/search=The%20Bear%20%26%20Co.json",
      );
      expect(new Headers(init?.headers).get("user-agent")).toBe(
        "HoshiStream/test",
      );
      return json({
        metas: [
          {
            id: "tt14452776",
            imdb_id: "tt14452776",
            name: "The Bear",
            poster: "https://images.test/bear.jpg",
            releaseInfo: "2022-",
            type: "series",
          },
          { id: "tt0000001", name: "   ", poster: "x" },
          { id: "kitsu:1", name: "Not IMDb" },
          {
            id: "tt0000002",
            name: "Plain",
            year: 1999,
            poster: "http://insecure.test/p.jpg",
          },
        ],
      });
    });
    expect(await cinemeta.search("series", "The Bear & Co")).toEqual([
      {
        imdbId: "tt14452776",
        name: "The Bear",
        releaseInfo: "2022-",
        poster: "https://images.test/bear.jpg",
      },
      { imdbId: "tt0000002", name: "Plain", releaseInfo: "1999" },
    ]);
    expect(calls).toHaveLength(1);
  });

  it("returns nothing for a blank query without a request", async () => {
    const { client: cinemeta, calls } = client(() => json({ metas: [] }));
    expect(await cinemeta.search("movie", "   ")).toEqual([]);
    expect(calls).toHaveLength(0);
  });

  it("caches for three hours and shares in-flight requests", async () => {
    let now = 0;
    let hits = 0;
    const { client: cinemeta } = client(
      async () => {
        hits += 1;
        await new Promise((resolve) => setTimeout(resolve, 5));
        return json({ metas: [] });
      },
      { now: () => now },
    );
    await Promise.all([
      cinemeta.search("movie", "Dune"),
      cinemeta.search("movie", "Dune"),
    ]);
    expect(hits).toBe(1);
    now = 2 * 60 * 60 * 1000;
    await cinemeta.search("movie", "Dune");
    expect(hits).toBe(1);
    now = 3 * 60 * 60 * 1000 + 1;
    await cinemeta.search("movie", "Dune");
    expect(hits).toBe(2);
  });

  it("classifies failures", async () => {
    const down = client(() => {
      throw new TypeError("fetch failed");
    });
    await expect(down.client.search("movie", "x")).rejects.toMatchObject({
      kind: "unavailable",
    });
    const serverError = client(() => new Response("nope", { status: 502 }));
    await expect(serverError.client.search("movie", "x")).rejects.toMatchObject(
      { kind: "unavailable" },
    );
    const garbage = client(() => new Response("<html>", { status: 200 }));
    await expect(garbage.client.search("movie", "x")).rejects.toMatchObject({
      kind: "invalid",
    });
    const oversized = client(
      () => new Response("x".repeat(2_000_001), { status: 200 }),
    );
    await expect(oversized.client.search("movie", "x")).rejects.toMatchObject({
      kind: "invalid",
    });
  });
});

describe("CinemetaClient.meta", () => {
  it("validates the id and tolerates loose field shapes", async () => {
    const { client: cinemeta } = client((url) => {
      expect(url.pathname).toBe("/meta/series/tt14452776.json");
      return json({
        meta: {
          id: "tt14452776",
          name: "The Bear",
          releaseInfo: "2022–",
          imdbRating: 8.6,
          genre: ["Comedy", "Drama"],
          videos: [
            { season: 1, number: 1, title: "System", firstAired: "2022-06-23" },
          ],
          extra: { ignored: true },
        },
      });
    });
    const meta = await cinemeta.meta("series", "tt14452776");
    expect(meta.name).toBe("The Bear");
    expect(meta.genre).toEqual(["Comedy", "Drama"]);
    expect(meta.videos).toHaveLength(1);
    await expect(cinemeta.meta("series", "nope")).rejects.toBeInstanceOf(
      CinemetaError,
    );
  });

  it("reports missing titles as not-found", async () => {
    const nullMeta = client(() => json({ meta: null }));
    await expect(
      nullMeta.client.meta("movie", "tt0000001"),
    ).rejects.toMatchObject({ kind: "not-found" });
    const missing = client(() => new Response("", { status: 404 }));
    await expect(
      missing.client.meta("movie", "tt0000002"),
    ).rejects.toMatchObject({ kind: "not-found" });
  });
});
