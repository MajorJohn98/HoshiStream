import { describe, expect, it } from "vitest";
import {
  blobPathname,
  decideRelay,
  hashToken,
  parseAddonPath,
  pushBodySchema,
  secretsEqual,
  type PointerRecord,
} from "../lib/relay.js";

const TOKEN = "a-sufficiently-long-access-token";

function record(overrides: Partial<PointerRecord> = {}): PointerRecord {
  return {
    baseUrl: "http://192.168.1.42:7001",
    tokenHash: hashToken(TOKEN),
    manifest: { id: "com.john.private-torrent-streamer" },
    updatedAt: "2026-09-01T10:00:00.000Z",
    ...overrides,
  };
}

describe("parseAddonPath", () => {
  it("extracts token and resource path", () => {
    expect(parseAddonPath(`/addon/${TOKEN}/manifest.json`)).toEqual({
      token: TOKEN,
      rest: "manifest.json",
    });
    expect(parseAddonPath(`/addon/${TOKEN}/stream/movie/hs-1.json`)).toEqual({
      token: TOKEN,
      rest: "stream/movie/hs-1.json",
    });
  });

  it("decodes a percent-encoded token", () => {
    expect(parseAddonPath("/addon/a%2Bb-token/manifest.json")?.token).toBe(
      "a+b-token",
    );
  });

  it("rejects paths outside /addon/", () => {
    expect(parseAddonPath("/manifest.json")).toBeUndefined();
    expect(parseAddonPath("/addon/token-only")).toBeUndefined();
    expect(parseAddonPath("/api/pointer")).toBeUndefined();
  });
});

describe("decideRelay", () => {
  it("serves the stored manifest for manifest.json", () => {
    const decision = decideRelay(record(), `/addon/${TOKEN}/manifest.json`);
    expect(decision).toEqual({
      kind: "manifest",
      manifest: { id: "com.john.private-torrent-streamer" },
    });
  });

  it("redirects other resources to the pushed base URL", () => {
    const decision = decideRelay(
      record(),
      `/addon/${TOKEN}/catalog/movie/private-movies.json`,
    );
    expect(decision).toEqual({
      kind: "redirect",
      location: `http://192.168.1.42:7001/addon/${encodeURIComponent(TOKEN)}/catalog/movie/private-movies.json`,
    });
  });

  it("strips trailing slashes from the base URL", () => {
    const decision = decideRelay(
      record({ baseUrl: "http://192.168.1.42:7001/" }),
      `/addon/${TOKEN}/stream/movie/hs-1.json`,
    );
    expect(decision.kind).toBe("redirect");
    if (decision.kind === "redirect") {
      expect(decision.location).not.toContain("7001//");
    }
  });

  it("rejects a wrong token without revealing anything", () => {
    expect(
      decideRelay(record(), "/addon/wrong-token-of-similar-len/manifest.json"),
    ).toEqual({ kind: "unauthorized" });
  });

  it("returns not_found when nothing has been pushed", () => {
    expect(decideRelay(undefined, `/addon/${TOKEN}/manifest.json`)).toEqual({
      kind: "not_found",
    });
  });

  it("returns not_found for non-addon paths", () => {
    expect(decideRelay(record(), "/favicon.ico")).toEqual({
      kind: "not_found",
    });
  });
});

describe("pushBodySchema", () => {
  it("accepts a valid push payload", () => {
    expect(
      pushBodySchema.safeParse({
        baseUrl: "http://192.168.1.42:7001",
        token: TOKEN,
        manifest: { id: "x" },
      }).success,
    ).toBe(true);
  });

  it("rejects non-HTTP base URLs and short tokens", () => {
    expect(
      pushBodySchema.safeParse({
        baseUrl: "file:///etc/passwd",
        token: TOKEN,
        manifest: {},
      }).success,
    ).toBe(false);
    expect(
      pushBodySchema.safeParse({
        baseUrl: "http://192.168.1.42:7001",
        token: "short",
        manifest: {},
      }).success,
    ).toBe(false);
  });
});

describe("secrets", () => {
  it("compares secrets in constant time regardless of length", () => {
    expect(secretsEqual("a-shared-secret", "a-shared-secret")).toBe(true);
    expect(secretsEqual("a-shared-secret", "another-secret")).toBe(false);
    expect(secretsEqual("", "a-shared-secret")).toBe(false);
  });

  it("derives a stable, secret-dependent blob pathname", () => {
    expect(blobPathname("secret-one")).toBe(blobPathname("secret-one"));
    expect(blobPathname("secret-one")).not.toBe(blobPathname("secret-two"));
    expect(blobPathname("secret-one")).toMatch(
      /^hoshistream-pointer-[0-9a-f]{32}\.json$/,
    );
  });
});
