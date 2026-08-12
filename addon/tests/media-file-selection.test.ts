import { describe, expect, it } from "vitest";
import {
  MediaSelectionError,
  selectMediaFiles,
  type TorrentFile,
} from "../src/media-file-selection.js";

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
