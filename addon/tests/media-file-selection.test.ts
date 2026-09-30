import { describe, expect, it } from "vitest";
import {
  compositeFileId,
  fileSourceIndex,
  mergeSelectedFiles,
  MediaSelectionError,
  parseEpisodeNumbers,
  rawFileId,
  remapFileId,
  selectMediaFiles,
  type TorrentFile,
} from "../src/media-file-selection.ts";
import { inspectionCacheSchema } from "../src/types.ts";

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

  it("re-homes ids when sources move and drops removed sources", () => {
    expect(remapFileId(7, [2, 1, 0])).toBe(200_007);
    expect(remapFileId(200_007, [2, 1, 0])).toBe(7);
    expect(remapFileId(100_007, [0, undefined, 1])).toBeUndefined();
    expect(remapFileId(300_007, [0])).toBeUndefined();
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
      { seasonHint: 3 },
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
      { seasonHint: 9, episodeHint: 4 },
    );
    expect(selected[0]).toMatchObject({ season: 2, episode: 5 });
  });
});

describe("parseEpisodeNumbers", () => {
  it.each([
    ["Show.S02E05.1080p.mkv", 2, 5],
    ["Show S02 E05.mkv", 2, 5],
    ["Show.S02.E05.mkv", 2, 5],
    ["Show 2x05.mkv", 2, 5],
    ["Show Season 2 Episode 5.mkv", 2, 5],
    ["Show.S02E05-E06.mkv", 2, 5],
    ["Show.S02.1080p/Show.S02E07.mkv", 2, 7],
    ["S03E01/video.mkv", 3, 1],
  ])("reads explicit numbering from %s", (path, season, episode) => {
    expect(parseEpisodeNumbers(path)).toEqual({
      season,
      episode,
      explicit: true,
    });
  });

  it.each([
    ["Show/Episode 5.mkv", undefined, 5],
    ["Show/Ep.05.mkv", undefined, 5],
    ["Show/Show E05 Title.mkv", undefined, 5],
    ["[Group] Show - 05 [1080p].mkv", undefined, 5],
    ["[Group] Show - 05v2 (1080p).mkv", undefined, 5],
    ["Show/05 - Title.mkv", undefined, 5],
    ["Show/05.mkv", undefined, 5],
    ["Show/Season 2/05.mkv", 2, 5],
    ["Show.S02.1080p.WEB/Show - 05.mkv", 2, 5],
    ["Show Series 3/Pilot.mkv", 3, undefined],
  ])("guesses loose numbering from %s", (path, season, episode) => {
    expect(parseEpisodeNumbers(path)).toEqual({
      ...(season === undefined ? {} : { season }),
      ...(episode === undefined ? {} : { episode }),
      explicit: false,
    });
  });

  it.each([
    "Show.Pilot.1920x1080.mkv",
    "Show.2019.1080p.WEB-DL.DDP5.1.H.264.mkv",
    "Show - 720p.mkv",
    "9-1-1 Pilot.mkv",
    "Deep Space.mkv",
  ])("finds no episode number in %s", (path) => {
    expect(parseEpisodeNumbers(path).episode).toBeUndefined();
  });
});

describe("loose numbering in selectMediaFiles", () => {
  it("numbers an unlabeled pack from its season folder and episode names", () => {
    const selected = selectMediaFiles("series", [
      { id: 1, path: "Show/Season 2/02 - Second.mkv", length: 100 },
      { id: 2, path: "Show/Season 2/01 - First.mkv", length: 100 },
      { id: 3, path: "Show/Season 2/10 - Tenth.mkv", length: 100 },
    ]);
    expect(selected.map((f) => [f.id, f.season, f.episode])).toEqual([
      [2, 2, 1],
      [1, 2, 2],
      [3, 2, 10],
    ]);
  });

  it("falls back to positions when guessed numbers collide", () => {
    const selected = selectMediaFiles("series", [
      { id: 1, path: "12 Monkeys Pilot.mkv", length: 100 },
      { id: 2, path: "12 Monkeys Splinter.mkv", length: 100 },
    ]);
    expect(selected.map((f) => [f.id, f.episode])).toEqual([
      [1, 1],
      [2, 2],
    ]);
  });
});

describe("episodeHint", () => {
  it("makes a single-episode torrent exactly that episode", () => {
    const selected = selectMediaFiles(
      "series",
      [
        { id: 0, path: "Show.720p.WEB/Show.720p.mkv", length: 100 },
        { id: 1, path: "Show.720p.WEB/Sample/sample.mkv", length: 5 },
      ],
      undefined,
      [],
      { seasonHint: 2, episodeHint: 7 },
    );
    expect(selected).toMatchObject([{ id: 0, season: 2, episode: 7 }]);
  });

  it("numbers a continuation pack upward from the hint, over guessed numbers", () => {
    const selected = selectMediaFiles(
      "series",
      [
        { id: 1, path: "Pack/01.mkv", length: 100 },
        { id: 2, path: "Pack/02.mkv", length: 100 },
        { id: 3, path: "Pack/03.mkv", length: 100 },
      ],
      undefined,
      [],
      { episodeHint: 13 },
    );
    expect(selected.map((f) => [f.season, f.episode])).toEqual([
      [1, 13],
      [1, 14],
      [1, 15],
    ]);
  });

  it("lets a season hint beat a season guessed from the path", () => {
    const [file] = selectMediaFiles(
      "series",
      [{ id: 1, path: "Show.S02.1080p/Episode 3.mkv", length: 100 }],
      undefined,
      [],
      { seasonHint: 4 },
    );
    expect(file).toMatchObject({ season: 4, episode: 3 });
  });

  it("never beats a per-file override", () => {
    const [file] = selectMediaFiles(
      "series",
      [{ id: 1, path: "Show.mkv", length: 100 }],
      undefined,
      [{ id: 1, included: true, season: 1, episode: 9 }],
      { seasonHint: 2, episodeHint: 3 },
    );
    expect(file).toMatchObject({ season: 1, episode: 9 });
  });

  it("merges a single-episode torrent into its own slot", () => {
    const pack = selectMediaFiles("series", [
      { id: 0, path: "Show.S01E01.mkv", length: 100 },
      { id: 1, path: "Show.S01E02.mkv", length: 100 },
    ]);
    const single = selectMediaFiles(
      "series",
      [{ id: 0, path: "Show.Finale.1080p.mkv", length: 100 }],
      undefined,
      [],
      { seasonHint: 1, episodeHint: 3 },
    );
    const merged = mergeSelectedFiles([
      { hash: "a".repeat(40), selectedFiles: pack },
      { hash: "b".repeat(40), selectedFiles: single },
    ]);
    expect(merged.map((f) => [f.id, f.season, f.episode])).toEqual([
      [0, 1, 1],
      [1, 1, 2],
      [100_000, 1, 3],
    ]);
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
