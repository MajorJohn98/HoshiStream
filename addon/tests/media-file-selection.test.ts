import { describe, expect, it } from "vitest";
import {
  compositeFileId,
  fileSourceIndex,
  mergeSelectedFiles,
  MediaSelectionError,
  rawFileId,
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

describe("composite file ids", () => {
  it("round-trips source index and raw id", () => {
    expect(compositeFileId(0, 7)).toBe(7);
    expect(compositeFileId(2, 7)).toBe(200_007);
    expect(rawFileId(200_007)).toBe(7);
    expect(fileSourceIndex(200_007)).toBe(2);
    expect(fileSourceIndex(7)).toBe(0);
  });
});

describe("seasonHint", () => {
  it("fills the season for files whose names do not parse", () => {
    const selected = selectMediaFiles(
      "series",
      [
        { id: 1, path: "Show/Episode 1.mkv", length: 100 },
        { id: 2, path: "Show/Episode 2.mkv", length: 100 },
      ],
      undefined,
      [],
      3,
    );
    expect(selected.map((f) => [f.season, f.episode])).toEqual([
      [3, 1],
      [3, 2],
    ]);
  });

  it("never overrides a season parsed from the filename", () => {
    const selected = selectMediaFiles(
      "series",
      [{ id: 1, path: "Show S02E05.mkv", length: 100 }],
      undefined,
      [],
      9,
    );
    expect(selected[0]).toMatchObject({ season: 2, episode: 5 });
  });
});

describe("mergeSelectedFiles", () => {
  const pack = {
    hash: "hash-a",
    selectedFiles: [
      { id: 1, path: "S01E01.mkv", length: 100, season: 1, episode: 1 },
      { id: 2, path: "S01E02.mkv", length: 100, season: 1, episode: 2 },
    ],
  };
  const seasonTwo = {
    hash: "hash-b",
    selectedFiles: [
      { id: 1, path: "S02E01.mkv", length: 100, season: 2, episode: 1 },
    ],
  };

  it("merges sources with composite ids and per-source hashes", () => {
    const merged = mergeSelectedFiles([pack, seasonTwo]);
    expect(merged).toEqual([
      { id: 1, path: "S01E01.mkv", length: 100, season: 1, episode: 1 },
      { id: 2, path: "S01E02.mkv", length: 100, season: 1, episode: 2 },
      {
        id: 100_001,
        path: "S02E01.mkv",
        length: 100,
        season: 2,
        episode: 1,
        hash: "hash-b",
      },
    ]);
  });

  it("keeps primary-source files unchanged for cache compatibility", () => {
    const merged = mergeSelectedFiles([pack]);
    expect(merged).toEqual(pack.selectedFiles);
  });

  it("lets a later source replace an episode", () => {
    const replacement = {
      hash: "hash-c",
      selectedFiles: [
        {
          id: 4,
          path: "Better S01E02.mkv",
          length: 999,
          season: 1,
          episode: 2,
        },
      ],
    };
    const merged = mergeSelectedFiles([pack, replacement]);
    expect(merged).toHaveLength(2);
    expect(merged[1]).toMatchObject({
      id: 100_004,
      path: "Better S01E02.mkv",
      hash: "hash-c",
    });
  });

  it("keeps movie selections without episode numbers", () => {
    const merged = mergeSelectedFiles([
      { hash: "m", selectedFiles: [{ id: 3, path: "Movie.mkv", length: 5 }] },
    ]);
    expect(merged).toEqual([{ id: 3, path: "Movie.mkv", length: 5 }]);
  });
});
