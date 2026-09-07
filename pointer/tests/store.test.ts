import { BlobNotFoundError } from "@vercel/blob";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { hashToken, type PointerRecord } from "../lib/relay.js";
import {
  deletePointerRecord,
  loadPointerRecord,
  resetPointerCache,
  savePointerRecord,
} from "../lib/store.js";

vi.mock("@vercel/blob", async (original) => ({
  ...(await original<typeof import("@vercel/blob")>()),
  head: vi.fn(),
  del: vi.fn(),
  put: vi.fn(),
}));

beforeEach(() => {
  resetPointerCache();
  vi.stubEnv("UPSTASH_REDIS_REST_URL", "https://storage.example");
  vi.stubEnv("UPSTASH_REDIS_REST_TOKEN", "fixture-not-a-real-token");
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  resetPointerCache();
});

describe("pointer storage failure boundaries", () => {
  it("does not treat a storage outage as an unclaimed identity", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response("unavailable", { status: 503 }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(loadPointerRecord("fixture")).rejects.toThrow("503");
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ result: null })));
    await expect(loadPointerRecord("fixture")).resolves.toBeUndefined();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("rejects successful HTTP responses containing Redis errors or malformed records", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          new Response(JSON.stringify({ error: "backend refused request" })),
        ),
    );
    await expect(loadPointerRecord("fixture")).rejects.toThrow();
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          new Response(JSON.stringify({ result: "{invalid" })),
        ),
    );
    await expect(loadPointerRecord("fixture")).rejects.toThrow();
  });

  it("expires a cached record at its actual deadline", async () => {
    vi.useFakeTimers();
    try {
      const now = new Date("2026-09-07T12:00:00.000Z");
      vi.setSystemTime(now);
      const record: PointerRecord = {
        baseUrl: "http://192.168.1.42:7001",
        tokenHash: hashToken("fixture-long-access-token"),
        pushSecretHash: hashToken("fixture-long-push-secret"),
        manifest: { id: "fixture" },
        createdAt: now.toISOString(),
        updatedAt: now.toISOString(),
        expiresAt: new Date(now.getTime() + 1000).toISOString(),
      };
      vi.stubGlobal(
        "fetch",
        vi
          .fn()
          .mockResolvedValue(new Response(JSON.stringify({ result: "OK" }))),
      );
      await savePointerRecord(record);
      expect(await loadPointerRecord(record.tokenHash)).toEqual(record);
      vi.advanceTimersByTime(1001);
      expect(await loadPointerRecord(record.tokenHash)).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it("only treats a missing Blob as removed, never permission or service failures", async () => {
    vi.stubEnv("UPSTASH_REDIS_REST_URL", "");
    vi.stubEnv("KV_REST_API_URL", "");
    const { head, del } = await import("@vercel/blob");
    vi.mocked(head).mockRejectedValueOnce(new BlobNotFoundError());
    await expect(deletePointerRecord("fixture")).resolves.toBeUndefined();
    vi.mocked(head).mockRejectedValueOnce(new Error("storage unavailable"));
    await expect(deletePointerRecord("fixture")).rejects.toThrow(
      "storage unavailable",
    );
    expect(del).not.toHaveBeenCalled();
  });
});
