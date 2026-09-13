import { createServer, type Server } from "node:http";
import {
  mkdir,
  mkdtemp,
  realpath,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Archiver } from "../src/archiver.ts";
import { ArchiveSchedule } from "../src/archive-schedule.ts";
import { Library } from "../src/library.ts";
import { TorrServerClient } from "../src/torrserver-client.ts";
import { VolumeRegistry } from "../src/volumes.ts";
import { libraryEntrySchema, type DiskCopyPolicy } from "../src/types.ts";

const HASH = "aaaa";
const EPISODES = 5;
const CONTENT = Buffer.from("episode!".repeat(50));

const temporary: string[] = [];
const servers: Server[] = [];
const archivers: Archiver[] = [];

afterEach(async () => {
  await Promise.all(archivers.splice(0).map((archiver) => archiver.close()));
  await Promise.all(
    servers
      .splice(0)
      .map((server) => new Promise((resolve) => server.close(resolve))),
  );
  await Promise.all(
    temporary
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

const episodePath = (id: number) => `Show/S01E0${id}.mkv`;
const episodes = () =>
  Array.from({ length: EPISODES }, (_, index) => ({
    id: index + 1,
    path: episodePath(index + 1),
    length: CONTENT.length,
    season: 1,
    episode: index + 1,
  }));

// Same fake TorrServer as archiver.test.ts, but the torrent has five files
// that all serve the same bytes so every episode copies identically.
function fakeTorrServer(): Promise<{ url: string }> {
  const server = createServer((request, response) => {
    if (request.method === "POST" && request.url === "/torrents") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          hash: HASH,
          stat: 3,
          stat_string: "Torrent working",
          file_stats: episodes().map(({ id, path, length }) => ({
            id,
            path,
            length,
          })),
        }),
      );
      return;
    }
    if (request.method === "GET" && request.url?.startsWith("/play/")) {
      const range = /^bytes=(\d+)-$/.exec(request.headers.range ?? "");
      const start = range ? Number(range[1]) : 0;
      const slice = CONTENT.subarray(start);
      response.writeHead(range ? 206 : 200, {
        "content-length": slice.length,
        ...(range && {
          "content-range": `bytes ${start}-${CONTENT.length - 1}/${CONTENT.length}`,
        }),
      });
      response.end(slice);
      return;
    }
    response.writeHead(404).end();
  });
  servers.push(server);
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      resolve({ url: `http://127.0.0.1:${port}` });
    });
  });
}

async function setup(options: {
  policy?: DiskCopyPolicy;
  onDisk?: number[];
  included?: number[];
  watched?: number[];
  started?: number;
  streaming?: number[];
}) {
  const base = await realpath(
    await mkdtemp(join(tmpdir(), "hoshistream-policy-")),
  );
  temporary.push(base);
  const mountBase = join(base, "Volumes");
  const drive = join(mountBase, "Seagate", "HoshiStream");
  await mkdir(drive, { recursive: true });
  const volumes = new VolumeRegistry(join(base, "volumes.json"), mountBase, 0);
  const volume = await volumes.register(drive);
  const library = new Library(join(base, "library.json"));
  const { url } = await fakeTorrServer();
  const torrServer = new TorrServerClient(url, 2_000, 10);

  const entry = await library.create({
    type: "series",
    name: "Show",
    magnetUri: `magnet:?xt=urn:btih:${HASH}`,
  });
  await library.setInspectionCache(entry.id, {
    hash: HASH,
    inspectedAt: new Date().toISOString(),
    selectedFiles: episodes(),
  });
  const onDisk = new Set(options.onDisk ?? []);
  const included = new Set(options.included ?? options.onDisk ?? []);
  for (const id of onDisk) {
    const destination = join(drive, "Show-1", episodePath(id));
    await mkdir(join(destination, ".."), { recursive: true });
    await writeFile(destination, CONTENT);
  }
  await library.setDiskCopy(entry.id, {
    desired: "keep",
    volumeId: volume.id,
    relativeDir: "Show-1",
    sourceRevision: "rev1",
    scope: "selected",
    files: episodes().map(({ id, path, length }) => ({
      sourceKey: `${HASH}:${id}`,
      relativePath: path,
      length,
      included: included.has(id),
      state: onDisk.has(id) ? ("complete" as const) : ("missing" as const),
    })),
    ...(options.policy ? { policy: options.policy } : {}),
    updatedAt: new Date().toISOString(),
  });
  for (const fileId of options.watched ?? [])
    await library.setWatchState(entry.id, fileId, "watched");
  if (options.started)
    await library.setWatchState(entry.id, options.started, "started");

  const archiver = new Archiver(library, torrServer, volumes, {
    headroomBytes: 0,
    retryBaseMs: 5,
    playbackYieldMs: 5,
    playbackActive: () => false,
    streamingFiles: () =>
      (options.streaming ?? []).map((fileId) => ({
        entryId: entry.id,
        fileId,
      })),
    schedule: new ArchiveSchedule(join(base, "disk-schedule.json")),
  });
  archivers.push(archiver);
  return { mountBase, drive, library, archiver, entry };
}

async function manifest(library: Library, id: string) {
  const entry = libraryEntrySchema.parse(await library.get(id));
  return new Map(entry.diskCopy!.files.map((file) => [file.sourceKey, file]));
}

const exists = (path: string) =>
  stat(path).then(
    () => true,
    () => false,
  );

describe("Archiver disk-copy policies", () => {
  it("archives the next two episodes and evicts the watched ones", async () => {
    // Nuvio just started S01E03: E01/E02 are watched, E04/E05 not yet on disk.
    const { drive, library, archiver, entry } = await setup({
      policy: { keepAhead: 2, evictWatched: true },
      onDisk: [1, 2, 3],
      watched: [1, 2],
      started: 3,
    });

    await archiver.applyPolicy(entry.id, 3);
    await archiver.settle();

    const files = await manifest(library, entry.id);
    expect(files.get("aaaa:4")).toMatchObject({
      included: true,
      state: "complete",
    });
    expect(files.get("aaaa:5")).toMatchObject({
      included: true,
      state: "complete",
    });
    for (const id of [1, 2]) {
      expect(files.get(`aaaa:${id}`)).toMatchObject({
        included: false,
        state: "missing",
      });
      expect(files.get(`aaaa:${id}`)?.evictedAt).toBeDefined();
      expect(await exists(join(drive, "Show-1", episodePath(id)))).toBe(false);
    }
    // The just-played episode is never touched.
    expect(files.get("aaaa:3")).toMatchObject({
      included: true,
      state: "complete",
    });
    expect(await exists(join(drive, "Show-1", episodePath(3)))).toBe(true);
  });

  it("never evicts a file that is currently streaming", async () => {
    const { drive, library, archiver, entry } = await setup({
      policy: { keepAhead: 1, evictWatched: true },
      onDisk: [1, 2, 3],
      watched: [1, 2],
      streaming: [1],
    });

    await archiver.applyPolicy(entry.id, 2);
    await archiver.settle();

    const files = await manifest(library, entry.id);
    expect(files.get("aaaa:1")?.included).toBe(true);
    expect(await exists(join(drive, "Show-1", episodePath(1)))).toBe(true);
    expect(files.get("aaaa:3")?.included).toBe(true);
  });

  it("keeps watched copies while the drive is offline", async () => {
    const { mountBase, library, archiver, entry } = await setup({
      policy: { keepAhead: 1, evictWatched: true },
      onDisk: [1, 2, 3],
      watched: [1],
    });
    await rm(join(mountBase, "Seagate"), { recursive: true });

    await archiver.applyPolicy(entry.id, 2);

    const files = await manifest(library, entry.id);
    expect(files.get("aaaa:1")).toMatchObject({
      included: true,
      state: "complete",
    });
    expect(files.get("aaaa:1")?.evictedAt).toBeUndefined();
  });

  it("ignores entries without an active policy", async () => {
    const { library, archiver, entry } = await setup({
      onDisk: [1],
      watched: [1],
    });

    await archiver.applyPolicy(entry.id, 1);
    await archiver.settle();

    const files = await manifest(library, entry.id);
    expect([...files.values()].filter((f) => f.included)).toHaveLength(1);
  });
});
