import { describe, expect, it } from "vitest";
import { assessDirectPlay, directPlayLabel } from "../src/direct-play.js";

describe("direct play assessment", () => {
  it("treats a common H.264 + AAC MP4 as direct play", () => {
    const result = assessDirectPlay({
      container: "mov",
      videoCodec: "h264",
      audioCodec: "aac",
      bitrateMbps: 8,
    });

    expect(result.compatibility).toBe("direct");
    expect(result.warnings).toEqual([]);
    expect(directPlayLabel(result)).toBeUndefined();
  });

  it("flags DTS audio as the usual cause of stutter", () => {
    const result = assessDirectPlay({
      videoCodec: "h264",
      audioCodec: "dts",
    });

    expect(result.compatibility).toBe("risky");
    expect(result.warnings[0]).toContain("dts");
    expect(directPlayLabel(result)).toMatch(/^May stutter: /);
  });

  it("flags codecs that only newer devices decode as caution", () => {
    const result = assessDirectPlay({ videoCodec: "av1", audioCodec: "aac" });

    expect(result.compatibility).toBe("caution");
    expect(directPlayLabel(result)).toMatch(/^Check: /);
  });

  it("does not downgrade a risky verdict to caution", () => {
    const result = assessDirectPlay({
      videoCodec: "av1",
      audioCodec: "truehd",
    });

    expect(result.compatibility).toBe("risky");
    expect(result.warnings).toHaveLength(2);
  });

  it("warns when sustained bitrate exceeds the measured link", () => {
    const result = assessDirectPlay({ bitrateMbps: 80 }, 100);

    expect(result.compatibility).toBe("risky");
    expect(result.warnings[0]).toContain("120.0 Mbps");
  });

  it("stays quiet when the link has enough headroom", () => {
    expect(assessDirectPlay({ bitrateMbps: 20 }, 100).compatibility).toBe(
      "direct",
    );
  });

  it("tolerates a probe that reported nothing useful", () => {
    const result = assessDirectPlay({});

    expect(result.compatibility).toBe("direct");
    expect(result.probedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });
});
