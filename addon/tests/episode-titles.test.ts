import { describe, expect, it } from "vitest";
import {
  cleanEpisodeTitle,
  episodeOverrideFor,
  episodeTitle,
} from "../src/episode-titles.ts";
import type { LibraryEntry, SelectedFile } from "../src/types.ts";

describe("cleanEpisodeTitle", () => {
  it.each([
    [
      "Show.S01E01.Winter.Is.Coming.1080p.x264-GRP.mkv",
      1,
      1,
      "Winter Is Coming",
    ],
    ["Show - S01E01 - Pilot.mkv", 1, 1, "Pilot"],
    [
      "Show/Season 1/Show - 1x02 - The Kingsroad [WEB-DL].mkv",
      1,
      2,
      "The Kingsroad",
    ],
    ["Show.S01E01.1080p.WEB-DL.mkv", 1, 1, "Episode 1"],
    ["[SubsPlease] Frieren - 01 (1080p) [ABCD].mkv", 1, 1, "Episode 1"],
    ["Show.S02E10.Part.Two.HDR.2160p.mkv", 2, 10, "Part Two"],
    ["Show S01E03 12 Monkeys.mkv", 1, 3, "12 Monkeys"],
  ])("%s → %s", (path, season, episode, expected) => {
    expect(cleanEpisodeTitle(path, season, episode)).toBe(expected);
  });

  it("falls back to the cleaned file name when nothing else fits", () => {
    expect(cleanEpisodeTitle("Some Special Feature.mkv")).toBe(
      "Some Special Feature",
    );
    expect(cleanEpisodeTitle("Show.S01E04.mkv")).toBe("Episode 4");
  });
});

describe("episodeTitle / episodeOverrideFor", () => {
  const file: SelectedFile = {
    id: 1,
    path: "Show/Show.S01E01.Winter.Is.Coming.mkv",
    length: 10,
    season: 1,
    episode: 1,
  };
  const entry = { episodes: { "1:1": { title: "Custom" } } } as LibraryEntry;

  it("prefers the stored override and cleans otherwise", () => {
    expect(episodeTitle(entry, file)).toBe("Custom");
    expect(episodeTitle({} as LibraryEntry, file)).toBe("Winter Is Coming");
    expect(episodeOverrideFor(entry.episodes, file)).toEqual({
      title: "Custom",
    });
    expect(episodeOverrideFor(entry.episodes, { ...file, episode: 2 })).toBe(
      undefined,
    );
    expect(episodeOverrideFor(undefined, file)).toBe(undefined);
  });
});
