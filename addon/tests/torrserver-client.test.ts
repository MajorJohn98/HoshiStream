import { afterEach, describe, expect, it, vi } from "vitest";
import { TorrServerClient } from "../src/torrserver-client.js";

afterEach(() => vi.unstubAllGlobals());

describe("TorrServerClient", () => {
  it("uses and parses the pinned /torrents get action", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          title: "Test",
          hash: "abc123",
          stat: 1,
          stat_string: "Torrent getting info",
          file_stats: [{ id: 1, path: "Movie.mkv", length: 100 }],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const status = await new TorrServerClient("http://torrserver:8090").get(
      "abc123",
    );
    expect(status.file_stats[0]?.path).toBe("Movie.mkv");
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({
      action: "get",
      hash: "abc123",
    });
  });

  it("retries transient failures before succeeding", async () => {
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new TypeError("fetch failed"))
      .mockResolvedValueOnce(new Response("oops", { status: 503 }))
      .mockResolvedValueOnce(new Response("MatriX.141", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const client = new TorrServerClient("http://torrserver:8090", 1_000, 1);
    await expect(client.health()).resolves.toBe("MatriX.141");
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("does not retry client errors", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response("missing", { status: 404 }));
    vi.stubGlobal("fetch", fetchMock);

    const client = new TorrServerClient("http://torrserver:8090", 1_000, 1);
    await expect(client.health()).rejects.toThrow("TorrServer 404");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("fails after exhausting retries", async () => {
    const fetchMock = vi.fn().mockRejectedValue(new TypeError("fetch failed"));
    vi.stubGlobal("fetch", fetchMock);

    const client = new TorrServerClient("http://torrserver:8090", 1_000, 1);
    await expect(client.health()).rejects.toThrow(
      "TorrServer request failed: fetch failed",
    );
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("builds the documented /play/{hash}/{id} URL", () => {
    expect(
      new TorrServerClient("http://torrserver:8090").streamUrl("abc 123", {
        id: 2,
        path: "Movie.mkv",
        length: 100,
      }),
    ).toBe("http://torrserver:8090/play/abc%20123/2");
  });
});
