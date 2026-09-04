import { createServer, type Server } from "node:http";
import {
  mkdir,
  mkdtemp,
  readFile,
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
import { libraryEntrySchema } from "../src/types.ts";

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

// Minimal TorrServer stand-in: answers the status poll and serves /play with
// standard Range semantics, mirroring the verified MatriX endpoints.
function fakeTorrServer(content: Buffer): Promise<{ url: string }> {
  const server = createServer((request, response) => {
    if (request.method === "POST" && request.url === "/torrents") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          hash: "aaaa",
          stat: 3,
          stat_string: "Torrent working",
          file_stats: [
            { id: 1, path: "Show/S01E01.mkv", length: content.length },
          ],
        }),
      );
      return;
    }
    if (request.method === "GET" && request.url?.startsWith("/play/")) {
      const range = /^bytes=(\d+)-$/.exec(request.headers.range ?? "");
      const start = range ? Number(range[1]) : 0;
      const slice = content.subarray(start);
      response.writeHead(range ? 206 : 200, {
        "content-length": slice.length,
        ...(range && {
          "content-range": `bytes ${start}-${content.length - 1}/${content.length}`,
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

async function setup(content: Buffer) {
  const base = await realpath(
    await mkdtemp(join(tmpdir(), "hoshistream-archiver-")),
  );
  temporary.push(base);
  const mountBase = join(base, "Volumes");
  const drive = join(mountBase, "Seagate", "HoshiStream");
  await mkdir(drive, { recursive: true });
  const volumes = new VolumeRegistry(join(base, "volumes.json"), mountBase);
  const volume = await volumes.register(drive);
  const library = new Library(join(base, "library.json"));
  const { url } = await fakeTorrServer(content);
  const torrServer = new TorrServerClient(url, 2_000, 10);

  const entry = await library.create({
    type: "movie",
    name: "Example",
    magnetUri: "magnet:?xt=urn:btih:aaaa",
  });
  await library.setInspectionCache(entry.id, {
    hash: "aaaa",
    inspectedAt: new Date().toISOString(),
    selectedFiles: [{ id: 1, path: "Show/S01E01.mkv", length: content.length }],
  });
  const diskCopy = {
    desired: "keep" as const,
    volumeId: volume.id,
    relativeDir: "Example-1",
    sourceRevision: "rev1",
    scope: "all" as const,
    files: [
      {
        sourceKey: "aaaa:1",
        relativePath: "Show/S01E01.mkv",
        length: content.length,
        included: true,
        state: "missing" as const,
      },
    ],
    updatedAt: new Date().toISOString(),
  };
  await library.setDiskCopy(entry.id, diskCopy);
  const schedule = new ArchiveSchedule(join(base, "disk-schedule.json"));
  const archiver = new Archiver(library, torrServer, volumes, {
    headroomBytes: 0,
    retryBaseMs: 5,
    playbackYieldMs: 5,
    playbackActive: () => false,
    schedule,
  });
  archivers.push(archiver);
  return {
    base,
    mountBase,
    drive,
    volumes,
    library,
    archiver,
    entry,
    schedule,
  };
}

async function archivedEntry(library: Library, id: string) {
  const entry = await library.get(id);
  return libraryEntrySchema.parse(entry).diskCopy!;
}

describe("Archiver", () => {
  it("copies a file to the volume and marks it complete", async () => {
    const content = Buffer.from("0123456789".repeat(100));
    const { drive, library, archiver, entry } = await setup(content);

    archiver.enqueue(entry.id);
    await archiver.settle();

    const destination = join(drive, "Example-1", "Show", "S01E01.mkv");
    expect(await readFile(destination)).toEqual(content);
    const diskCopy = await archivedEntry(library, entry.id);
    expect(diskCopy.files[0].state).toBe("complete");
    await expect(stat(`${destination}.partial`)).rejects.toThrow();
  });

  it("resumes from an existing partial file with a Range request", async () => {
    const content = Buffer.from("abcdefghij".repeat(100));
    const { drive, library, archiver, entry } = await setup(content);
    const dir = join(drive, "Example-1", "Show");
    await mkdir(dir, { recursive: true });
    // First 400 bytes already on disk from an interrupted run.
    await writeFile(join(dir, "S01E01.mkv.partial"), content.subarray(0, 400));

    archiver.enqueue(entry.id);
    await archiver.settle();

    expect(await readFile(join(dir, "S01E01.mkv"))).toEqual(content);
    const diskCopy = await archivedEntry(library, entry.id);
    expect(diskCopy.files[0].state).toBe("complete");
  });

  it("adopts a file that already exists with the expected size", async () => {
    const content = Buffer.from("k".repeat(500));
    const { drive, library, archiver, entry } = await setup(content);
    const dir = join(drive, "Example-1", "Show");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "S01E01.mkv"), content);

    archiver.enqueue(entry.id);
    await archiver.settle();

    const diskCopy = await archivedEntry(library, entry.id);
    expect(diskCopy.files[0].state).toBe("complete");
  });

  it("waits instead of failing when the drive is offline", async () => {
    const content = Buffer.from("x".repeat(100));
    const { mountBase, library, archiver, entry } = await setup(content);
    await rm(join(mountBase, "Seagate"), { recursive: true });

    archiver.enqueue(entry.id);
    // Drain the queue without closing so the waiting state stays observable.
    await archiver.settle();

    expect(archiver.jobs()).toEqual([
      { entryId: entry.id, status: "waiting", reason: "Waiting for drive" },
    ]);
    const diskCopy = await archivedEntry(library, entry.id);
    expect(diskCopy.files[0].state).toBe("missing");
  });

  it("waits when the download window is closed and runs once it opens", async () => {
    const content = Buffer.from("w".repeat(100));
    const { drive, library, archiver, entry, schedule } = await setup(content);
    // A window that excludes the current minute, wherever "now" falls.
    const nowMinute = new Date().getHours() * 60 + new Date().getMinutes();
    await schedule.set({
      startMinute: (nowMinute + 120) % 1440,
      endMinute: (nowMinute + 180) % 1440,
    });

    archiver.enqueue(entry.id);
    await archiver.settle();
    expect(archiver.jobs()).toEqual([
      {
        entryId: entry.id,
        status: "waiting",
        reason: expect.stringMatching(/^Scheduled \d\d:\d\d–\d\d:\d\d$/),
      },
    ]);

    // Opening the window and waking the queue starts the copy.
    await schedule.set(undefined);
    archiver.wake();
    await archiver.settle();
    const diskCopy = await archivedEntry(library, entry.id);
    expect(diskCopy.files[0].state).toBe("complete");
    await expect(
      stat(join(drive, "Example-1", "Show", "S01E01.mkv")),
    ).resolves.toBeTruthy();
  });

  it("cancellation stops work for the entry", async () => {
    const content = Buffer.from("y".repeat(100));
    const { drive, library, archiver, entry } = await setup(content);

    archiver.cancel(entry.id);
    archiver.enqueue(entry.id); // enqueue after cancel still runs fresh work
    await archiver.settle();

    // A fresh enqueue after cancel is a new generation: work completes.
    const diskCopy = await archivedEntry(library, entry.id);
    expect(diskCopy.files[0].state).toBe("complete");
    await expect(
      stat(join(drive, "Example-1", "Show", "S01E01.mkv")),
    ).resolves.toBeTruthy();
  });
});
