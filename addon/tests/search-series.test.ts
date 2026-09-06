import { createHash, randomUUID } from "node:crypto";
import { mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import bencode from "bencode";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ImportError } from "../src/imports/errors.ts";
import { ImportService } from "../src/imports/service.ts";
import { entryHasHash } from "../src/imports/source-identity.ts";
import { Library } from "../src/library.ts";
import { selectMediaFiles } from "../src/media-file-selection.ts";
import type {
  TorrServerClient,
  TorrentStatus,
} from "../src/torrserver-client.ts";

const roots: string[] = [];
const services: ImportService[] = [];
const primaryHash = "a".repeat(40);

function magnet(hash: string) {
  return `magnet:?xt=urn:btih:${hash}`;
}

function torrentFixture(name = "season.torrent") {
  const info = {
    length: 100,
    name: Buffer.from(name),
    "piece length": 16_384,
    pieces: Buffer.alloc(20, 1),
  };
  return {
    bytes: Buffer.from(bencode.encode({ info })),
    hash: createHash("sha1").update(bencode.encode(info)).digest("hex"),
  };
}

function status(hash: string, paths: string[]): TorrentStatus {
  return {
    hash,
    title: "Fixture",
    stat: 1,
    stat_string: "Ready",
    file_stats: paths.map((path, index) => ({
      id: index + 1,
      path,
      length: 100,
    })),
  };
}

async function fixture(paths = ["Show S02E01.mkv", "Show S02E02.mkv"]) {
  const root = resolve(`.test-import-series-${randomUUID()}`);
  roots.push(root);
  await mkdir(root);
  const libraryPath = join(root, "library.json");
  await writeFile(libraryPath, "[]\n");
  const library = new Library(libraryPath);
  const entry = await library.create({
    name: "Show",
    type: "series",
    magnetUri: magnet(primaryHash),
  });
  const primary = status(primaryHash, ["Show S01E01.mkv", "Show S01E02.mkv"]);
  await library.setInspectionCache(entry.id, {
    hash: primaryHash,
    selectedFiles: selectMediaFiles("series", primary.file_stats),
    inspectedAt: new Date().toISOString(),
  });
  const incoming = status("b".repeat(40), paths);
  const torrServer = {
    addMagnet: vi.fn().mockResolvedValue(incoming),
    addTorrentFile: vi.fn().mockResolvedValue(incoming),
    waitForFiles: vi.fn().mockResolvedValue(incoming),
    get: vi.fn(),
  } as unknown as TorrServerClient;
  const service = new ImportService({
    library,
    torrServer,
    uploadRoot: join(root, "media"),
  });
  await service.initialize();
  services.push(service);
  return { root, library, entry, incoming, torrServer, service };
}

afterEach(async () => {
  await Promise.allSettled(
    services.splice(0).map((service) => service.close()),
  );
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("manual series preview and commit", () => {
  it("requires replacement confirmation, appends once, and replays by receipt after preview cleanup", async () => {
    const { library, entry, incoming, torrServer, service } = await fixture([
      "Better S01E02.mkv",
      "Show S01E03.mkv",
    ]);
    const draft = await service.prepareMagnet({
      magnetUri: magnet(incoming.hash),
    });
    const preview = await service.previewSeries({
      draftId: draft.draftId,
      entryId: entry.id,
    });
    expect(preview.replacements).toEqual([
      {
        season: 1,
        episode: 2,
        previousPath: "Show S01E02.mkv",
        incomingPath: "Better S01E02.mkv",
      },
    ]);
    await expect(
      service.commitSeries({
        previewId: preview.previewId,
        idempotencyKey: randomUUID(),
        allowReplace: false,
      }),
    ).rejects.toThrow(ImportError);

    const input = {
      previewId: preview.previewId,
      idempotencyKey: randomUUID(),
      allowReplace: true,
    };
    const appended = await service.commitSeries(input);
    expect(appended.outcome).toBe("appended");
    expect(appended.entry.extraSources).toEqual([
      { magnetUri: magnet(incoming.hash), sourceHash: incoming.hash },
    ]);
    expect(appended.entry.inspectionCache?.selectedFiles).toMatchObject([
      { id: 1, episode: 1, path: "Show S01E01.mkv" },
      {
        id: 100_001,
        episode: 2,
        path: "Better S01E02.mkv",
        hash: incoming.hash,
      },
      { id: 100_002, episode: 3, path: "Show S01E03.mkv", hash: incoming.hash },
    ]);
    expect(torrServer.addMagnet).toHaveBeenCalledOnce();
    expect((await service.commitSeries(input)).outcome).toBe("existing");
    expect((await library.get(entry.id))?.extraSources).toHaveLength(1);
    await service.close();
  });

  it("drops the draft lease into the preview and requires reprepare after a stale commit", async () => {
    const { root, library, entry, torrServer, service } = await fixture();
    const incoming = torrentFixture();
    const statusWithHash = status(incoming.hash, ["Show S02E01.mkv"]);
    vi.mocked(torrServer.addTorrentFile).mockResolvedValue(statusWithHash);
    vi.mocked(torrServer.waitForFiles).mockResolvedValue(statusWithHash);

    const draft = await service.prepareTorrent(incoming.bytes);
    const preview = await service.previewSeries({
      draftId: draft.draftId,
      entryId: entry.id,
    });
    expect(await readdir(join(root, "media"))).toHaveLength(1);

    await library.setInspectionCache(entry.id, {
      hash: primaryHash,
      inspectedAt: new Date().toISOString(),
      selectedFiles: [
        { id: 1, path: "Show S01E01.mkv", length: 100, season: 1, episode: 1 },
        { id: 2, path: "Show S01E02.mkv", length: 100, season: 1, episode: 2 },
        { id: 3, path: "Show S01E03.mkv", length: 100, season: 1, episode: 3 },
      ],
    });
    await expect(
      service.commitSeries({
        previewId: preview.previewId,
        idempotencyKey: randomUUID(),
        allowReplace: true,
      }),
    ).rejects.toMatchObject({ code: "stale_preview" });
    await expect(
      service.commitSeries({
        previewId: preview.previewId,
        idempotencyKey: randomUUID(),
        allowReplace: true,
      }),
    ).rejects.toMatchObject({ code: "preview_expired" });
    await expect(
      service.previewSeries({
        draftId: draft.draftId,
        entryId: entry.id,
      }),
    ).rejects.toMatchObject({ code: "draft_expired" });
    expect(await readdir(join(root, "media"))).toEqual([]);

    const retryDraft = await service.prepareTorrent(incoming.bytes);
    const retryPreview = await service.previewSeries({
      draftId: retryDraft.draftId,
      entryId: entry.id,
    });
    expect(retryPreview.addedEpisodes).toEqual([
      { season: 2, episode: 1, path: "Show S02E01.mkv" },
    ]);
    await service.discardPreview(retryPreview.previewId);
    expect(await readdir(join(root, "media"))).toEqual([]);
    await service.close();
  });

  it("keeps newest-source-wins semantics and legacy hash dedup after cache invalidation", async () => {
    const { library, entry, incoming, service } = await fixture();
    const firstDraft = await service.prepareMagnet({
      magnetUri: magnet(incoming.hash),
    });
    const firstPreview = await service.previewSeries({
      draftId: firstDraft.draftId,
      entryId: entry.id,
    });
    await service.commitSeries({
      previewId: firstPreview.previewId,
      idempotencyKey: randomUUID(),
      allowReplace: true,
    });
    await library.patch(entry.id, { fileOverrides: [] });
    const stored = (await library.get(entry.id))!;
    expect(stored.inspectionCache).toBeUndefined();
    expect(entryHasHash(stored, incoming.hash.toUpperCase())).toBe(true);
    const duplicate = await service.prepareMagnet({
      magnetUri: magnet(incoming.hash),
    });
    expect(duplicate.existingEntries).toEqual([
      { id: entry.id, name: "Show", type: "series" },
    ]);
    await service.close();
  });
});
