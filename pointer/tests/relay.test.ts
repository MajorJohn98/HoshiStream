import { describe, expect, it } from "vitest";
import {
  MAX_MANIFEST_BYTES,
  blobPathname,
  decideRelay,
  hashToken,
  hashesEqual,
  isPrivateBaseUrl,
  parseAddonPath,
  pushBodySchema,
  recordBlobPathname,
  secretsEqual,
  type PointerRecord,
} from "../lib/relay.js";
import { allowRequest, resetRateLimits } from "../lib/ratelimit.js";

const TOKEN = "a-sufficiently-long-access-token";
const PUSH_SECRET = "a-sufficiently-long-push-secret";

function record(overrides: Partial<PointerRecord> = {}): PointerRecord {
  return {
    baseUrl: "http://192.168.1.42:7001",
    tokenHash: hashToken(TOKEN),
    pushSecretHash: hashToken(PUSH_SECRET),
    manifest: { id: "com.john.private-torrent-streamer" },
    createdAt: "2026-09-01T10:00:00.000Z",
    updatedAt: "2026-09-01T10:00:00.000Z",
    expiresAt: "2026-11-30T10:00:00.000Z",
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
  it("rejects an oversized manifest", () => {
    expect(
      pushBodySchema.safeParse({
        baseUrl: "http://192.168.1.42:7001",
        token: TOKEN,
        manifest: { blob: "x".repeat(MAX_MANIFEST_BYTES) },
      }).success,
    ).toBe(false);
  });
});

describe("isPrivateBaseUrl", () => {
  it("accepts LAN, loopback, CGNAT, and mDNS hosts", () => {
    for (const url of [
      "http://192.168.1.42:7001",
      "http://10.0.0.5:7001",
      "http://172.16.9.1:7001",
      "http://172.31.255.1:7001",
      "http://100.64.0.9:7001", // Tailscale / CGNAT
      "http://169.254.10.10:7001",
      "http://127.0.0.1:7001",
      "http://localhost:7001",
      "http://my-mac.local:7001",
      "http://[::1]:7001",
      "http://[fd7a:115c:a1e0::1]:7001",
      "http://[fe80::1]:7001",
    ]) {
      expect(isPrivateBaseUrl(url), url).toBe(true);
    }
  });

  it("rejects public hosts", () => {
    for (const url of [
      "https://evil.example.com",
      "http://8.8.8.8:7001",
      "http://172.32.0.1:7001",
      "http://100.128.0.1:7001",
      "http://193.168.1.1:7001",
      "not-a-url",
    ]) {
      expect(isPrivateBaseUrl(url), url).toBe(false);
    }
  });
});

describe("secrets", () => {
  it("compares secrets in constant time regardless of length", () => {
    expect(secretsEqual("a-shared-secret", "a-shared-secret")).toBe(true);
    expect(secretsEqual("a-shared-secret", "another-secret")).toBe(false);
    expect(secretsEqual("", "a-shared-secret")).toBe(false);
  });

  it("compares stored hashes safely", () => {
    expect(hashesEqual(hashToken("a"), hashToken("a"))).toBe(true);
    expect(hashesEqual(hashToken("a"), hashToken("b"))).toBe(false);
    expect(hashesEqual("not-hex", hashToken("a"))).toBe(false);
  });

  it("derives a stable, secret-dependent legacy blob pathname", () => {
    expect(blobPathname("secret-one")).toBe(blobPathname("secret-one"));
    expect(blobPathname("secret-one")).not.toBe(blobPathname("secret-two"));
    expect(blobPathname("secret-one")).toMatch(
      /^hoshistream-pointer-[0-9a-f]{32}\.json$/,
    );
  });

  it("derives a stable token-keyed v2 blob pathname", () => {
    const tokenHash = hashToken(TOKEN);
    expect(recordBlobPathname(tokenHash)).toBe(recordBlobPathname(tokenHash));
    expect(recordBlobPathname(tokenHash)).toMatch(
      /^hoshistream-pointer-v2-[0-9a-f]{32}\.json$/,
    );
    expect(recordBlobPathname(tokenHash)).not.toBe(
      recordBlobPathname(hashToken("another-token-of-similar-len")),
    );
  });
});

describe("allowRequest (in-memory fallback)", () => {
  it("allows up to the limit within a window, then blocks", async () => {
    resetRateLimits();
    for (let i = 0; i < 5; i += 1) {
      expect(await allowRequest("test-bucket", 5, 3600)).toBe(true);
    }
    expect(await allowRequest("test-bucket", 5, 3600)).toBe(false);
    expect(await allowRequest("other-bucket", 5, 3600)).toBe(true);
  });
});
