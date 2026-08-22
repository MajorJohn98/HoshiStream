import { describe, expect, it } from "vitest";
import {
  compatibleStreams,
  resolveClientAwareUrls,
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

  it("keeps the TorrServer port while taking the requested hostname", () => {
    expect(resolvePublicUrls("hoshi.example.com", fallback)).toEqual({
      addonUrl: "http://hoshi.example.com",
      torrServerUrl: "http://hoshi.example.com:8090",
    });
  });

  it("falls back when the host header has no hostname", () => {
    expect(resolvePublicUrls(":7000", fallback)).toEqual(fallback);
  });
});

describe("resolveClientAwareUrls", () => {
  const tunnelHost = "hoshi.example.com";
  const tunnelUrls = {
    addonUrl: "http://hoshi.example.com",
    torrServerUrl: "http://hoshi.example.com:8090",
  };

  it("returns LAN fallback URLs when the client shares the public IP", () => {
    expect(
      resolveClientAwareUrls(
        { host: tunnelHost, "cf-connecting-ip": "203.0.113.9" },
        fallback,
        "203.0.113.9",
      ),
    ).toEqual(fallback);
  });

  it("keeps host-derived URLs for remote clients", () => {
    expect(
      resolveClientAwareUrls(
        { host: tunnelHost, "cf-connecting-ip": "198.51.100.4" },
        fallback,
        "203.0.113.9",
      ),
    ).toEqual(tunnelUrls);
  });

  it("keeps host-derived URLs when the header is missing", () => {
    expect(
      resolveClientAwareUrls({ host: tunnelHost }, fallback, "203.0.113.9"),
    ).toEqual(tunnelUrls);
  });

  it("keeps host-derived URLs when the header is repeated", () => {
    expect(
      resolveClientAwareUrls(
        {
          host: tunnelHost,
          "cf-connecting-ip": ["203.0.113.9", "203.0.113.9"],
        },
        fallback,
        "203.0.113.9",
      ),
    ).toEqual(tunnelUrls);
  });

  it("keeps host-derived URLs when the own IP is unknown", () => {
    expect(
      resolveClientAwareUrls(
        { host: tunnelHost, "cf-connecting-ip": "203.0.113.9" },
        fallback,
        null,
      ),
    ).toEqual(tunnelUrls);
  });
});

describe("rewritePublicUrl", () => {
  it("replaces the internal origin and preserves the playback path", () => {
    expect(
      rewritePublicUrl(
        "http://127.0.0.1:8090/play/abc/2",
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

describe("compatibleStreams", () => {
  const file = { id: 3, path: "Movie.mkv", length: 2_000_000_000 };
  const addonUrl = "http://192.168.1.50:7000";
  const token = "a-long-private-token-value";

  it("offers a repaired stream when the verdict warrants one", () => {
    const [stream] = compatibleStreams(
      true,
      addonUrl,
      token,
      { id: "hoshi:x", directPlay: { audioCodec: "dts" } },
      file,
    );
    expect(stream.description).toContain("AC3");
    expect(stream.url).toBe(
      `${addonUrl}/hls/${encodeURIComponent(token)}/hoshi%3Ax/3/index.m3u8`,
    );
    expect(stream.behaviorHints.bingeGroup).toBe("hoshistream-hoshi:x");
  });

  it("stays silent when disabled or when direct play is fine", () => {
    expect(
      compatibleStreams(
        false,
        addonUrl,
        token,
        { id: "hoshi:x", directPlay: { audioCodec: "dts" } },
        file,
      ),
    ).toEqual([]);
    expect(
      compatibleStreams(
        true,
        addonUrl,
        token,
        { id: "hoshi:x", directPlay: { container: "mov", audioCodec: "aac" } },
        file,
      ),
    ).toEqual([]);
    expect(
      compatibleStreams(true, addonUrl, token, { id: "hoshi:x" }, file),
    ).toEqual([]);
  });

  it("honors the per-entry forceTranscode override with a remux", () => {
    const [stream] = compatibleStreams(
      true,
      addonUrl,
      token,
      {
        id: "hoshi:x",
        directPlay: { container: "mov", audioCodec: "aac" },
        forceTranscode: true,
      },
      file,
    );
    expect(stream.description).toContain("container");
  });
});
