import { describe, expect, it } from "vitest";
import {
  compatibleStreams,
  describe as describeStream,
  notWebReady,
  presentStreams,
  resolutionLabel,
  resolveClientAwareUrls,
  resolvePublicUrls,
  rewritePublicUrl,
  streamBehaviorHints,
} from "../src/streams.ts";
import type { DirectPlay } from "../src/direct-play.ts";

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

  it("flags formats browsers cannot decode and carries the subtitle hash", () => {
    const file = { id: 1, path: "Movie.mkv", length: 10 };
    expect(
      streamBehaviorHints("hoshi:x", file, {
        directPlay: {
          videoCodec: "hevc",
          audioCodec: "aac",
          compatibility: "risky",
          warnings: [],
        },
        videoHash: "8e245d9679d31e12",
      }),
    ).toMatchObject({ notWebReady: true, videoHash: "8e245d9679d31e12" });
    const clean = streamBehaviorHints("hoshi:x", file, {
      directPlay: {
        videoCodec: "h264",
        audioCodec: "aac",
        container: "mkv",
        compatibility: "direct",
        warnings: [],
      },
    });
    expect(clean).not.toHaveProperty("notWebReady");
    expect(clean).not.toHaveProperty("videoHash");
  });
});

describe("notWebReady", () => {
  const probe = (fields: Partial<DirectPlay>): DirectPlay => ({
    compatibility: "direct",
    warnings: [],
    ...fields,
  });
  it.each([
    [{ videoCodec: "hevc" }, true],
    [{ videoCodec: "H265" }, true],
    [{ videoCodec: "mpeg4" }, true],
    [{ videoCodec: "vc1" }, true],
    [{ audioCodec: "dts" }, true],
    [{ audioCodec: "truehd" }, true],
    [{ container: "avi" }, true],
    [
      { container: "matroska,webm", videoCodec: "h264", audioCodec: "aac" },
      false,
    ],
    [{ videoCodec: "av1", audioCodec: "opus" }, false],
    [{ audioCodec: "ac3" }, false],
    [{}, false],
  ])("judges %j as %s", (fields, expected) => {
    expect(notWebReady(probe(fields))).toBe(expected);
  });
});

describe("describe", () => {
  const file = { id: 1, path: "Movie.mkv", length: 4_500_000_000 };

  it("names the source, resolution, codecs, and size on one line", () => {
    expect(
      describeStream("Torrent", file, {
        directPlay: {
          width: 1920,
          height: 800,
          videoCodec: "h264",
          audioCodec: "eac3",
          bitrateMbps: 6.24,
          compatibility: "direct",
          warnings: [],
        },
      }),
    ).toBe("Torrent · 1080p · H.264 · E-AC3 · 4.5 GB\n6.2 Mbps average");
  });

  it("adds the player caveat as its own line and skips unknowns", () => {
    const text = describeStream("Disk", file, {
      directPlay: {
        videoCodec: "hevc",
        compatibility: "risky",
        warnings: ["hevc video needs a capable player"],
      },
    });
    expect(text.split("\n")).toEqual([
      "Disk · HEVC · 4.5 GB",
      "Check player: hevc video needs a capable player",
    ]);
  });

  it("falls back to the bare source and size before a probe", () => {
    expect(describeStream("Local", file, {})).toBe("Local · 4.5 GB");
  });

  it("upper-cases codecs it has no friendly name for", () => {
    expect(
      describeStream("Torrent", file, {
        directPlay: {
          videoCodec: "prores",
          audioCodec: "alac",
          compatibility: "direct",
          warnings: [],
        },
      }).split("\n")[0],
    ).toBe("Torrent · PRORES · ALAC · 4.5 GB");
  });
});

describe("resolutionLabel", () => {
  it.each([
    [3840, 2160, "2160p"],
    [3840, 1600, "2160p"],
    [1920, 1080, "1080p"],
    [1920, 804, "1080p"],
    [1280, 720, "720p"],
    [720, 576, "576p"],
    [720, 480, "480p"],
    [640, 360, "360p"],
    [undefined, undefined, undefined],
  ])("labels %sx%s as %s", (width, height, label) => {
    expect(resolutionLabel(width, height)).toBe(label);
  });
});

describe("compatibleStreams", () => {
  const file = { id: 3, path: "Movie.mkv", length: 2_000_000_000 };
  const addonUrl = "http://192.168.1.50:7000";
  const token = "a-long-private-token-value";
  const repair = { videoBitrateMbps: 8, remoteClient: false };

  it("offers a repaired stream when the verdict warrants one", () => {
    const [stream] = compatibleStreams(
      repair,
      addonUrl,
      token,
      { id: "hoshi:x", directPlay: { audioCodec: "dts" } },
      file,
    );
    expect(stream.description).toContain("AC3");
    expect(stream.url).toBe(
      `${addonUrl}/hls/${encodeURIComponent(token)}/hoshi%3Ax/3/auto/index.m3u8`,
    );
    expect(stream.behaviorHints.bingeGroup).toBe("hoshistream-hoshi:x");
  });

  it("stays silent when disabled or when direct play is fine", () => {
    expect(
      compatibleStreams(
        undefined,
        addonUrl,
        token,
        { id: "hoshi:x", directPlay: { audioCodec: "dts" } },
        file,
      ),
    ).toEqual([]);
    expect(
      compatibleStreams(
        repair,
        addonUrl,
        token,
        { id: "hoshi:x", directPlay: { container: "mov", audioCodec: "aac" } },
        file,
      ),
    ).toEqual([]);
    expect(
      compatibleStreams(repair, addonUrl, token, { id: "hoshi:x" }, file),
    ).toEqual([]);
  });

  it("honors the per-entry forceTranscode override with a remux", () => {
    const [stream] = compatibleStreams(
      repair,
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

  it("offers a video re-encode only when a hardware encoder exists", () => {
    const entry = { id: "hoshi:x", directPlay: { videoCodec: "av1" } };
    expect(compatibleStreams(repair, addonUrl, token, entry, file)).toEqual([]);
    const [stream] = compatibleStreams(
      { ...repair, videoEncoder: "h264_videotoolbox" },
      addonUrl,
      token,
      entry,
      file,
    );
    expect(stream.description).toContain("re-encoded");
    expect(stream.url).toContain("/auto/index.m3u8");
  });

  it("adds a lower-bitrate rendition for remote clients on heavy files", () => {
    const entry = {
      id: "hoshi:x",
      directPlay: { container: "mov", audioCodec: "aac", bitrateMbps: 24 },
    };
    const streams = compatibleStreams(
      {
        videoEncoder: "h264_videotoolbox",
        videoBitrateMbps: 8,
        remoteClient: true,
      },
      addonUrl,
      token,
      entry,
      file,
    );
    expect(streams).toHaveLength(1);
    expect(streams[0].description).toContain("8 Mbps");
    expect(streams[0].url).toContain("/video/index.m3u8");
    // LAN clients and light files get no capped rendition.
    expect(
      compatibleStreams(
        {
          videoEncoder: "h264_videotoolbox",
          videoBitrateMbps: 8,
          remoteClient: false,
        },
        addonUrl,
        token,
        entry,
        file,
      ),
    ).toEqual([]);
  });
});

describe("presentStreams", () => {
  const hints = { filename: "Movie.mkv", videoSize: 1, bingeGroup: "b" };
  const direct = {
    name: "HoshiStream",
    description: "Torrent • Movie.mkv",
    url: "http://addon/direct",
    behaviorHints: hints,
    bitrateMbps: 12,
  };
  const lower = {
    name: "HoshiStream",
    description: "Lower bitrate • 6 Mbps for remote playback",
    url: "http://addon/hls",
    behaviorHints: hints,
    bitrateMbps: 6,
  };

  it("lists what the line can carry first and says why the rest is heavy", () => {
    const streams = presentStreams([direct, lower], 9);
    expect(streams.map((stream) => stream.url)).toEqual([
      lower.url,
      direct.url,
    ]);
    expect(streams[0].description).toBe(`${lower.description}\nfits your line`);
    expect(streams[1].description).toBe(
      "Torrent • Movie.mkv\nabove your line · needs 12.0 Mbps, line ~9 Mbps",
    );
    expect(streams.every((stream) => !("bitrateMbps" in stream))).toBe(true);
  });

  it("hides nothing and keeps order when everything fits", () => {
    const streams = presentStreams([{ ...direct, bitrateMbps: 4 }, lower], 9);
    expect(streams.map((stream) => stream.url)).toEqual([
      direct.url,
      lower.url,
    ]);
    expect(streams[0].description).toBe(
      `${direct.description}\nfits your line`,
    );
  });

  it("changes nothing when the bitrate or line speed is unknown", () => {
    const unprobed = { ...direct, bitrateMbps: undefined };
    expect(presentStreams([unprobed, lower], 9)[0].url).toBe(direct.url);
    expect(presentStreams([direct, lower], undefined)[0].description).toBe(
      direct.description,
    );
  });
});

describe("compatibleStreams bitrate", () => {
  const file = { id: 3, path: "Movie.mkv", length: 2_000_000_000 };
  const addonUrl = "http://192.168.1.50:7000";
  const token = "a-long-private-token-value";

  it("keeps the source bitrate for remux and audio repairs", () => {
    const [stream] = compatibleStreams(
      { videoBitrateMbps: 8, remoteClient: false },
      addonUrl,
      token,
      { id: "hoshi:x", directPlay: { audioCodec: "dts", bitrateMbps: 14 } },
      file,
    );
    expect(stream.bitrateMbps).toBe(14);
  });

  it("uses the encode target for re-encodes and capped renditions", () => {
    const streams = compatibleStreams(
      {
        videoBitrateMbps: 8,
        remoteClient: true,
        videoEncoder: "h264_videotoolbox",
      },
      addonUrl,
      token,
      {
        id: "hoshi:x",
        directPlay: { videoCodec: "vp9", bitrateMbps: 20 },
      },
      file,
    );
    expect(streams.map((stream) => stream.bitrateMbps)).toEqual([8, 8]);
  });
});
