import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { join, resolve } from "node:path";
import bencode from "bencode";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ImportError } from "../src/imports/errors.ts";
import { ImportFiles } from "../src/imports/files.ts";
import { ImportService } from "../src/imports/service.ts";
import {
  magnetHash,
  magnetIdentity,
  torrentIdentity,
} from "../src/imports/source-identity.ts";
import { Library } from "../src/library.ts";
import { NativePicker } from "../src/native-picker.ts";
import { createHandler } from "../src/routes.ts";
import { Tags } from "../src/tags.ts";
import type { AddonInterface } from "../src/server-types.ts";
import type { TorrServerClient } from "../src/torrserver-client.ts";

const roots: string[] = [];
const services: ImportService[] = [];
const token = "manual-import-test-access-token";
const addon: AddonInterface = {
  manifest: { id: "fixture", name: "Fixture" } as AddonInterface["manifest"],
  get: async () => ({ metas: [] }),
};

function torrentFixture(name = "fixture.mp4", length = 100) {
  const info = {
    length,
    name: Buffer.from(name),
    "piece length": 16_384,
    pieces: Buffer.alloc(20, 1),
  };
  const bytes = Buffer.from(bencode.encode({ info }));
  return {
    bytes,
    hash: createHash("sha1").update(bencode.encode(info)).digest("hex"),
  };
}

async function testRoot(prefix: string) {
  const root = resolve(`.${prefix}-${randomUUID()}`);
  roots.push(root);
  await mkdir(root);
  return root;
}

async function temporaryLibrary(prefix: string) {
  const root = await testRoot(prefix);
  const libraryPath = join(root, "library.json");
  await writeFile(libraryPath, "[]\n");
  return {
    root,
    library: new Library(libraryPath),
    tags: new Tags(join(root, "tags.json")),
    uploadRoot: join(root, "media"),
  };
}

function torrServerStub(): TorrServerClient {
  return {
    health: async () => "1.0",
    list: async () => [],
    get: async () => {
      throw new Error("unused");
    },
    streamUrl: () => "http://127.0.0.1/stream",
  } as unknown as TorrServerClient;
}

beforeEach(() => {
  roots.length = 0;
});

afterEach(async () => {
  await Promise.allSettled(
    services.splice(0).map((service) => service.close()),
  );
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("manual import identities and commits", () => {
  it("parses torrent and magnet identities without network access", async () => {
    const { bytes, hash } = torrentFixture("Suggested Name.mp4");
    await expect(torrentIdentity(bytes)).resolves.toEqual({
      hash,
      sizeBytes: 100,
      suggestedName: "Suggested Name.mp4",
    });
    expect(
      magnetIdentity(
        `magnet:?dn=Suggested%20Name&xt=urn:btih:${hash.toUpperCase()}`,
      ),
    ).toEqual({
      hash,
      suggestedName: "Suggested Name",
    });
    expect(
      magnetHash("magnet:?xt=urn:btih:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"),
    ).toBe("0".repeat(40));
    expect(() => magnetIdentity("magnet:?xt=urn:btmh:1220abc")).toThrow(
      ImportError,
    );
    expect(() =>
      magnetIdentity(
        `magnet:?xt=urn:btih:${hash}&xt=urn:btih:${"b".repeat(40)}`,
      ),
    ).toThrow(ImportError);
    await expect(torrentIdentity(Buffer.from("garbage"))).rejects.toThrow(
      ImportError,
    );
  });

  it("prepares drafts without leaking file paths and reports legacy duplicates", async () => {
    const { library, tags, uploadRoot, root } = await temporaryLibrary(
      "test-import-prepare",
    );
    const { hash, bytes } = torrentFixture();
    const legacy = await library.importSearch(
      {
        type: "movie",
        name: "Legacy curated",
        magnetUri: `magnet:?xt=urn:btih:${hash}`,
      },
      {
        providerId: "curated",
        catalogId: "legacy-film",
        hash,
        rightsUrl: "https://example.org/rights",
        license: "CC-BY",
      },
      { key: randomUUID(), fingerprint: "a".repeat(64) },
    );
    const service = new ImportService({
      library,
      tags,
      torrServer: torrServerStub(),
      uploadRoot,
    });
    services.push(service);
    const magnet = await service.prepareMagnet({
      magnetUri: `magnet:?dn=Legacy%20curated&xt=urn:btih:${hash}`,
    });
    expect(magnet).toEqual({
      draftId: magnet.draftId,
      expiresAt: magnet.expiresAt,
      hash,
      suggestedName: "Legacy curated",
      existingEntries: [
        { id: legacy.entry.id, name: "Legacy curated", type: "movie" },
      ],
    });
    const torrent = await service.prepareTorrent(bytes);
    expect(torrent.hash).toBe(hash);
    expect(torrent.existingEntries).toEqual(magnet.existingEntries);
    expect(JSON.stringify(torrent)).not.toContain(root);
    await service.close();
  });

  it("commits neutral torrents, replays receipts before draft lookup, and deduplicates by hash", async () => {
    const { library, tags, uploadRoot } =
      await temporaryLibrary("test-import-commit");
    const { bytes, hash } = torrentFixture();
    const service = new ImportService({
      library,
      tags,
      torrServer: torrServerStub(),
      uploadRoot,
    });
    services.push(service);
    await service.initialize();
    const draft = await service.prepareTorrent(bytes);
    const input = {
      draftId: draft.draftId,
      name: "Manual torrent",
      type: "movie" as const,
      idempotencyKey: randomUUID(),
    };
    const created = await service.commit(input);
    expect(created.outcome).toBe("created");
    expect(created.entry).toMatchObject({
      name: "Manual torrent",
      type: "movie",
      managedMedia: true,
      sourceHash: hash,
    });
    expect(created.entry.searchImport).toBeUndefined();
    expect(await readFile(created.entry.torrentFilePath!)).toEqual(bytes);

    const replay = await service.commit(input);
    expect(replay).toEqual({ entry: created.entry, outcome: "existing" });

    const duplicate = await service.prepareTorrent(bytes);
    const deduped = await service.commit({
      draftId: duplicate.draftId,
      name: "Duplicate",
      type: "movie",
      idempotencyKey: randomUUID(),
    });
    expect(deduped.outcome).toBe("existing");
    expect(deduped.entry.id).toBe(created.entry.id);
    expect(await library.list()).toHaveLength(1);
    expect(await readdir(uploadRoot)).toHaveLength(1);
    await service.close();
  });

  it("expires unused drafts while keeping committed managed torrents", async () => {
    const { library, tags, uploadRoot } = await temporaryLibrary(
      "test-import-cleanup",
    );
    const { bytes } = torrentFixture();
    let now = Date.now();
    const service = new ImportService({
      library,
      tags,
      torrServer: torrServerStub(),
      uploadRoot,
      now: () => now,
    });
    services.push(service);
    await service.initialize();

    const expiring = await service.prepareTorrent(bytes);
    expect(await readdir(uploadRoot)).toHaveLength(1);
    now += 10 * 60 * 1_000 + 1;
    await service.prepareMagnet({
      magnetUri: `magnet:?xt=urn:btih:${"b".repeat(40)}`,
    });
    expect(await readdir(uploadRoot)).toEqual([]);

    const committedDraft = await service.prepareTorrent(bytes);
    const committed = await service.commit({
      draftId: committedDraft.draftId,
      name: "Committed",
      type: "movie",
      idempotencyKey: randomUUID(),
    });
    now += 10 * 60 * 1_000 + 1;
    await service.prepareMagnet({
      magnetUri: `magnet:?xt=urn:btih:${"c".repeat(40)}`,
    });
    expect(await readFile(committed.entry.torrentFilePath!)).toEqual(bytes);
    await service.close();
    expect(expiring.draftId).toBeDefined();
  });
});

describe("manual import staging and routes", () => {
  it("reclaims only unreferred staged files during sweeps", async () => {
    const { library, uploadRoot } = await temporaryLibrary("test-import-files");
    const files = new ImportFiles(uploadRoot);
    const { bytes } = torrentFixture();
    const kept = await files.stage(bytes);
    const discarded = await files.stage(bytes);
    await library.create({
      type: "movie",
      name: "Committed",
      torrentFilePath: kept,
    });
    await files.sweep(library, Date.now() + 11 * 60 * 1_000, [], 0);
    expect(await readFile(kept)).toEqual(bytes);
    await expect(readFile(discarded)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("serves the imports API and returns 404 for removed search endpoints", async () => {
    const { library, tags, uploadRoot, root } =
      await temporaryLibrary("test-import-routes");
    const entry = await library.create({
      type: "series",
      name: "Inspectable",
      magnetUri: "magnet:?xt=urn:btih:" + "a".repeat(40),
    });
    await library.setInspectionCache(entry.id, {
      hash: "a".repeat(40),
      inspectedAt: new Date().toISOString(),
      selectedFiles: [
        { id: 1, path: "Show S01E01.mkv", length: 100, season: 1, episode: 1 },
      ],
    });
    await library.create({
      type: "series",
      name: "Local series",
      localFolderPath: root,
    });
    const imports = new ImportService({
      library,
      tags,
      torrServer: torrServerStub(),
      uploadRoot,
    });
    services.push(imports);
    await imports.initialize();
    const server = createServer(
      createHandler({
        library,
        imports,
        addon,
        torrServer: torrServerStub(),
        accessToken: token,
        homeSpeedMbps: 100,
        nativePicker: new NativePicker(join(root, "missing.sock")),
        publicUrls: {
          addonUrl: "http://127.0.0.1:7000",
          torrServerUrl: "http://127.0.0.1:8090",
        },
      }),
    );
    let base = "";
    try {
      await new Promise<void>((resolve) =>
        server.listen(0, "127.0.0.1", resolve),
      );
      const address = server.address();
      if (!address || typeof address === "string")
        throw new Error("Missing port");
      base = `http://127.0.0.1:${address.port}`;
      const headers = { authorization: `Bearer ${token}` };

      const capabilities = await fetch(`${base}/api/imports/capabilities`, {
        headers,
      });
      expect(await capabilities.json()).toEqual({
        version: 1,
        maxTorrentBytes: 1_000_000,
      });
      expect(capabilities.headers.get("cache-control")).toContain("no-store");

      const entriesBefore = await library.list();
      const magnetUri = `magnet:?xt=urn:btih:${"c".repeat(40)}&dn=Native%20review`;
      const linkResponse = await fetch(`${base}/api/imports/magnet-links`, {
        method: "POST",
        headers: { ...headers, "content-type": "application/json" },
        body: JSON.stringify({ magnetUri }),
      });
      expect(linkResponse.status).toBe(200);
      expect(linkResponse.headers.get("cache-control")).toContain("no-store");
      const ticket = await linkResponse.json();
      expect(ticket).not.toHaveProperty("magnetUri");
      const linkUrl = `${base}/api/imports/magnet-links/${ticket.id}`;
      expect((await fetch(linkUrl)).status).toBe(401);
      expect(
        (
          await fetch(`${base}/api/imports/magnet-links`, {
            method: "POST",
            body: JSON.stringify({ magnetUri }),
          })
        ).status,
      ).toBe(401);
      const readLink = await fetch(linkUrl, { headers });
      expect(readLink.headers.get("cache-control")).toContain("no-store");
      expect(await readLink.json()).toMatchObject({
        ...ticket,
        magnetUri,
        suggestedName: "Native review",
      });
      expect(await library.list()).toEqual(entriesBefore);
      expect(
        (
          await fetch(`${base}/api/imports/magnet-links/${randomUUID()}`, {
            headers,
          })
        ).status,
      ).toBe(410);

      const series = await fetch(`${base}/api/imports/series`, { headers });
      expect(await series.json()).toEqual({
        entries: [
          {
            id: entry.id,
            name: "Inspectable",
            inspected: true,
            sourceCount: 1,
          },
        ],
      });

      const { bytes, hash } = torrentFixture();
      const prepared = await fetch(`${base}/api/imports/prepare-torrent`, {
        method: "POST",
        headers: {
          ...headers,
          "content-type": "application/x-bittorrent",
        },
        body: bytes,
      });
      const draft = await prepared.json();
      expect(draft).toMatchObject({ hash, existingEntries: [] });

      const committed = await fetch(`${base}/api/imports/commit`, {
        method: "POST",
        headers: {
          ...headers,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          draftId: draft.draftId,
          name: "Route import",
          type: "movie",
          idempotencyKey: randomUUID(),
        }),
      });
      expect(committed.status).toBe(201);
      expect((await committed.json()).outcome).toBe("created");

      expect(
        (await fetch(`${base}/api/search/providers`, { headers })).status,
      ).toBe(404);
      expect(
        (await fetch(`${base}/api/search`, { method: "POST", headers })).status,
      ).toBe(404);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await imports.close();
    }
  });
});
