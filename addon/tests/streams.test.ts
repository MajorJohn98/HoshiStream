import { describe, expect, it } from "vitest";
import {
  resolvePublicUrls,
  rewritePublicUrl,
  streamBehaviorHints,
} from "../src/streams.js";

const fallback = {
  addonUrl: "http://192.168.1.50:7000",
  torrServerUrl: "http://192.168.1.50:8090",
};

describe("resolvePublicUrls", () => {
  it("derives both origins from the request host", () => {
    expect(resolvePublicUrls("192.168.1.77:7000", fallback)).toEqual({
      addonUrl: "http://192.168.1.77:7000",
      torrServerUrl: "http://192.168.1.77:8090",
    });
  });

  it("falls back when the host header is missing or invalid", () => {
    expect(resolvePublicUrls(undefined, fallback)).toEqual(fallback);
    expect(resolvePublicUrls("bad host:99999", fallback)).toEqual(fallback);
  });

  it("falls back for Docker-internal hostnames", () => {
    expect(resolvePublicUrls("torrserver:8090", fallback)).toEqual(fallback);
    expect(resolvePublicUrls("addon:7000", fallback)).toEqual(fallback);
  });
});

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
