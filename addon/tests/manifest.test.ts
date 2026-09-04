import { describe, expect, it } from "vitest";
import { manifest } from "../src/manifest.ts";

describe("manifest", () => {
  it("declares the private movie and series resources", () => {
    expect(manifest.id).toBe("com.john.private-torrent-streamer");
    expect(manifest.resources).toEqual(["catalog", "meta", "stream"]);
    expect(manifest.types).toEqual(["movie", "series"]);
    expect(manifest.catalogs).toHaveLength(2);
    expect(manifest.behaviorHints.p2p).toBe(true);
  });
});
