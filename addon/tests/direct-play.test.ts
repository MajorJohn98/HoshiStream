import { describe, expect, it } from "vitest";
import {
  assessDirectPlay,
  browserSupport,
  directPlayLabel,
} from "../src/direct-play.ts";

const common = {
  container: "mov",
  videoCodec: "h264",
  audioCodec: "aac",
  videoProfile: "Main",
  pixelFormat: "yuv420p",
};

describe("direct play assessment", () => {
  it("treats a common H.264 + AAC MP4 as direct play", () => {
    const result = assessDirectPlay({
      ...common,
      bitrateMbps: 8,
    });

    expect(result.compatibility).toBe("direct");
    expect(result.warnings).toEqual([]);
    expect(directPlayLabel(result)).toBeUndefined();
  });

  it("keeps DTS support advice separate from torrent availability", () => {
    const result = assessDirectPlay({
      videoCodec: "h264",
      audioCodec: "dts",
    });

    expect(result.compatibility).toBe("risky");
    expect(result.warnings[0]).toContain("dts");
    expect(directPlayLabel(result)).toMatch(/^Check player: /);
    expect(result.warnings[0]).toContain(
      "does not measure torrent availability",
    );
  });

  it("flags codecs that only newer devices decode as caution", () => {
    const result = assessDirectPlay({
      container: "webm",
      videoCodec: "av1",
      audioCodec: "opus",
      pixelFormat: "yuv420p",
    });

    expect(result.compatibility).toBe("caution");
    expect(directPlayLabel(result)).toMatch(/^Check player: /);
  });

  it("does not downgrade a risky verdict to caution", () => {
    const result = assessDirectPlay({
      videoCodec: "av1",
      audioCodec: "truehd",
    });

    expect(result.compatibility).toBe("risky");
    expect(result.warnings.some((warning) => warning.includes("truehd"))).toBe(
      true,
    );
    expect(result.warnings.some((warning) => warning.includes("av1"))).toBe(
      true,
    );
  });

  it("does not turn average bitrate into a universal playback verdict", () => {
    expect(assessDirectPlay({ ...common, bitrateMbps: 80 }).compatibility).toBe(
      "direct",
    );
    expect(assessDirectPlay({ bitrateMbps: 20 }).compatibility).toBe("unknown");
  });

  it("tolerates a probe that reported nothing useful", () => {
    const result = assessDirectPlay({});

    expect(result.compatibility).toBe("unknown");
    expect(result.probedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("does not certify codec families without profile and bit-depth evidence", () => {
    expect(browserSupport({ ...common, pixelFormat: undefined })).toBe(
      "unknown",
    );
    expect(browserSupport({ ...common, videoProfile: undefined })).toBe(
      "unknown",
    );
    expect(browserSupport({ ...common, pixelFormat: "yuv420p10le" })).toBe(
      "limited",
    );
    expect(
      browserSupport({ ...common, videoProfile: "High 4:4:4 Predictive" }),
    ).toBe("limited");
    expect(browserSupport({ ...common, videoLevel: 62 })).toBe("limited");
  });

  it("does not equate the shared Matroska demuxer with WebM", () => {
    expect(
      browserSupport({
        container: "matroska",
        containerAliases: ["matroska", "webm"],
        videoCodec: "vp9",
        audioCodec: "opus",
        pixelFormat: "yuv420p",
      }),
    ).toBe("unknown");
    expect(browserSupport({ ...common, container: "matroska" })).toBe(
      "limited",
    );
  });

  it("keeps format restrictions separate from native-player codec advice", () => {
    for (const audioCodec of ["ac3", "eac3", "dts"]) {
      expect(browserSupport({ ...common, audioCodec })).toBe("limited");
    }
    expect(browserSupport({ ...common, videoCodec: "hevc" })).toBe("limited");
    expect(
      browserSupport({
        ...common,
        audioCodecs: ["aac", "unknown"],
        audioTracks: 2,
      }),
    ).toBe("limited");
    expect(browserSupport({ ...common, audioCodec: undefined })).toBe(
      "unknown",
    );
    expect(
      browserSupport({ ...common, audioCodec: undefined, audioTracks: 0 }),
    ).toBe("likely");
  });
});
