import { describe, expect, it } from "vitest";

globalThis.location = {
  pathname: "/manage/fixture-token",
} as Location;

const {
  describeGaps,
  mappingIssues,
  mappingPatch,
  mappingRows,
  shiftEpisodes,
} = await import("../assets/manage/views/episode-mapping.js");

const files = [
  { id: 1, path: "Show S01E01.mkv", length: 100 },
  { id: 2, path: "Show S01E02.mkv", length: 100 },
  { id: 3, path: "Sample.mkv", length: 5 },
  { id: 100_001, path: "Show S02E01.mkv", length: 100 },
];
const selected = [
  { id: 1, path: "Show S01E01.mkv", length: 100, season: 1, episode: 1 },
  { id: 2, path: "Show S01E02.mkv", length: 100, season: 1, episode: 2 },
  {
    id: 100_001,
    path: "Show S02E01.mkv",
    length: 100,
    season: 2,
    episode: 1,
    hash: "extra",
  },
];

describe("mappingRows", () => {
  it("marks selected files included and reads their current slot", () => {
    const rows = mappingRows(files, selected);
    expect(
      rows.map((row) => [row.id, row.included, row.season, row.episode]),
    ).toEqual([
      [1, true, 1, 1],
      [2, true, 1, 2],
      [3, false, 1, 3],
      [100_001, true, 2, 1],
    ]);
  });

  it("honours a saved include override", () => {
    const rows = mappingRows(files, selected, [{ id: 1, included: false }]);
    expect(rows[0]).toMatchObject({ id: 1, included: false });
  });
});

describe("shiftEpisodes", () => {
  const rows = mappingRows(files, selected);

  it("shifts only included rows that match", () => {
    const shifted = shiftEpisodes(rows, 1, (row) => row.season === 1);
    expect(shifted.map((row) => row.episode)).toEqual([2, 3, 3, 1]);
  });

  it("refuses to push an episode below 1", () => {
    expect(shiftEpisodes(rows, -1)).toBeNull();
    expect(shiftEpisodes(rows, -1, (row) => row.id === 2)).not.toBeNull();
  });

  it("is a no-op for zero or non-integer shifts", () => {
    expect(shiftEpisodes(rows, 0)).toBe(rows);
    expect(shiftEpisodes(rows, Number.NaN)).toBe(rows);
  });
});

describe("mappingIssues", () => {
  it("flags every row sharing an episode and lists gaps per season", () => {
    const rows = mappingRows(files, selected).map((row) =>
      row.id === 2 ? { ...row, episode: 1 } : row,
    );
    rows.push({
      id: 4,
      path: "Show S01E05.mkv",
      length: 100,
      included: true,
      season: 1,
      episode: 5,
    });
    const issues = mappingIssues(rows);
    expect([...issues.duplicates].sort()).toEqual([1, 2]);
    expect(issues.gaps).toEqual([{ season: 1, missing: [2, 3, 4] }]);
    expect(describeGaps(issues.gaps)).toBe("Season 1 skips episodes 2, 3, 4");
  });

  it("ignores excluded rows", () => {
    const rows = mappingRows(files, selected).map((row) =>
      row.id === 3 ? { ...row, episode: 1 } : row,
    );
    expect(mappingIssues(rows).duplicates.size).toBe(0);
    expect(mappingIssues(rows).gaps).toEqual([]);
  });
});

describe("mappingPatch", () => {
  const entry = {
    extraSources: [
      {
        magnetUri: "magnet:?xt=urn:btih:extra",
        managedMedia: true,
        sourceHash: "a".repeat(40),
        searchImport: { hash: "a".repeat(40) },
      },
    ],
  };
  const initial = mappingRows(files, selected);

  it("stores every included slot as an episode override by composite id", () => {
    const rows = initial.map((row) =>
      row.id === 1 ? { ...row, episode: 3 } : row,
    );
    expect(mappingPatch(rows, initial, entry)).toEqual({
      episodeOverrides: [
        { id: 1, season: 1, episode: 3 },
        { id: 2, season: 1, episode: 2 },
        { id: 100_001, season: 2, episode: 1 },
      ],
    });
  });

  it("routes inclusion changes to each source with raw ids and no server-owned fields", () => {
    const rows = initial.map((row) =>
      row.id === 100_001 ? { ...row, included: false } : row,
    );
    const patch = mappingPatch(rows, initial, entry);
    expect(patch.fileOverrides).toEqual([
      { id: 1, included: true },
      { id: 2, included: true },
      { id: 3, included: false },
    ]);
    expect(patch.extraSources).toEqual([
      {
        magnetUri: "magnet:?xt=urn:btih:extra",
        fileOverrides: [{ id: 1, included: false }],
      },
    ]);
    expect(patch.episodeOverrides).toHaveLength(2);
  });
});
