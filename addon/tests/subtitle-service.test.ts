import { createServer, type Server } from "node:http";
import {
  mkdir,
  mkdtemp,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Library } from "../src/library.ts";
import {
  MAX_SUBTITLE_BYTES,
  SubtitleService,
} from "../src/subtitle-service.ts";
import { TorrServerClient } from "../src/torrserver-client.ts";

const HASH = "a".repeat(40);
const TOKEN = "subtitle-test-token";
const ADDON = "http://addon.test";

const temporary: string[] = [];
const servers: Server[] = [];

afterEach(async () => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  for (const path of temporary.splice(0))
    await rm(path, { recursive: true, force: true });
});

function listen(server: Server): Promise<string> {
  servers.push(server);
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      resolve(`http://127.0.0.1:${port}`);
    });
  });
}

type FakeFile = { id: number; path: string; length: number; body?: Buffer };

// Fake TorrServer: /torrents answers the file list, /play serves bodies.
function fakeTorrServer(files: FakeFile[], plays: string[] = []) {
  return listen(
    createServer((request, response) => {
      if (request.method === "POST" && request.url === "/torrents") {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(
          JSON.stringify({
            hash: HASH,
            stat: 3,
            stat_string: "Torrent working",
            file_stats: files.map(({ id, path, length }) => ({
              id,
              path,
              length,
            })),
          }),
        );
        return;
      }
      const play = /^\/play\/([0-9a-f]+)\/(\d+)$/.exec(request.url ?? "");
      if (play) {
        plays.push(request.url!);
        const file = files.find(
          (candidate) => candidate.id === Number(play[2]),
        );
        if (!file?.body) {
          response.writeHead(404).end();
          return;
        }
        response.writeHead(200, {
          "content-type": "application/octet-stream",
          "content-length": file.body.length,
        });
        response.end(file.body);
        return;
      }
      response.writeHead(404).end();
    }),
  );
}

async function torrentSetup(
  files: FakeFile[],
  options: { type?: "movie" | "series"; plays?: string[] } = {},
) {
  const base = await mkdtemp(join(tmpdir(), "hoshistream-subs-"));
  temporary.push(base);
  const library = new Library(join(base, "library.json"));
  const torrServer = new TorrServerClient(
    await fakeTorrServer(files, options.plays),
    2_000,
    10,
  );
  const type = options.type ?? "movie";
  const entry = await library.create({
    type,
    name: "Example",
    magnetUri: `magnet:?xt=urn:btih:${HASH}`,
  });
  const videos = files.filter((file) => /\.mkv$/.test(file.path));
  await library.setInspectionCache(entry.id, {
    hash: HASH,
    inspectedAt: new Date().toISOString(),
    selectedFiles: videos.map((file, index) => ({
      id: file.id,
      path: file.path,
      length: file.length,
      ...(type === "series" ? { season: 1, episode: index + 1 } : {}),
    })),
  });
  return { library, torrServer, entry, base };
}

const SRT = Buffer.from("1\n00:00:01,000 --> 00:00:02,000\nHello\n", "utf8");
const VTT = "WEBVTT\n\n00:00:01.000 --> 00:00:02.000\nHello\n";

describe("SubtitleService with torrent sources", () => {
  it("lists matching sidecars with add-on URLs and Stremio fields", async () => {
    const { library, torrServer, entry } = await torrentSetup([
      { id: 1, path: "Movie/Movie.mkv", length: 5_000_000 },
      { id: 2, path: "Movie/Movie.en.srt", length: SRT.length, body: SRT },
      { id: 3, path: "Movie/Subs/Movie.ru.ass", length: 900 },
      { id: 4, path: "Movie/Movie.nfo", length: 90 },
    ]);
    const service = new SubtitleService(library, torrServer);
    const { subtitles } = await service.list("movie", entry.id, ADDON, TOKEN);
    expect(subtitles).toEqual([
      {
        id: `${HASH}:2`,
        url: `${ADDON}/subtitles/${TOKEN}/${encodeURIComponent(entry.id)}/${HASH}:2.vtt`,
        lang: "eng",
        label: "English",
      },
      {
        id: `${HASH}:3`,
        url: `${ADDON}/subtitles/${TOKEN}/${encodeURIComponent(entry.id)}/${HASH}:3.ass`,
        lang: "rus",
        label: "Russian",
      },
    ]);
  });

  it("skips oversized sidecars and unknown titles or types", async () => {
    const { library, torrServer, entry } = await torrentSetup([
      { id: 1, path: "Movie.mkv", length: 5_000_000 },
      { id: 2, path: "Movie.en.srt", length: MAX_SUBTITLE_BYTES + 1 },
    ]);
    const service = new SubtitleService(library, torrServer);
    expect(
      (await service.list("movie", entry.id, ADDON, TOKEN)).subtitles,
    ).toEqual([]);
    expect(
      (await service.list("series", entry.id, ADDON, TOKEN)).subtitles,
    ).toEqual([]);
    expect(
      (await service.list("movie", "hoshi:missing", ADDON, TOKEN)).subtitles,
    ).toEqual([]);
  });

  it("matches per episode for series", async () => {
    const { library, torrServer, entry } = await torrentSetup(
      [
        { id: 1, path: "Show/Show.S01E01.mkv", length: 10 },
        { id: 2, path: "Show/Show.S01E02.mkv", length: 10 },
        { id: 3, path: "Show/Subs/Show.S01E01.en.srt", length: 10 },
        { id: 4, path: "Show/Subs/Show.S01E02.en.srt", length: 10 },
        { id: 5, path: "Show/Subs/English.srt", length: 10 },
      ],
      { type: "series" },
    );
    const service = new SubtitleService(library, torrServer);
    const second = await service.list(
      "series",
      `${entry.id}:1:2`,
      ADDON,
      TOKEN,
    );
    expect(second.subtitles.map((subtitle) => subtitle.id)).toEqual([
      `${HASH}:4`,
    ]);
  });

  it("fetches through /play, converts SRT to WebVTT, and caches for an hour", async () => {
    const plays: string[] = [];
    const { library, torrServer, entry } = await torrentSetup(
      [
        { id: 1, path: "Movie.mkv", length: 5_000_000 },
        { id: 2, path: "Movie.en.srt", length: SRT.length, body: SRT },
      ],
      { plays },
    );
    const service = new SubtitleService(library, torrServer);
    const first = await service.fetch(entry.id, `${HASH}:2`, "vtt");
    expect(first?.contentType).toBe("text/vtt; charset=utf-8");
    expect(first?.body.toString("utf8")).toBe(VTT);
    const second = await service.fetch(entry.id, `${HASH}:2`, "vtt");
    expect(second).toBe(first);
    expect(plays).toEqual([`/play/${HASH}/2`]);
  });

  it("refuses files that are not subtitles, wrong extensions, and foreign hashes", async () => {
    const { library, torrServer, entry } = await torrentSetup([
      { id: 1, path: "Movie.mkv", length: 10, body: Buffer.from("video") },
      { id: 2, path: "Movie.en.srt", length: SRT.length, body: SRT },
    ]);
    const service = new SubtitleService(library, torrServer);
    expect(await service.fetch(entry.id, `${HASH}:1`, "vtt")).toBeUndefined();
    expect(await service.fetch(entry.id, `${HASH}:2`, "ass")).toBeUndefined();
    expect(
      await service.fetch(entry.id, `${"b".repeat(40)}:2`, "vtt"),
    ).toBeUndefined();
    expect(await service.fetch(entry.id, "garbage", "vtt")).toBeUndefined();
    expect(
      await service.fetch("hoshi:missing", `${HASH}:2`, "vtt"),
    ).toBeUndefined();
  });

  it("evicts the oldest cache entry past the limit", async () => {
    const { library, torrServer, entry } = await torrentSetup([
      { id: 1, path: "Movie.mkv", length: 10 },
      { id: 2, path: "Movie.en.srt", length: SRT.length, body: SRT },
      { id: 3, path: "Movie.fr.srt", length: SRT.length, body: SRT },
    ]);
    const plays: string[] = [];
    const service = new SubtitleService(library, torrServer, {
      maxEntries: 1,
      fetchImpl: (input, init) => {
        plays.push(String(input));
        return fetch(input, init);
      },
    });
    await service.fetch(entry.id, `${HASH}:2`, "vtt");
    await service.fetch(entry.id, `${HASH}:3`, "vtt");
    await service.fetch(entry.id, `${HASH}:2`, "vtt");
    expect(plays).toHaveLength(3);
  });

  it("surfaces upstream failures as errors for the route", async () => {
    const { library, torrServer, entry } = await torrentSetup([
      { id: 1, path: "Movie.mkv", length: 10 },
      { id: 2, path: "Movie.en.srt", length: 10 },
    ]);
    const service = new SubtitleService(library, torrServer);
    await expect(service.fetch(entry.id, `${HASH}:2`, "vtt")).rejects.toThrow(
      /404/,
    );
  });
});

describe("SubtitleService with local sources", () => {
  async function localSetup() {
    const base = await realpath(
      await mkdtemp(join(tmpdir(), "hoshistream-subs-local-")),
    );
    temporary.push(base);
    const folder = join(base, "Movie");
    await mkdir(join(folder, "Subs"), { recursive: true });
    await writeFile(join(folder, "Movie.mkv"), "video");
    await writeFile(join(folder, "Movie.en.srt"), SRT);
    await writeFile(join(folder, "Subs", "Movie.de.vtt"), VTT);
    await writeFile(join(base, "outside.srt"), SRT);
    // A symlink inside the folder pointing outside is never listed (the walk
    // does not follow links) and never served even if its key is guessed.
    await symlink(join(base, "outside.srt"), join(folder, "Movie.fr.srt"));
    const library = new Library(join(base, "library.json"));
    const torrServer = new TorrServerClient("http://127.0.0.1:1", 100, 1);
    const entry = await library.create({
      type: "movie",
      name: "Local movie",
      localFolderPath: folder,
    });
    return { library, torrServer, entry, folder };
  }

  it("lists folder sidecars with path-derived keys and serves them from disk", async () => {
    const { library, torrServer, entry } = await localSetup();
    const service = new SubtitleService(library, torrServer);
    const { subtitles } = await service.list("movie", entry.id, ADDON, TOKEN);
    expect(subtitles.map((subtitle) => [subtitle.lang, subtitle.url])).toEqual([
      [
        "eng",
        `${ADDON}/subtitles/${TOKEN}/${encodeURIComponent(entry.id)}/l:${Buffer.from("Movie.en.srt").toString("base64url")}.vtt`,
      ],
      [
        "ger",
        `${ADDON}/subtitles/${TOKEN}/${encodeURIComponent(entry.id)}/l:${Buffer.from("Subs/Movie.de.vtt").toString("base64url")}.vtt`,
      ],
    ]);
    const english = await service.fetch(
      entry.id,
      `l:${Buffer.from("Movie.en.srt").toString("base64url")}`,
      "vtt",
    );
    expect(english?.body.toString("utf8")).toBe(VTT);
    const german = await service.fetch(
      entry.id,
      `l:${Buffer.from("Subs/Movie.de.vtt").toString("base64url")}`,
      "vtt",
    );
    expect(german?.body.toString("utf8")).toBe(VTT);
  });

  it("refuses paths that resolve outside the entry or were never listed", async () => {
    const { library, torrServer, entry } = await localSetup();
    const service = new SubtitleService(library, torrServer);
    expect(
      await service.fetch(
        entry.id,
        `l:${Buffer.from("Movie.fr.srt").toString("base64url")}`,
        "vtt",
      ),
    ).toBeUndefined();
    expect(
      await service.fetch(
        entry.id,
        `l:${Buffer.from("../outside.srt").toString("base64url")}`,
        "vtt",
      ),
    ).toBeUndefined();
    expect(await service.fetch(entry.id, `${HASH}:2`, "vtt")).toBeUndefined();
  });
});
