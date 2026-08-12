import { describe, expect, it } from "vitest";
import { rewritePublicUrl, streamBehaviorHints } from "../src/streams.js";

describe("rewritePublicUrl", () => {
  it("replaces Docker-internal origin and preserves the playback path", () => {
    expect(
      rewritePublicUrl(
        "http://torrserver:8090/play/abc/2",
        "http://192.168.1.50:8090",
      ),
    ).toBe("http://192.168.1.50:8090/play/abc/2");
  });

  it("adds Stremio subtitle and binge-watching hints", () => {
    expect(
      streamBehaviorHints("hoshi:test", {
        id: 1,
        path: "Show.S01E01.mkv",
        length: 1_000,
      }),
    ).toEqual({
      filename: "Show.S01E01.mkv",
      videoSize: 1_000,
      bingeGroup: "hoshistream-hoshi:test",
    });
  });
});
