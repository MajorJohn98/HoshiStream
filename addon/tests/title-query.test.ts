import { describe, expect, it } from "vitest";
import { normalizeTitle, releaseYear, titleQuery } from "../src/title-query.ts";

describe("titleQuery", () => {
  it.each([
    ["Severance.S01.1080p.WEB-DL.DDP5.1.H.264-NTb", "Severance", undefined],
    [
      "[SubsPlease] Frieren - Beyond Journey's End (1080p)",
      "Frieren - Beyond Journey's End",
      undefined,
    ],
    ["The.Bear.2022.S02.COMPLETE.2160p", "The Bear", 2022],
    ["Dune Part Two (2024) 2160p HDR", "Dune Part Two", 2024],
    ["Movie.Title.2021.2160p.UHD", "Movie Title", 2021],
    ["Andor S01E01-E03", "Andor", undefined],
    ["The Office (US) Season 1-9", "The Office", undefined],
    ["Oppenheimer.2023.IMAX.1080p.BluRay.x265-RARBG", "Oppenheimer", 2023],
    ["My Show", "My Show", undefined],
    ["www.Site.com - Cool Movie 2020 720p", "Cool Movie", 2020],
    ["Better Call Saul Complete Series", "Better Call Saul", undefined],
    ["Show 3x07", "Show", undefined],
  ])("cleans %s", (name, title, year) => {
    expect(titleQuery(name)).toEqual(
      year === undefined ? { title } : { title, year },
    );
  });

  it("keeps a title that is itself a year", () => {
    expect(titleQuery("2012 (2009) 1080p")).toEqual({
      title: "2012",
      year: 2009,
    });
    expect(titleQuery("1917 2019 1080p")).toEqual({
      title: "1917",
      year: 2019,
    });
    expect(titleQuery("1917")).toEqual({ title: "1917" });
  });

  it("keeps unicode titles and caps the length", () => {
    expect(titleQuery("進撃の巨人 S01 1080p")).toEqual({ title: "進撃の巨人" });
    expect(titleQuery("Les Misérables (2012) 1080p")).toEqual({
      title: "Les Misérables",
      year: 2012,
    });
    const long = "Word ".repeat(60).trim();
    expect(titleQuery(long).title.length).toBeLessThanOrEqual(120);
  });

  it("falls back to the raw name when nothing survives", () => {
    expect(titleQuery("1080p.WEB-DL").title).toBe("1080p WEB-DL");
  });
});

describe("normalizeTitle", () => {
  it("ignores case, accents, punctuation and a leading article", () => {
    expect(normalizeTitle("The Bear")).toBe("bear");
    expect(normalizeTitle("Les Misérables!")).toBe("les miserables");
    expect(normalizeTitle("Mr. & Mrs. Smith")).toBe("mr and mrs smith");
    expect(normalizeTitle("A Quiet Place")).toBe("quiet place");
  });
});

describe("releaseYear", () => {
  it("reads the leading year", () => {
    expect(releaseYear("2022–")).toBe(2022);
    expect(releaseYear("2019-2021")).toBe(2019);
    expect(releaseYear("2019")).toBe(2019);
    expect(releaseYear(undefined)).toBeUndefined();
    expect(releaseYear("n/a")).toBeUndefined();
  });
});
