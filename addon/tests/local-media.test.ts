import { describe, expect, it } from "vitest";
import { mediaHeaders, parseRange } from "../src/local-media.js";
import { createEntrySchema } from "../src/types.js";

describe("local media ranges", () => {
  it("parses normal and suffix ranges and rejects invalid ranges", () => {
    expect(parseRange("bytes=10-19", 100)).toEqual({ start: 10, end: 19 });
    expect(parseRange("bytes=-10", 100)).toEqual({ start: 90, end: 99 });
    expect(parseRange("bytes=100-101", 100)).toBeUndefined();
  });

  it("accepts a managed series folder", () => {
    expect(
      createEntrySchema.parse({
        type: "series",
        name: "Show",
        localFolderPath: "/data/media/batch/Show",
      }).localFolderPath,
    ).toBe("/data/media/batch/Show");
  });

  it("only sends Content-Range for partial responses", () => {
    const range = { start: 0, end: 99 };
    expect(mediaHeaders(100, range, false, "video/mp4")).not.toHaveProperty(
      "content-range",
    );
    expect(mediaHeaders(100, range, true, "video/mp4")).toHaveProperty(
      "content-range",
      "bytes 0-99/100",
    );
  });
});
