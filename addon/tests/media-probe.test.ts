import { describe, expect, it } from "vitest";
import { summarizeProbe } from "../src/media-probe.js";

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
});
