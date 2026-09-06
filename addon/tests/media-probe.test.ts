import { describe, expect, it } from "vitest";
import { summarizeProbe } from "../src/media-probe.ts";

describe("media probe summary", () => {
  it("calculates a recommended speed with 50% headroom", () => {
    const summary = summarizeProbe(
      {
        format: { duration: "100", bit_rate: "4000000", format_name: "mp4" },
        streams: [
          {
            codec_type: "video",
            codec_name: "hevc",
            width: 1920,
            height: 1080,
          },
          { codec_type: "audio", codec_name: "aac" },
        ],
      },
      50_000_000,
    );
    expect(summary).toMatchObject({
      bitrateMbps: 4,
      recommendedMbps: 6,
      videoCodec: "hevc",
      audioCodec: "aac",
      width: 1920,
      height: 1080,
    });
  });

  it("does not publish non-finite or negative probe measurements", () => {
    const summary = summarizeProbe(
      {
        format: { duration: "Infinity", bit_rate: "Infinity" },
        streams: [{ codec_type: "video", width: 0, height: 0 }],
      },
      100,
    );
    expect(summary.durationSeconds).toBeUndefined();
    expect(summary.bitrateMbps).toBeUndefined();
    expect(summary.width).toBeUndefined();
    expect(summary.height).toBeUndefined();
  });
});
