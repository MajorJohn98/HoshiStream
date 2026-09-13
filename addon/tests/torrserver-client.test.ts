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

  it("lists torrents even when a live stat is null", async () => {
    // Seen from MatriX for a working torrent with a single idle peer: the
    // list would otherwise fail as a whole and hide every other torrent.
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify([
            {
              title: "Quiet",
              hash: "a".repeat(40),
              stat: 3,
              stat_string: "Torrent working",
              download_speed: null,
              active_peers: 1,
              connected_seeders: null,
            },
            {
              title: "Busy",
              hash: "b".repeat(40),
              stat: 3,
              stat_string: "Torrent working",
              download_speed: 1_000,
            },
          ]),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      ),
    );
    const list = await new TorrServerClient("http://torrserver:8090").list();
    expect(list.map((torrent) => torrent.title)).toEqual(["Quiet", "Busy"]);
    expect(list[0].download_speed).toBeUndefined();
    expect(list[0].connected_seeders).toBeUndefined();
    expect(list[0].active_peers).toBe(1);
    expect(list[1].download_speed).toBe(1_000);
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

  describe("cacheState", () => {
    // Shape of storage/state.CacheState at the pinned commit: Go-cased
    // fields (no JSON tags), Pieces keyed by piece index, Readers in piece
    // indexes, Torrent embedding the tagged TorrentStatus.
    const fixture = {
      Hash: "a".repeat(40),
      Capacity: 4294967296,
      Filled: 12582912,
      PiecesLength: 4194304,
      PiecesCount: 512,
      Torrent: {
        title: "Fixture",
        hash: "a".repeat(40),
        stat: 3,
        stat_string: "Torrent working",
        download_speed: 1234567.8,
        upload_speed: 1000,
        active_peers: 9,
        connected_seeders: 4,
        file_stats: [
          { id: 1, path: "Show/S01E01.mkv", length: 8388608 },
          { id: 2, path: "Show/S01E02.mkv", length: 8388608 },
        ],
      },
      Pieces: {
        "10": {
          Id: 10,
          Length: 4194304,
          Size: 4194304,
          Completed: true,
          Priority: 0,
        },
        "11": {
          Id: 11,
          Length: 4194304,
          Size: 4194304,
          Completed: true,
          Priority: 0,
        },
        "12": {
          Id: 12,
          Length: 4194304,
          Size: 1048576,
          Completed: false,
          Priority: 2,
        },
      },
      Readers: [{ Start: 6, End: 40, Reader: 10 }],
    };

    it("posts the get action and normalizes the Go-cased state", async () => {
      const fetchMock = vi
        .fn()
        .mockResolvedValue(new Response(JSON.stringify(fixture)));
      vi.stubGlobal("fetch", fetchMock);
      const state = await new TorrServerClient(
        "http://torrserver:8090",
      ).cacheState("a".repeat(40));
      expect(fetchMock.mock.calls[0][0]).toBe("http://torrserver:8090/cache");
      expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({
        action: "get",
        hash: "a".repeat(40),
      });
      expect(state).toMatchObject({
        hash: "a".repeat(40),
        capacity: 4294967296,
        filled: 12582912,
        pieceLength: 4194304,
        pieceCount: 512,
        readers: [{ startPiece: 6, endPiece: 40, readerPiece: 10 }],
        downloadSpeedBps: 1234567.8,
        activePeers: 9,
        connectedSeeders: 4,
        files: [
          { id: 1, path: "Show/S01E01.mkv", length: 8388608 },
          { id: 2, path: "Show/S01E02.mkv", length: 8388608 },
        ],
      });
      expect([...state!.completed]).toEqual([
        [10, true],
        [11, true],
        [12, false],
      ]);
    });

    it("returns undefined for the empty struct TorrServer sends before the cache exists", async () => {
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("{}")));
      await expect(
        new TorrServerClient("http://torrserver:8090").cacheState("abc"),
      ).resolves.toBeUndefined();
    });

    it("tolerates null Readers/Pieces/Torrent and rejects wrong shapes", async () => {
      const fetchMock = vi
        .fn()
        .mockResolvedValueOnce(
          new Response(
            JSON.stringify({
              ...fixture,
              Readers: null,
              Pieces: null,
              Torrent: null,
            }),
          ),
        )
        .mockResolvedValueOnce(
          new Response(JSON.stringify({ ...fixture, Readers: "nope" })),
        )
        .mockResolvedValueOnce(new Response("missing", { status: 404 }));
      vi.stubGlobal("fetch", fetchMock);
      const client = new TorrServerClient("http://torrserver:8090", 1_000, 1);
      const state = await client.cacheState("abc");
      expect(state?.readers).toEqual([]);
      expect(state?.files).toEqual([]);
      expect(state?.completed.size).toBe(0);
      expect(state?.downloadSpeedBps).toBe(0);
      await expect(client.cacheState("abc")).rejects.toMatchObject({
        code: "invalid_response",
      });
      await expect(client.cacheState("abc")).rejects.toMatchObject({
        code: "not_found",
      });
      // Cache lookups are polled; they never retry on their own.
      expect(fetchMock).toHaveBeenCalledTimes(3);
    });
  });

  describe("viewed", () => {
    // POST /viewed at the pinned commit: {action, hash, file_index}; set
    // and rem reply 200 with an empty body.
    it("sets and removes TorrServer's viewed mark without retrying", async () => {
      const fetchMock = vi
        .fn()
        .mockResolvedValueOnce(new Response(null, { status: 200 }))
        .mockResolvedValueOnce(new Response(null, { status: 200 }))
        .mockResolvedValueOnce(new Response("down", { status: 502 }));
      vi.stubGlobal("fetch", fetchMock);
      const client = new TorrServerClient("http://torrserver:8090", 1_000, 3);
      await client.setViewed("a".repeat(40), 3);
      await client.removeViewed("a".repeat(40), 3);
      expect(fetchMock.mock.calls[0][0]).toBe("http://torrserver:8090/viewed");
      expect(fetchMock.mock.calls[0][1].method).toBe("POST");
      expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({
        action: "set",
        hash: "a".repeat(40),
        file_index: 3,
      });
      expect(JSON.parse(fetchMock.mock.calls[1][1].body)).toEqual({
        action: "rem",
        hash: "a".repeat(40),
        file_index: 3,
      });
      await expect(client.setViewed("a".repeat(40), 3)).rejects.toMatchObject({
        code: "unavailable",
      });
      expect(fetchMock).toHaveBeenCalledTimes(3);
    });
  });
});
