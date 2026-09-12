import { describe, expect, it } from "vitest";

globalThis.location = {
  pathname: "/manage/fixture-token",
} as Location;

const { protocolId, sidecarTracks } =
  await import("../assets/manage/views/player.js");

describe("protocolId", () => {
  it("uses the bare entry id for movies and the episode id for series", () => {
    expect(protocolId({ id: "hoshi:a", type: "movie" }, undefined)).toBe(
      "hoshi:a",
    );
    expect(
      protocolId({ id: "hoshi:a", type: "movie" }, { season: 1, episode: 2 }),
    ).toBe("hoshi:a");
    expect(
      protocolId({ id: "hoshi:b", type: "series" }, { season: 1, episode: 2 }),
    ).toBe("hoshi:b:1:2");
    expect(protocolId({ id: "hoshi:b", type: "series" }, undefined)).toBe(
      "hoshi:b",
    );
  });
});

describe("sidecarTracks", () => {
  it("keeps only WebVTT sidecars the browser can render", () => {
    expect(sidecarTracks(undefined)).toEqual([]);
    expect(
      sidecarTracks([
        {
          id: "a:1",
          url: "http://x/subtitles/t/e/a:1.vtt",
          lang: "eng",
          label: "English",
        },
        { id: "a:2", url: "http://x/subtitles/t/e/a:2.ass", lang: "eng" },
        { id: "a:3", url: "http://x/subtitles/t/e/a:3.VTT", lang: "" },
      ]),
    ).toEqual([
      {
        id: "a:1",
        src: "http://x/subtitles/t/e/a:1.vtt",
        label: "English",
        srclang: "eng",
      },
      {
        id: "a:3",
        src: "http://x/subtitles/t/e/a:3.VTT",
        label: "Subtitle",
        srclang: "und",
      },
    ]);
  });
});
