import { describe, expect, it } from "vitest";

globalThis.location = {
  pathname: "/manage/fixture-token",
} as Location;

const {
  dateFromReleased,
  episodeKey,
  episodesPatch,
  releasedFromDate,
  thumbnailSummary,
} = await import("../assets/manage/views/episodes.js");

describe("episode form helpers", () => {
  it("round-trips dates between the input and the stored ISO value", () => {
    expect(releasedFromDate("2024-01-05")).toBe("2024-01-05T00:00:00.000Z");
    expect(releasedFromDate("")).toBeUndefined();
    expect(releasedFromDate(undefined)).toBeUndefined();
    expect(() => releasedFromDate("05/01/2024")).toThrow(/YYYY-MM-DD/);
    expect(() => releasedFromDate("2024-13-45")).toThrow(/valid date/);
    expect(dateFromReleased("2024-01-05T00:00:00.000Z")).toBe("2024-01-05");
    expect(dateFromReleased(undefined)).toBe("");
    expect(episodeKey(1, 2)).toBe("1:2");
  });

  it("builds the episodes map from flat fields and keeps unseen seasons", () => {
    const shown = [
      { season: 2, episode: 1 },
      { season: 2, episode: 2 },
    ];
    const existing = {
      "1:1": { title: "Pilot" },
      "2:2": { title: "Old", overview: "gone" },
    };
    expect(
      episodesPatch(
        {
          "title:2:1": "  Opener ",
          "overview:2:1": "",
          "released:2:1": "2024-03-01",
          "title:2:2": "",
          "overview:2:2": "   ",
          "released:2:2": "",
        },
        shown,
        existing,
      ),
    ).toEqual({
      episodes: {
        "1:1": { title: "Pilot" },
        "2:1": { title: "Opener", released: "2024-03-01T00:00:00.000Z" },
      },
    });
    // Everything blank and nothing elsewhere → null clears the field.
    expect(episodesPatch({}, shown, {})).toEqual({ episodes: null });
    expect(episodesPatch({}, shown, undefined)).toEqual({ episodes: null });
  });

  it("summarises thumbnail state for the tab", () => {
    expect(thumbnailSummary(null, 3, 0)).toMatch(/unavailable/);
    expect(
      thumbnailSummary({ running: true, generated: 0, failed: 0 }, 3, 0),
    ).toBe("Generating thumbnails…");
    expect(
      thumbnailSummary({ running: false, generated: 0, failed: 0 }, 0, 0),
    ).toMatch(/never from a live torrent/);
    expect(
      thumbnailSummary({ running: false, generated: 2, failed: 0 }, 3, 2),
    ).toBe("2 of 3 on-disk episodes have a thumbnail.");
    expect(
      thumbnailSummary(
        { running: false, generated: 0, failed: 1, lastError: "boom" },
        1,
        0,
      ),
    ).toBe("0 of 1 on-disk episode has a thumbnail · 1 failed: boom.");
  });
});
