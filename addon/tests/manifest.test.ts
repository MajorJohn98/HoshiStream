import { describe, expect, it } from "vitest";
import { manifest } from "../src/manifest.ts";

describe("manifest", () => {
  it("declares the private movie and series resources", () => {
    expect(manifest.id).toBe("com.john.private-torrent-streamer");
    expect(manifest.resources).toEqual([
      "catalog",
      "meta",
      "stream",
      "subtitles",
    ]);
    expect(manifest.types).toEqual(["movie", "series"]);
    expect(manifest.catalogs.map((catalog) => catalog.id)).toEqual([
      "private-movies",
      "private-series",
      "continue-watching",
      "continue-watching",
    ]);
    // Continue Watching is ordered by activity; only paging applies.
    for (const catalog of manifest.catalogs.filter(
      (item) => item.id === "continue-watching",
    ))
      expect(catalog.extra.map((extra) => extra.name)).toEqual(["skip"]);
    expect(manifest.behaviorHints.p2p).toBe(true);
  });
});
