import { createServer, type Server } from "node:http";
import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { IdentityStore } from "../src/identity.ts";
import { Library } from "../src/library.ts";
import { manifest } from "../src/manifest.ts";
import { getMetadata } from "../src/metadata.ts";
import { NativePicker } from "../src/native-picker.ts";
import { createHandler } from "../src/routes.ts";
import type { AddonInterface } from "../src/server-types.ts";
import { Tags } from "../src/tags.ts";
import { ThumbnailService } from "../src/thumbnail-service.ts";
import type { TorrServerClient } from "../src/torrserver-client.ts";

let stateDir: string;
beforeEach(async () => {
  stateDir = await mkdtemp(join(tmpdir(), "hoshi-thumbs-"));
});
afterEach(async () => {
  await rm(stateDir, { recursive: true, force: true });
});

const torrServer = {
  health: async () => "1.0",
  list: async () => [],
} as unknown as TorrServerClient;

// A fake ffprobe/ffmpeg pair: ffprobe reports a duration, ffmpeg writes a
// small "jpeg" to the partial path it was handed.
function fakeRunner(options: { duration?: string; fail?: boolean } = {}) {
  const calls: { command: string; args: string[] }[] = [];
  const run = vi.fn(async (command: string, args: string[]) => {
    calls.push({ command, args });
    if (command === "ffprobe") return { stdout: options.duration ?? "120\n" };
    if (options.fail) throw new Error("ffmpeg exploded");
    const target = args[args.length - 1];
    await writeFile(target, "jpegbytes");
    return { stdout: "" };
  });
  return { run, calls };
}

async function localSeries(library: Library, name = "Local Show") {
  const folder = join(stateDir, name);
  await mkdir(folder, { recursive: true });
  await writeFile(join(folder, "Show.S01E01.Pilot.mkv"), "x");
  await writeFile(join(folder, "Show.S01E02.Second.mkv"), "x");
  await writeFile(join(folder, "Show.S02E01.mkv"), "x");
  return library.create({ type: "series", name, localFolderPath: folder });
}

describe("ThumbnailService", () => {
  it("grabs one frame per on-disk episode at 20% and skips existing ones", async () => {
    const library = new Library(join(stateDir, "library.json"));
    const entry = await localSeries(library);
    const { run, calls } = fakeRunner();
    const service = new ThumbnailService(library, torrServer, {
      dir: join(stateDir, "thumbs"),
      ffmpegPath: "ffmpeg",
      ffprobePath: "ffprobe",
      run,
    });
    expect(await service.episodesOnDisk(entry)).toHaveLength(3);

    expect(service.generate(entry.id)).toBe(true);
    // A second request while running is refused.
    expect(service.generate(entry.id)).toBe(false);
    expect(service.statusFor(entry.id).running).toBe(true);
    await service.idle();

    expect(service.statusFor(entry.id)).toMatchObject({
      running: false,
      generated: 3,
      failed: 0,
    });
    expect(await service.available(entry.id)).toEqual([
      { season: 1, episode: 1 },
      { season: 1, episode: 2 },
      { season: 2, episode: 1 },
    ]);
    const ffmpeg = calls.filter((call) => call.command === "ffmpeg");
    expect(ffmpeg).toHaveLength(3);
    const args = ffmpeg[0].args;
    expect(args.slice(args.indexOf("-ss"), args.indexOf("-ss") + 2)).toEqual([
      "-ss",
      "24",
    ]);
    expect(args).toContain("scale=480:-2");
    expect(args[args.length - 1]).toMatch(/\.partial$/);
    expect(args[args.indexOf("-i") + 1]).toMatch(/Show\.S01E01\.Pilot\.mkv$/);
    // Partials are gone; the frame is where the route expects it.
    const frame = await service.statFrame(entry.id, 1, 1);
    expect(frame?.size).toBe("jpegbytes".length);
    await expect(stat(`${frame?.path}.partial`)).rejects.toThrow();

    // Re-running skips everything already on disk unless forced.
    run.mockClear();
    service.generate(entry.id);
    await service.idle();
    expect(run).not.toHaveBeenCalled();
    service.generate(entry.id, { force: true });
    await service.idle();
    expect(run.mock.calls.filter(([c]) => c === "ffmpeg")).toHaveLength(3);

    await service.remove(entry.id);
    expect(await service.available(entry.id)).toEqual([]);
  });

  it("counts failures, falls back to 60 s without a duration, and ignores movies", async () => {
    const library = new Library(join(stateDir, "library.json"));
    const entry = await localSeries(library);
    const { run, calls } = fakeRunner({ duration: "garbage", fail: true });
    const service = new ThumbnailService(library, torrServer, {
      dir: join(stateDir, "thumbs"),
      run,
    });
    service.generate(entry.id);
    await service.idle();
    expect(service.statusFor(entry.id)).toMatchObject({
      running: false,
      generated: 0,
      failed: 3,
      lastError: "ffmpeg exploded",
    });
    expect(calls.find((c) => c.command === "ffmpeg")?.args).toContain("60");
    expect(await service.available(entry.id)).toEqual([]);

    const movie = await library.create({
      type: "movie",
      name: "Film",
      localFilePath: join(stateDir, "Local Show", "Show.S01E01.Pilot.mkv"),
    });
    expect(await service.episodesOnDisk(movie)).toEqual([]);
  });

  it("rejects path escapes", () => {
    const service = new ThumbnailService(
      new Library(join(stateDir, "library.json")),
      torrServer,
      { dir: join(stateDir, "thumbs"), run: fakeRunner().run },
    );
    expect(() => service.pathFor("x", -1, 1)).not.toThrow();
    expect(service.pathFor("id", 1, 2)).toMatch(/\/1\/2\.jpg$/);
  });
});

describe("episode routes", () => {
  const TOKEN = "an-access-token-for-thumbnail-tests";
  const addon: AddonInterface = {
    manifest,
    get: async (resource, type) => ({ resource, type, metas: [] }),
  };
  let server: Server;
  let baseUrl: string;
  let library: Library;
  let thumbnails: ThumbnailService;

  beforeEach(async () => {
    const tagsPath = join(stateDir, "tags.json");
    await writeFile(tagsPath, JSON.stringify({ tags: [] }));
    library = new Library(join(stateDir, "library.json"));
    thumbnails = new ThumbnailService(library, torrServer, {
      dir: join(stateDir, "thumbs"),
      run: fakeRunner().run,
    });
    server = createServer(
      createHandler({
        library,
        addon,
        torrServer,
        accessToken: TOKEN,
        homeSpeedMbps: 100,
        nativePicker: new NativePicker(join(stateDir, "missing.sock")),
        publicUrls: {
          addonUrl: "http://addon.test",
          torrServerUrl: "http://torrserver.test",
        },
        lanRedirect: "off",
        tags: new Tags(tagsPath),
        identity: new IdentityStore(join(stateDir, "identity.json")),
        thumbnails,
      }),
    );
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("no port");
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  afterEach(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  const api = (path: string, init: RequestInit = {}) =>
    fetch(`${baseUrl}${path}`, {
      ...init,
      headers: {
        authorization: `Bearer ${TOKEN}`,
        "content-type": "application/json",
        ...(init.headers ?? {}),
      },
    });

  it("lists episodes with cleaned titles, disk state and frames, and stores overrides", async () => {
    const entry = await localSeries(library);
    const first = await api(`/api/library/${entry.id}/episodes`);
    expect(first.status).toBe(200);
    const listed = await first.json();
    expect(listed.inspected).toBe(true);
    expect(listed.eligible).toBe(3);
    expect(listed.thumbnails).toMatchObject({ running: false });
    expect(listed.episodes).toHaveLength(3);
    expect(listed.episodes[0]).toMatchObject({
      season: 1,
      episode: 1,
      defaultTitle: "Pilot",
      onDisk: true,
      thumbnail: null,
    });
    expect(listed.episodes[2].defaultTitle).toBe("Episode 1");

    // Generation: 202, then 409 while the run is queued.
    const queued = await api(`/api/library/${entry.id}/thumbnails`, {
      method: "POST",
      body: JSON.stringify({}),
    });
    expect(queued.status).toBe(202);
    const again = await api(`/api/library/${entry.id}/thumbnails`, {
      method: "POST",
    });
    expect(again.status).toBe(409);
    expect((await again.json()).code).toBe("thumbnails_running");
    await thumbnails.idle();
    const status = await api(`/api/library/${entry.id}/thumbnails`);
    expect(await status.json()).toMatchObject({
      running: false,
      generated: 3,
      available: [
        { season: 1, episode: 1 },
        { season: 1, episode: 2 },
        { season: 2, episode: 1 },
      ],
    });

    // Overrides land through PATCH and surface in the list.
    const patched = await api(`/api/library/${entry.id}`, {
      method: "PATCH",
      body: JSON.stringify({
        ongoing: true,
        episodes: {
          "1:1": {
            title: "The Pilot",
            overview: "It begins.",
            released: "2024-01-05T00:00:00.000Z",
          },
        },
      }),
    });
    expect(patched.status).toBe(200);
    const after = await (await api(`/api/library/${entry.id}/episodes`)).json();
    expect(after.episodes[0]).toMatchObject({
      title: "The Pilot",
      overview: "It begins.",
      released: "2024-01-05T00:00:00.000Z",
    });
    // Frame URLs follow the request host so the management UI can load
    // them from wherever it is being served.
    expect(after.episodes[0].thumbnail).toBe(
      `${baseUrl}/thumbnails/${TOKEN}/${encodeURIComponent(entry.id)}/1/1.jpg`,
    );
    expect((await library.get(entry.id))?.ongoing).toBe(true);

    // Null clears both fields.
    await api(`/api/library/${entry.id}`, {
      method: "PATCH",
      body: JSON.stringify({ episodes: null, ongoing: false }),
    });
    const cleared = await library.get(entry.id);
    expect(cleared).not.toHaveProperty("episodes");
    expect(cleared).not.toHaveProperty("ongoing");

    // Deleting the entry removes its frames.
    await api(`/api/library/${entry.id}`, { method: "DELETE" });
    expect(await thumbnails.available(entry.id)).toEqual([]);
  });

  it("refuses movies and reports uninspected torrent series", async () => {
    const movie = await library.create({
      type: "movie",
      name: "Film",
      magnetUri: "magnet:?xt=urn:btih:film",
    });
    expect((await api(`/api/library/${movie.id}/episodes`)).status).toBe(400);
    expect(
      (await api(`/api/library/${movie.id}/thumbnails`, { method: "POST" }))
        .status,
    ).toBe(400);
    const series = await library.create({
      type: "series",
      name: "Show",
      magnetUri: "magnet:?xt=urn:btih:show",
    });
    const listed = await (
      await api(`/api/library/${series.id}/episodes`)
    ).json();
    expect(listed).toMatchObject({
      inspected: false,
      episodes: [],
      eligible: 0,
    });
    expect((await api("/api/library/nope/episodes")).status).toBe(404);
  });

  it("serves frames with ETag caching under the token and 404s otherwise", async () => {
    const entry = await localSeries(library);
    thumbnails.generate(entry.id);
    await thumbnails.idle();
    const path = `/thumbnails/${TOKEN}/${entry.id}/1/1.jpg`;
    const ok = await fetch(`${baseUrl}${path}`);
    expect(ok.status).toBe(200);
    expect(ok.headers.get("content-type")).toBe("image/jpeg");
    expect(ok.headers.get("cache-control")).toContain("max-age=604800");
    const etag = ok.headers.get("etag");
    expect(etag).toMatch(/^"[0-9a-f]+-[0-9a-f]+"$/);
    expect(await ok.text()).toBe("jpegbytes");

    const cached = await fetch(`${baseUrl}${path}`, {
      headers: { "if-none-match": etag ?? "" },
    });
    expect(cached.status).toBe(304);
    const head = await fetch(`${baseUrl}${path}`, { method: "HEAD" });
    expect(head.status).toBe(200);
    expect(await head.text()).toBe("");

    expect(
      (await fetch(`${baseUrl}/thumbnails/${TOKEN}/${entry.id}/1/9.jpg`))
        .status,
    ).toBe(404);
    expect(
      (await fetch(`${baseUrl}/thumbnails/wrong-token/${entry.id}/1/1.jpg`))
        .status,
    ).toBe(404);
  });
});

describe("series meta with episode details", () => {
  it("uses cleaned titles, overrides, thumbnails and the ongoing hint", async () => {
    const library = new Library(join(stateDir, "library.json"));
    const entry = await localSeries(library);
    const thumbnails = new ThumbnailService(library, torrServer, {
      dir: join(stateDir, "thumbs"),
      run: fakeRunner().run,
    });
    thumbnails.generate(entry.id);
    await thumbnails.idle();
    await library.patch(entry.id, {
      ongoing: true,
      episodes: {
        "1:2": {
          title: "Renamed",
          overview: "Second outing.",
          released: "2024-02-02T00:00:00.000Z",
        },
      },
    });
    const embed = {
      torrServer,
      publicTorrServerUrl: "https://ts.example",
      publicAddonUrl: "https://addon.example",
      accessToken: "token",
    };
    const meta = await getMetadata(
      library,
      torrServer,
      "series",
      entry.id,
      embed,
      thumbnails,
    );
    const videos = meta.meta?.videos ?? [];
    expect(videos.map((video) => video.title)).toEqual([
      "Pilot",
      "Renamed",
      "Episode 1",
    ]);
    expect(videos[1]).toMatchObject({
      overview: "Second outing.",
      released: "2024-02-02T00:00:00.000Z",
      thumbnail: `https://addon.example/thumbnails/token/${encodeURIComponent(entry.id)}/1/2.jpg`,
    });
    expect(videos[0]).not.toHaveProperty("overview");
    expect(videos[0].released).toBe(entry.createdAt);
    expect(meta.meta?.behaviorHints).toMatchObject({
      hasScheduledVideos: true,
    });

    // Without embed options there are no thumbnail URLs to hand out.
    const plain = await getMetadata(library, torrServer, "series", entry.id);
    expect(plain.meta?.videos?.[0]).not.toHaveProperty("thumbnail");
    expect(plain.meta?.behaviorHints).toMatchObject({
      hasScheduledVideos: true,
    });
  });
});
