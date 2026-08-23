import { describe, expect, it } from "vitest";
import {
  MediaSelectionError,
  selectMediaFiles,
  type TorrentFile,
} from "../src/media-file-selection.js";
import { inspectionCacheSchema } from "../src/types.js";

const files: TorrentFile[] = [
  { id: 1, path: "Movie.sample.mkv", length: 50 },
  { id: 2, path: "Movie.mkv", length: 1_000 },
  { id: 3, path: "feature.mp4", length: 900 },
  { id: 4, path: "notes.txt", length: 2_000 },
];

describe("selectMediaFiles", () => {
  it("ignores samples and selects the largest playable movie", () => {
    expect(selectMediaFiles("movie", files)).toEqual([files[1]]);
  });

  it("honors a playable preferred TorrServer file id", () => {
    expect(selectMediaFiles("movie", files, 3)).toEqual([files[2]]);
    expect(() => selectMediaFiles("movie", files, 4)).toThrow(
      MediaSelectionError,
    );
  });

  it("preserves and orders series episodes", () => {
    const episodes = [
      { id: 2, path: "Show.S01E02.mkv", length: 100 },
      { id: 1, path: "Show.S01E01.mkv", length: 100 },
    ];
    expect(selectMediaFiles("series", episodes)).toMatchObject([
      { id: 1, season: 1, episode: 1 },
      { id: 2, season: 1, episode: 2 },
    ]);
  });

  it("applies series inclusion and episode overrides", () => {
    const episodes = [
      { id: 1, path: "Show.S01E01.mkv", length: 100 },
      { id: 2, path: "Show.S01E02.mkv", length: 100 },
    ];
    expect(
      selectMediaFiles("series", episodes, undefined, [
        { id: 1, included: false },
        { id: 2, included: true, season: 3, episode: 7 },
      ]),
    ).toMatchObject([{ id: 2, season: 3, episode: 7 }]);
  });
});

describe("season numbering edge cases", () => {
  const specials = [
    { id: 1, path: "Show.S00E01.Special.mkv", length: 100 },
    { id: 2, path: "Show.S00E02.Special.mkv", length: 100 },
  ];

  it("keeps season 0 for specials", () => {
    expect(selectMediaFiles("series", specials)).toEqual([
      {
        id: 1,
        path: "Show.S00E01.Special.mkv",
        length: 100,
        season: 0,
        episode: 1,
      },
      {
        id: 2,
        path: "Show.S00E02.Special.mkv",
        length: 100,
        season: 0,
        episode: 2,
      },
    ]);
  });

  it("survives the library schema, so the inspection cache can persist", () => {
    expect(
      inspectionCacheSchema.safeParse({
        hash: "abc",
        selectedFiles: selectMediaFiles("series", specials),
        inspectedAt: new Date().toISOString(),
      }).success,
    ).toBe(true);
  });

  it("does not read a resolution as a season and episode", () => {
    const [file] = selectMediaFiles("series", [
      { id: 1, path: "Show.Pilot.1920x1080.mkv", length: 100 },
    ]);
    expect(file).toMatchObject({ season: 1, episode: 1 });
  });

  it("applies a season 0 override instead of dropping it", () => {
    const [file] = selectMediaFiles(
      "series",
      [{ id: 1, path: "Show.Untitled.mkv", length: 100 }],
      undefined,
      [{ id: 1, included: true, season: 0, episode: 3 }],
    );
    expect(file).toMatchObject({ season: 0, episode: 3 });
  });
});

describe("extras exclusion", () => {
  it("prefers real episodes over bonus files that match the episode pattern", () => {
    const files = [
      {
        id: 0,
        path: "Pack/Featurettes/Season 2/Deleted Scenes/S02E05 The Mole.mkv",
        length: 2_193_861,
      },
      { id: 1, path: "Pack/Season 2/S02E05 The Mole.mkv", length: 800_000_000 },
      {
        id: 2,
        path: "Pack/Season 2/S02E06 Jake and Sophia.mkv",
        length: 799_000_000,
      },
    ];
    const selected = selectMediaFiles("series", files);
    expect(selected.map((f) => f.id)).toEqual([1, 2]);
    expect(
      selected.find((f) => f.season === 2 && f.episode === 5)?.length,
    ).toBe(800_000_000);
  });

  it("falls back to extras when nothing else is playable", () => {
    const files = [
      { id: 0, path: "Pack/Extras/S01E01 Featurette.mkv", length: 5_000_000 },
    ];
    expect(selectMediaFiles("series", files)).toHaveLength(1);
  });
});
