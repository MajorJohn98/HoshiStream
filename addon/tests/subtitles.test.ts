import { describe, expect, it } from "vitest";
import {
  decodeSubtitleBytes,
  isSubtitlePath,
  matchSubtitles,
  servedExtension,
  srtToVtt,
  subtitleContentType,
  subtitleFormat,
  subtitleLanguage,
} from "../src/subtitles.ts";

const file = (id: number, path: string) => ({ id, path, length: 1000 });

describe("subtitle detection", () => {
  it("recognizes the four sidecar formats case-insensitively", () => {
    expect(subtitleFormat("Movie.srt")).toBe("srt");
    expect(subtitleFormat("Movie.VTT")).toBe("vtt");
    expect(subtitleFormat("Subs/Movie.ass")).toBe("ass");
    expect(subtitleFormat("Movie.ssa")).toBe("ssa");
    expect(subtitleFormat("Movie.mkv")).toBeUndefined();
    expect(subtitleFormat("Movie.sub")).toBeUndefined();
    expect(isSubtitlePath("a/b/c.srt")).toBe(true);
  });

  it("serves SRT as WebVTT and the others unchanged", () => {
    expect(servedExtension("srt")).toBe("vtt");
    expect(servedExtension("vtt")).toBe("vtt");
    expect(servedExtension("ass")).toBe("ass");
    expect(subtitleContentType("vtt")).toBe("text/vtt; charset=utf-8");
    expect(subtitleContentType("ass")).toBe("text/x-ssa; charset=utf-8");
  });
});

describe("matchSubtitles", () => {
  const video = { path: "Movie.2019.1080p/Movie.2019.1080p.mkv" };

  it("matches by basename with language and flag suffixes in any folder", () => {
    const matches = matchSubtitles(video, [
      file(2, "Movie.2019.1080p/Movie.2019.1080p.en.srt"),
      file(3, "Movie.2019.1080p/Subs/Movie.2019.1080p.rus.srt"),
      file(4, "Movie.2019.1080p/Movie.2019.1080p.eng.forced.srt"),
      file(5, "Movie.2019.1080p/Movie.2019.1080p.en.sdh.srt"),
      file(6, "Movie.2019.1080p/Movie.2019.1080p.srt"),
      file(7, "Movie.2019.1080p/Movie.2019.1080p.mkv"),
      file(8, "Movie.2019.1080p/Other.Film.en.srt"),
      file(9, "Movie.2019.1080p/Movie.2019.1080p.commentary.srt"),
    ]);
    expect(
      matches.map((match) => [match.file.id, match.lang, match.label]),
    ).toEqual([
      [2, "eng", "English"],
      [5, "eng", "English (SDH)"],
      [4, "eng", "English (forced)"],
      [3, "rus", "Russian"],
      [6, "und", "Unknown language"],
    ]);
    expect(matches.find((match) => match.file.id === 4)?.flags).toEqual([
      "forced",
    ]);
  });

  it("does not let a prefix match swallow a different title", () => {
    expect(
      matchSubtitles({ path: "Show S01E01.mkv" }, [
        file(1, "Show S01E010.en.srt"),
        file(2, "Show S01E01.en.srt"),
      ]).map((match) => match.file.id),
    ).toEqual([2]);
  });

  it("claims every sidecar for a sole video and reads the language from the name", () => {
    const matches = matchSubtitles(
      video,
      [
        file(1, "Subs/2_English.srt"),
        file(2, "Subs/Spanish.srt"),
        file(3, "Subs/3_French-forced.srt"),
        file(4, "Subs/Unknown.srt"),
        file(5, "Movie.2019.1080p.nfo"),
      ],
      { soleVideo: true },
    );
    expect(
      matches.map((match) => [match.file.id, match.lang, match.label]),
    ).toEqual([
      [1, "eng", "English"],
      [3, "fre", "French (forced)"],
      [2, "spa", "Spanish"],
      [4, "und", "Unknown language"],
    ]);
  });

  it("keeps sole-video matching off for series episodes", () => {
    expect(
      matchSubtitles({ path: "Show/Show.S01E02.mkv" }, [
        file(1, "Show/Subs/Show.S01E01.en.srt"),
        file(2, "Show/Subs/Show.S01E02.en.srt"),
      ]).map((match) => match.file.id),
    ).toEqual([2]);
  });

  it("treats hi as Hindi in the language slot and as SDH after one", () => {
    const [hindi] = matchSubtitles(video, [file(1, "Movie.2019.1080p.hi.srt")]);
    expect(hindi?.lang).toBe("hin");
    const [sdh] = matchSubtitles(video, [
      file(1, "Movie.2019.1080p.en.hi.srt"),
    ]);
    expect(sdh?.lang).toBe("eng");
    expect(sdh?.flags).toEqual(["sdh"]);
  });

  it("guesses a decoding language from the sidecar name", () => {
    expect(subtitleLanguage("Subs/Movie.rus.srt")).toBe("rus");
    expect(subtitleLanguage("Movie.srt")).toBeUndefined();
  });
});

describe("srtToVtt", () => {
  it("converts comma decimals, drops counters, and strips a BOM", () => {
    const srt =
      "\uFEFF1\r\n00:00:01,000 --> 00:00:02,500\r\nHello\r\n\r\n2\r\n00:00:03,000 --> 00:00:04,000\r\nWorld\r\nagain\r\n";
    expect(srtToVtt(srt)).toBe(
      "WEBVTT\n\n00:00:01.000 --> 00:00:02.500\nHello\n\n00:00:03.000 --> 00:00:04.000\nWorld\nagain\n",
    );
  });

  it("normalizes short or odd timestamps and drops SRT positioning", () => {
    const srt =
      "1\n0:01:02,5 --> 1:02:03,45 X1:100 X2:200\nText\n\n2\n00:05,000 --> 00:06\nNo hours\n";
    expect(srtToVtt(srt)).toBe(
      "WEBVTT\n\n00:01:02.500 --> 01:02:03.450\nText\n\n00:00:05.000 --> 00:00:06.000\nNo hours\n",
    );
  });

  it("skips malformed cues without failing the file", () => {
    const srt =
      "1\n00:00:01,000 --> 00:00:02,000\nGood\n\n2\nnot a timestamp\nBad\n\n3\n00:00:09,000 --> 00:00:05,000\nBackwards\n\n4\n00:00:70,000 --> 00:00:71,000\nOver sixty\n\n5\n00:00:10,000 --> 00:00:11,000\n\n\n6\n00:00:12,000 --> 00:00:13,000\n{\\an8}Top line\n";
    expect(srtToVtt(srt)).toBe(
      "WEBVTT\n\n00:00:01.000 --> 00:00:02.000\nGood\n\n00:00:12.000 --> 00:00:13.000\nTop line\n",
    );
  });

  it("passes WebVTT input through untouched", () => {
    const vtt = "WEBVTT\n\n00:00:01.000 --> 00:00:02.000\nHi\n";
    expect(srtToVtt(vtt)).toBe(vtt);
    expect(srtToVtt("WEBVTT")).toBe("WEBVTT\n");
  });

  it("yields an empty but valid file for empty input", () => {
    expect(srtToVtt("")).toBe("WEBVTT\n\n");
  });
});

describe("decodeSubtitleBytes", () => {
  it("decodes UTF-8 and UTF-16 with BOMs", () => {
    expect(decodeSubtitleBytes(Buffer.from("\uFEFFПривет", "utf8"))).toBe(
      "Привет",
    );
    const utf16 = Buffer.concat([
      Buffer.from([0xff, 0xfe]),
      Buffer.from("Hi", "utf16le"),
    ]);
    expect(decodeSubtitleBytes(utf16)).toBe("Hi");
  });

  it("falls back to windows-1251 for Cyrillic languages and 1252 otherwise", () => {
    // "Привет" in windows-1251.
    const cp1251 = Buffer.from([0xcf, 0xf0, 0xe8, 0xe2, 0xe5, 0xf2]);
    expect(decodeSubtitleBytes(cp1251, "rus")).toBe("Привет");
    // "café" in windows-1252.
    const cp1252 = Buffer.from([0x63, 0x61, 0x66, 0xe9]);
    expect(decodeSubtitleBytes(cp1252)).toBe("café");
    expect(decodeSubtitleBytes(cp1252, "eng")).toBe("café");
  });
});
