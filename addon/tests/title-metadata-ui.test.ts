import { describe, expect, it } from "vitest";

globalThis.location = {
  pathname: "/manage/fixture-token",
} as Location;

const {
  joinNameList,
  joinTrailers,
  metadataPatch,
  parseNameList,
  parseTrailers,
  youtubeId,
} = await import("../assets/manage/views/title-metadata.js");

describe("parseNameList", () => {
  it("splits on commas and newlines, trims, dedupes, and clears when empty", () => {
    expect(parseNameList(" Ada Lovelace,Alan Turing\nAda Lovelace ")).toEqual([
      "Ada Lovelace",
      "Alan Turing",
    ]);
    expect(parseNameList("  , ,\n")).toBeNull();
    expect(joinNameList(["A", "B"])).toBe("A, B");
    expect(joinNameList(undefined)).toBe("");
  });
});

describe("youtubeId", () => {
  it.each([
    ["dQw4w9WgXcQ", "dQw4w9WgXcQ"],
    ["https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=10", "dQw4w9WgXcQ"],
    ["https://youtu.be/dQw4w9WgXcQ?si=abc", "dQw4w9WgXcQ"],
    ["https://m.youtube.com/shorts/dQw4w9WgXcQ", "dQw4w9WgXcQ"],
    ["https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ", "dQw4w9WgXcQ"],
    ["https://vimeo.com/12345", undefined],
    ["not a link", undefined],
    ["", undefined],
  ])("%s → %s", (input, expected) => {
    expect(youtubeId(input)).toBe(expected);
  });
});

describe("parseTrailers", () => {
  it("builds Trailer objects one per line and rejects junk", () => {
    expect(
      parseTrailers(
        "https://youtu.be/dQw4w9WgXcQ\n\ndQw4w9WgXcQ\nhttps://www.youtube.com/watch?v=9bZkp7q19f0",
      ),
    ).toEqual([
      { source: "dQw4w9WgXcQ", type: "Trailer" },
      { source: "9bZkp7q19f0", type: "Trailer" },
    ]);
    expect(parseTrailers("")).toBeNull();
    expect(() => parseTrailers("https://vimeo.com/1")).toThrow(
      /not a YouTube link/,
    );
    expect(joinTrailers([{ source: "dQw4w9WgXcQ", type: "Trailer" }])).toBe(
      "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
    );
  });
});

describe("metadataPatch", () => {
  it("sends every field, null for blanks, and drops the default poster shape", () => {
    expect(
      metadataPatch({
        releaseInfo: " 2019 ",
        runtime: "",
        imdbRating: "7.8",
        cast: "A, B",
        director: "",
        writer: "",
        country: "",
        language: "",
        logo: "",
        awards: "",
        trailers: "dQw4w9WgXcQ",
        posterShape: "poster",
      }),
    ).toEqual({
      releaseInfo: "2019",
      runtime: null,
      imdbRating: "7.8",
      cast: ["A", "B"],
      director: null,
      writer: null,
      country: null,
      language: null,
      logo: null,
      awards: null,
      trailers: [{ source: "dQw4w9WgXcQ", type: "Trailer" }],
      posterShape: null,
    });
    expect(metadataPatch({ posterShape: "landscape" }).posterShape).toBe(
      "landscape",
    );
  });
});
