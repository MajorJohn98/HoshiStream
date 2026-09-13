import { describe, expect, it } from "vitest";
import { getCatalog } from "../src/catalog.ts";

describe("catalog", () => {
  it("shows recently updated poster-shaped entries first", async () => {
    const entries = [
      "2026-01-01T00:00:00.000Z",
      "2026-02-01T00:00:00.000Z",
    ].map((updatedAt, index) => ({
      id: `hoshi:${index}`,
      type: "movie" as const,
      name: `Movie ${index}`,
      magnetUri: `magnet:?xt=urn:btih:${index}`,
      createdAt: updatedAt,
      updatedAt,
    }));
    const result = await getCatalog(
      { list: async () => entries } as never,
      "movie",
      {},
    );
    expect(result.metas.map((entry) => entry.id)).toEqual([
      "hoshi:1",
      "hoshi:0",
    ]);
    expect(result.metas[0].posterShape).toBe("poster");
  });

  it("reads current library contents on every request", async () => {
    const entries = [
      {
        id: "hoshi:1",
        type: "movie" as const,
        name: "First",
        magnetUri: "magnet:?xt=urn:btih:first",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      },
    ];
    const library = { list: async () => entries };
    expect(
      (await getCatalog(library as never, "movie", {})).metas,
    ).toHaveLength(1);
    entries.push({
      ...entries[0],
      id: "hoshi:2",
      name: "Second",
      magnetUri: "magnet:?xt=urn:btih:second",
    });
    expect(
      (await getCatalog(library as never, "movie", {})).metas,
    ).toHaveLength(2);
  });

  it("filters by the genre extra and exposes tags as genres", async () => {
    const entries = [["Comedy", "Crime"], ["Drama"], undefined].map(
      (tags, index) => ({
        id: `hoshi:${index}`,
        type: "movie" as const,
        name: `Movie ${index}`,
        magnetUri: `magnet:?xt=urn:btih:${index}`,
        ...(tags ? { tags } : {}),
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      }),
    );
    const library = { list: async () => entries } as never;
    const crime = await getCatalog(library, "movie", { genre: "crime" });
    expect(crime.metas.map((meta) => meta.id)).toEqual(["hoshi:0"]);
    expect(crime.metas[0].genres).toEqual(["Comedy", "Crime"]);
    const all = await getCatalog(library, "movie", {});
    expect(all.metas).toHaveLength(3);
    expect(all.metas[2]).not.toHaveProperty("genres");
    expect(
      (await getCatalog(library, "movie", { genre: "Horror" })).metas,
    ).toEqual([]);
  });

  it("lists Continue Watching by recent activity, opening on the resume file", async () => {
    const at = "2026-09-13T10:00:00.000Z";
    const later = "2026-09-13T12:00:00.000Z";
    const base = {
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    };
    const episodes = [
      { id: 1, path: "S01E01.mkv", length: 10, season: 1, episode: 1 },
      { id: 2, path: "S01E02.mkv", length: 10, season: 1, episode: 2 },
    ];
    const entries = [
      {
        ...base,
        id: "hoshi:show",
        type: "series" as const,
        name: "Show",
        magnetUri: "magnet:?xt=urn:btih:show",
        inspectionCache: {
          hash: "a",
          inspectedAt: at,
          selectedFiles: episodes,
        },
        watchStates: [{ fileId: 1, state: "watched" as const, at }],
      },
      {
        ...base,
        id: "hoshi:film",
        type: "movie" as const,
        name: "Film",
        magnetUri: "magnet:?xt=urn:btih:film",
        inspectionCache: {
          hash: "b",
          inspectedAt: at,
          selectedFiles: [{ id: 1, path: "film.mkv", length: 10 }],
        },
        watchStates: [{ fileId: 1, state: "started" as const, at: later }],
      },
      {
        // Finished: drops out of the row.
        ...base,
        id: "hoshi:done",
        type: "movie" as const,
        name: "Done",
        magnetUri: "magnet:?xt=urn:btih:done",
        inspectionCache: {
          hash: "c",
          inspectedAt: at,
          selectedFiles: [{ id: 1, path: "done.mkv", length: 10 }],
        },
        watchStates: [{ fileId: 1, state: "watched" as const, at: later }],
      },
      {
        // Never inspected: nothing to resume yet.
        ...base,
        id: "hoshi:fresh",
        type: "movie" as const,
        name: "Fresh",
        magnetUri: "magnet:?xt=urn:btih:fresh",
        watchStates: [{ fileId: 1, state: "started" as const, at: later }],
      },
    ];
    const library = { list: async () => entries } as never;
    const movies = await getCatalog(library, "movie", {}, "continue-watching");
    expect(movies.metas.map((meta) => meta.id)).toEqual(["hoshi:film"]);
    expect(movies.metas[0].behaviorHints).toEqual({
      defaultVideoId: "hoshi:film",
    });
    const series = await getCatalog(library, "series", {}, "continue-watching");
    expect(series.metas.map((meta) => meta.id)).toEqual(["hoshi:show"]);
    expect(series.metas[0].behaviorHints).toEqual({
      defaultVideoId: "hoshi:show:1:2",
    });
    // Skip pages the row; the browsing catalogs are unaffected.
    expect(
      (await getCatalog(library, "movie", { skip: "1" }, "continue-watching"))
        .metas,
    ).toEqual([]);
    expect(
      (await getCatalog(library, "movie", {}, "private-movies")).metas,
    ).toHaveLength(3);
  });
});
