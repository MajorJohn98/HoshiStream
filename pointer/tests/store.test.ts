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
  get: vi.fn(),
  head: vi.fn(),
  list: vi.fn(),
  del: vi.fn(),
  put: vi.fn(),
}));

beforeEach(() => {
  resetPointerCache();
  vi.stubEnv("UPSTASH_REDIS_REST_URL", "https://storage.example");
  vi.stubEnv("UPSTASH_REDIS_REST_TOKEN", "fixture-not-a-real-token");
});
afterEach(() => {
  vi.clearAllMocks();
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
});

describe("Blob records are immutable versions", () => {
  beforeEach(() => {
    vi.stubEnv("UPSTASH_REDIS_REST_URL", "");
    vi.stubEnv("KV_REST_API_URL", "");
  });

  const record: PointerRecord = {
    baseUrl: "http://192.168.1.4:7001",
    tokenHash: hashToken("fixture-long-access-token"),
    pushSecretHash: hashToken("fixture-long-push-secret"),
    manifest: { id: "fixture" },
    createdAt: "2026-09-08T12:28:12.129Z",
    updatedAt: "2026-09-11T22:43:46.077Z",
    expiresAt: "2099-01-01T00:00:00.000Z",
  };
  const prefix = `hoshistream-pointer-v3/${record.tokenHash.slice(0, 32)}/`;
  const legacyPathname = `hoshistream-pointer-v2-${record.tokenHash.slice(0, 32)}.json`;

  function version(name: string) {
    return {
      pathname: `${prefix}${name}.json`,
      url: `https://blob.example/${prefix}${name}.json`,
    };
  }

  function listing(blobs: { pathname: string; url: string }[]) {
    return { blobs, cursor: undefined, hasMore: false } as never;
  }

  function body(value: unknown) {
    return {
      statusCode: 200 as const,
      stream: new Response(JSON.stringify(value)).body!,
      headers: new Headers(),
      blob: {} as never,
    };
  }

  it("writes every push as a new blob and never overwrites in place", async () => {
    const { put, list, del, head } = await import("@vercel/blob");
    vi.mocked(put).mockResolvedValueOnce({} as never);
    vi.mocked(list).mockResolvedValueOnce(
      listing([version("000000000000002-new"), version("000000000000001-old")]),
    );
    vi.mocked(head).mockRejectedValueOnce(new BlobNotFoundError());
    await savePointerRecord(record);
    const [pathname, payload, options] = vi.mocked(put).mock.calls[0]!;
    expect(pathname).toMatch(
      new RegExp(`^${prefix}\\d{15}-[0-9a-f]{8}\\.json$`),
    );
    expect(JSON.parse(payload as string)).toEqual(record);
    expect(options).toMatchObject({
      access: "public",
      addRandomSuffix: false,
      allowOverwrite: false,
    });
    expect(del).toHaveBeenCalledWith(
      [version("000000000000001-old").url],
      expect.anything(),
    );
  });

  it("retires the tenant's in-place v2 blob once a v3 version exists", async () => {
    const { put, list, del, head } = await import("@vercel/blob");
    vi.mocked(put).mockResolvedValueOnce({} as never);
    vi.mocked(list).mockResolvedValueOnce(
      listing([version("000000000000001-a")]),
    );
    vi.mocked(head).mockResolvedValueOnce({
      url: `https://blob.example/${legacyPathname}`,
    } as never);
    await savePointerRecord(record);
    expect(head).toHaveBeenCalledWith(legacyPathname, expect.anything());
    expect(del).toHaveBeenCalledWith(
      [`https://blob.example/${legacyPathname}`],
      expect.anything(),
    );
  });

  it("does not fail a push when cleanup of superseded versions fails", async () => {
    const { put, list, del, head } = await import("@vercel/blob");
    vi.mocked(put).mockResolvedValueOnce({} as never);
    vi.mocked(list).mockResolvedValueOnce(
      listing([version("000000000000002-b"), version("000000000000001-a")]),
    );
    vi.mocked(head).mockRejectedValueOnce(new Error("storage unavailable"));
    vi.mocked(del).mockRejectedValueOnce(new Error("storage unavailable"));
    await expect(savePointerRecord(record)).resolves.toBeUndefined();
    resetPointerCache();
    vi.mocked(put).mockRejectedValueOnce(new Error("storage unavailable"));
    await expect(savePointerRecord(record)).rejects.toThrow(
      "storage unavailable",
    );
  });

  it("reads the newest version by pathname order, located via the list API", async () => {
    const { get, list, head } = await import("@vercel/blob");
    const old = { ...record, baseUrl: "http://192.168.1.2:7001" };
    vi.mocked(list).mockResolvedValueOnce(
      listing([version("000000000000001-a"), version("000000000000002-b")]),
    );
    vi.mocked(get).mockImplementationOnce(async (pathname) => {
      expect(pathname).toBe(version("000000000000002-b").pathname);
      return body(record);
    });
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    await expect(loadPointerRecord(record.tokenHash)).resolves.toEqual(record);
    expect(list).toHaveBeenCalledWith(expect.objectContaining({ prefix }));
    expect(head).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(old.baseUrl).not.toBe(record.baseUrl);
  });

  it("follows list pagination so a newer version on a later page still wins", async () => {
    const { get, list } = await import("@vercel/blob");
    vi.mocked(list)
      .mockResolvedValueOnce({
        blobs: [version("000000000000001-a")],
        cursor: "page-2",
        hasMore: true,
      } as never)
      .mockResolvedValueOnce(listing([version("000000000000002-b")]));
    vi.mocked(get).mockResolvedValueOnce(body(record));
    await expect(loadPointerRecord(record.tokenHash)).resolves.toEqual(record);
    expect(list).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ cursor: "page-2" }),
    );
    expect(get).toHaveBeenCalledWith(
      version("000000000000002-b").pathname,
      expect.objectContaining({ access: "public" }),
    );
  });

  it("falls back to the v2 blob only when no v3 version exists", async () => {
    const { get, list } = await import("@vercel/blob");
    vi.mocked(list).mockResolvedValueOnce(listing([]));
    vi.mocked(get).mockResolvedValueOnce(body(record));
    await expect(loadPointerRecord(record.tokenHash)).resolves.toEqual(record);
    expect(get).toHaveBeenCalledWith(
      legacyPathname,
      expect.objectContaining({ access: "public" }),
    );
  });

  it("treats a missing record as no record and surfaces other failures", async () => {
    const { get, list } = await import("@vercel/blob");
    vi.mocked(list).mockResolvedValue(listing([]));
    vi.mocked(get).mockResolvedValueOnce(null);
    await expect(loadPointerRecord("missing")).resolves.toBeUndefined();
    resetPointerCache();
    vi.mocked(get).mockRejectedValueOnce(new BlobNotFoundError());
    await expect(loadPointerRecord("missing")).resolves.toBeUndefined();
    resetPointerCache();
    vi.mocked(get).mockRejectedValueOnce(new Error("storage unavailable"));
    await expect(loadPointerRecord("missing")).rejects.toThrow(
      "storage unavailable",
    );
    resetPointerCache();
    vi.mocked(list).mockRejectedValueOnce(new Error("list unavailable"));
    await expect(loadPointerRecord("missing")).rejects.toThrow(
      "list unavailable",
    );
  });

  it("deletes every version plus the v2 blob, and only treats a missing blob as removed", async () => {
    const { list, head, del } = await import("@vercel/blob");
    vi.mocked(list).mockResolvedValueOnce(
      listing([version("000000000000002-b"), version("000000000000001-a")]),
    );
    vi.mocked(head).mockResolvedValueOnce({
      url: `https://blob.example/${legacyPathname}`,
    } as never);
    await deletePointerRecord(record.tokenHash);
    expect(del).toHaveBeenCalledWith(
      [
        version("000000000000002-b").url,
        version("000000000000001-a").url,
        `https://blob.example/${legacyPathname}`,
      ],
      expect.anything(),
    );

    vi.mocked(list).mockResolvedValueOnce(listing([]));
    vi.mocked(head).mockRejectedValueOnce(new BlobNotFoundError());
    await expect(deletePointerRecord("fixture")).resolves.toBeUndefined();
    expect(del).toHaveBeenCalledTimes(1);

    vi.mocked(list).mockResolvedValueOnce(listing([]));
    vi.mocked(head).mockRejectedValueOnce(new Error("storage unavailable"));
    await expect(deletePointerRecord("fixture")).rejects.toThrow(
      "storage unavailable",
    );
    expect(del).toHaveBeenCalledTimes(1);
  });
});
