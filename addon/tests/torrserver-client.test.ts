import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TorrServerClient } from "../src/torrserver-client.ts";

afterEach(() => vi.unstubAllGlobals());

describe("TorrServerClient", () => {
  it("parses the single status object returned by /torrent/upload", async () => {
    const directory = await mkdtemp(join(tmpdir(), "hoshi-torrent-upload-"));
    const path = join(directory, "fixture.torrent");
    await writeFile(path, "synthetic torrent metadata");
    const status = {
      hash: "abc123",
      title: "Authorized film",
      stat: 1,
      stat_string: "Torrent getting info",
      file_stats: [{ id: 1, path: "film.mp4", length: 100 }],
    };
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify(status)));
    vi.stubGlobal("fetch", fetchMock);
    try {
      const client = new TorrServerClient("http://torrserver:8090");
      expect(await client.addTorrentFile(path, "Authorized film")).toEqual(
        status,
      );
      const [url, options] = fetchMock.mock.calls[0];
      expect(url).toBe("http://torrserver:8090/torrent/upload");
      expect(options.method).toBe("POST");
      expect(options.body).toBeInstanceOf(FormData);
      expect(options.body.get("title")).toBe("Authorized film");
      expect(options.body.get("file").name).toBe("fixture.torrent");
      expect(await options.body.get("file").text()).toBe(
        "synthetic torrent metadata",
      );

      fetchMock.mockResolvedValueOnce(new Response(JSON.stringify([status])));
      await expect(client.addTorrentFile(path)).rejects.toThrow();
    } finally {
      await rm(directory, { recursive: true });
    }
  });

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
    await expect(client.health()).rejects.toThrow("TorrServer request failed");
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

  it("does not send or retry a cancelled mutation", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    await expect(
      new TorrServerClient("http://torrserver:8090").addMagnet(
        "magnet:?xt=urn:btih:" + "a".repeat(40),
        "Fixture",
        AbortSignal.abort(),
      ),
    ).rejects.toMatchObject({ code: "cancelled" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("bounds metadata polling and reports a metadata timeout", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation(
        async () =>
          new Response(
            JSON.stringify({
              hash: "a".repeat(40),
              stat: 1,
              stat_string: "Getting metadata",
              file_stats: [],
            }),
          ),
      ),
    );
    await expect(
      new TorrServerClient("http://torrserver:8090").waitForFiles(
        "a".repeat(40),
        20,
      ),
    ).rejects.toMatchObject({ code: "metadata_timeout" });
  });

  it("does not expose raw network errors and does not replay additions", async () => {
    const fetchMock = vi
      .fn()
      .mockRejectedValue(new Error("sensitive source data"));
    vi.stubGlobal("fetch", fetchMock);
    await expect(
      new TorrServerClient("http://torrserver:8090").addMagnet(
        "magnet:?xt=urn:btih:" + "a".repeat(40),
      ),
    ).rejects.toThrow("TorrServer request failed");
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("decodes composite ids and prefers the file's own hash", () => {
    expect(
      new TorrServerClient("http://torrserver:8090").streamUrl("primary", {
        id: 200_004,
        path: "S02E04.mkv",
        length: 100,
        hash: "extra-hash",
      }),
    ).toBe("http://torrserver:8090/play/extra-hash/4");
  });
});
