import { describe, expect, it } from "vitest";
import { getCatalog } from "../src/catalog.js";

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
});
