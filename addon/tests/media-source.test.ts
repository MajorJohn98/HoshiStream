import { createServer, type Server } from "node:http";
import {
  mkdir,
  mkdtemp,
  realpath,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { diskSourcePath, serveMediaSource } from "../src/media-source.ts";
import { Library } from "../src/library.ts";
import { TorrServerClient } from "../src/torrserver-client.ts";
import { VolumeRegistry } from "../src/volumes.ts";

const temporary: string[] = [];
const servers: Server[] = [];

afterEach(async () => {
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

function listen(server: Server): Promise<string> {
  servers.push(server);
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      resolve(`http://127.0.0.1:${port}`);
    });
  });
}

// Fake TorrServer: status poll plus /play with Range support.
function fakeTorrServer(content: Buffer): Promise<string> {
  return listen(
    createServer((request, response) => {
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
      if (request.url?.startsWith("/play/")) {
        const range = /^bytes=(\d+)-(\d*)$/.exec(request.headers.range ?? "");
        const start = range ? Number(range[1]) : 0;
        const slice = content.subarray(start);
        response.writeHead(range ? 206 : 200, {
          "content-type": "video/fake-torrent",
          "content-length": slice.length,
          ...(range && {
            "content-range": `bytes ${start}-${content.length - 1}/${content.length}`,
          }),
        });
        response.end(request.method === "HEAD" ? undefined : slice);
        return;
      }
      response.writeHead(404).end();
    }),
  );
}

async function setup(content: Buffer, options: { complete?: boolean } = {}) {
  const base = await realpath(
    await mkdtemp(join(tmpdir(), "hoshistream-media-")),
  );
  temporary.push(base);
  const mountBase = join(base, "Volumes");
  const drive = join(mountBase, "Seagate", "HoshiStream");
  await mkdir(join(drive, "Example-1", "Show"), { recursive: true });
  const volumes = new VolumeRegistry(join(base, "volumes.json"), mountBase, 0);
  const volume = await volumes.register(drive);
  const library = new Library(join(base, "library.json"));
  const torrServer = new TorrServerClient(
    await fakeTorrServer(content),
    2_000,
    10,
  );

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
  if (options.complete !== false) {
    await writeFile(join(drive, "Example-1", "Show", "S01E01.mkv"), content);
  }
  await library.setDiskCopy(entry.id, {
    desired: "keep",
    volumeId: volume.id,
    relativeDir: "Example-1",
    // Matches computeSourceRevision for this single selected file; media
    // routing recomputes and compares.
    sourceRevision: (await import("../src/disk-copy.ts")).computeSourceRevision(
      [
        {
          sourceKey: "aaaa:1",
          relativePath: "Show/S01E01.mkv",
          length: content.length,
        },
      ],
    ),
    scope: "all",
    files: [
      {
        sourceKey: "aaaa:1",
        relativePath: "Show/S01E01.mkv",
        length: content.length,
        included: true,
        state: options.complete !== false ? "complete" : "missing",
      },
    ],
    updatedAt: new Date().toISOString(),
  });
  const refreshed = (await library.get(entry.id))!;
  const mediaUrl = await listen(
    createServer((request, response) => {
      void library
        .get(entry.id)
        .then((current) =>
          serveMediaSource(
            request,
            response,
            current!,
            "aaaa:1",
            volumes,
            torrServer,
            library,
          ),
        );
    }),
  );
  return {
    base,
    mountBase,
    drive,
    volumes,
    library,
    entry: refreshed,
    mediaUrl,
  };
}

describe("diskSourcePath", () => {
  it("returns the disk file only when every gate passes", async () => {
    const content = Buffer.from("0123456789".repeat(50));
    const { drive, volumes, entry } = await setup(content);

    const disk = await diskSourcePath(entry, "aaaa:1", volumes);
    expect(disk).toEqual({
      path: join(drive, "Example-1", "Show", "S01E01.mkv"),
      length: content.length,
    });
    // Unknown key and excluded/incomplete files fall back.
    await expect(
      diskSourcePath(entry, "aaaa:9", volumes),
    ).resolves.toBeUndefined();
  });

  it("refuses files whose size no longer matches the manifest", async () => {
    const content = Buffer.from("0123456789".repeat(50));
    const { drive, volumes, entry } = await setup(content);
    await writeFile(join(drive, "Example-1", "Show", "S01E01.mkv"), "tampered");

    await expect(
      diskSourcePath(entry, "aaaa:1", volumes),
    ).resolves.toBeUndefined();
  });

  it("refuses stale manifests when the selection changed", async () => {
    const content = Buffer.from("0123456789".repeat(50));
    const { volumes, library, entry } = await setup(content);
    await library.setInspectionCache(entry.id, {
      hash: "aaaa",
      inspectedAt: new Date().toISOString(),
      selectedFiles: [{ id: 2, path: "Show/S01E01 Better.mkv", length: 999 }],
    });

    const refreshed = (await library.get(entry.id))!;
    await expect(
      diskSourcePath(refreshed, "aaaa:1", volumes),
    ).resolves.toBeUndefined();
  });
});

describe("serveMediaSource", () => {
  it("serves ranges from disk when the volume is online", async () => {
    const content = Buffer.from("0123456789".repeat(50));
    const { mediaUrl } = await setup(content);

    const response = await fetch(mediaUrl, {
      headers: { range: "bytes=10-19" },
    });
    expect(response.status).toBe(206);
    expect(response.headers.get("content-range")).toBe(
      `bytes 10-19/${content.length}`,
    );
    expect(Buffer.from(await response.arrayBuffer())).toEqual(
      content.subarray(10, 20),
    );
  });

  it("falls back to the torrent on the same URL when the drive is gone", async () => {
    const content = Buffer.from("abcdefghij".repeat(50));
    const { base, mountBase, mediaUrl } = await setup(content);

    const fromDisk = await fetch(mediaUrl, { headers: { range: "bytes=0-9" } });
    expect(fromDisk.status).toBe(206);
    expect(fromDisk.headers.get("content-type")).toBe("video/x-matroska");
    expect(Buffer.from(await fromDisk.arrayBuffer())).toEqual(
      content.subarray(0, 10),
    );

    // Unplug (move out of the mount base): the very next range request
    // proxies TorrServer instead.
    await rename(join(mountBase, "Seagate"), join(base, "Detached"));
    const fallback = await fetch(mediaUrl, {
      headers: { range: "bytes=10-" },
    });
    expect(fallback.status).toBe(206);
    expect(fallback.headers.get("content-type")).toBe("video/fake-torrent");
    expect(Buffer.from(await fallback.arrayBuffer())).toEqual(
      content.subarray(10),
    );

    // Replug under a new name: disk serving resumes on the same URL.
    await rename(join(base, "Detached"), join(mountBase, "Seagate 1"));
    const restored = await fetch(mediaUrl, { headers: { range: "bytes=0-4" } });
    expect(restored.status).toBe(206);
    expect(restored.headers.get("content-type")).toBe("video/x-matroska");
    expect(Buffer.from(await restored.arrayBuffer())).toEqual(
      content.subarray(0, 5),
    );
  });

  it("proxies the torrent while the copy is still incomplete", async () => {
    const content = Buffer.from("zyxwvutsrq".repeat(50));
    const { mediaUrl } = await setup(content, { complete: false });

    const response = await fetch(mediaUrl);
    expect(response.status).toBe(200);
    expect(Buffer.from(await response.arrayBuffer())).toEqual(content);
  });
});
