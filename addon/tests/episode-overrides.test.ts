import { randomUUID } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { inspectEntry, resolveStreamSource } from "../src/inspection.ts";
import { Library } from "../src/library.ts";
import {
  applyEpisodeOverrides,
  type SelectedFile,
} from "../src/media-file-selection.ts";
import type { TorrServerClient } from "../src/torrserver-client.ts";
import { episodeOverridesSchema, patchEntrySchema } from "../src/types.ts";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function temporaryLibrary() {
  const directory = resolve(`.test-episode-overrides-${randomUUID()}`);
  directories.push(directory);
  await mkdir(directory);
  const path = join(directory, "library.json");
  await writeFile(path, "[]\n");
  return new Library(path);
}

const files: SelectedFile[] = [
  { id: 1, path: "Show S01E01.mkv", length: 100, season: 1, episode: 1 },
  { id: 2, path: "Show S01E02.mkv", length: 100, season: 1, episode: 2 },
  { id: 3, path: "Show S01E03.mkv", length: 100, season: 1, episode: 3 },
];

describe("applyEpisodeOverrides", () => {
  it("leaves the automatic mapping alone without overrides", () => {
    expect(applyEpisodeOverrides(files)).toBe(files);
    expect(applyEpisodeOverrides(files, [])).toBe(files);
  });

  it("moves overridden files and re-sorts by season and episode", () => {
    const result = applyEpisodeOverrides(files, [
      { id: 1, season: 1, episode: 4 },
    ]);
    expect(result.map((file) => [file.id, file.season, file.episode])).toEqual([
      [2, 1, 2],
      [3, 1, 3],
      [1, 1, 4],
    ]);
  });

  it("drops an automatically mapped file displaced by an override", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const result = applyEpisodeOverrides(files, [
      { id: 3, season: 1, episode: 1 },
    ]);
    expect(result.map((file) => file.id)).toEqual([3, 2]);
    expect(log).toHaveBeenCalledWith(
      expect.stringContaining('"event":"episode_override_shadowed"'),
    );
    log.mockRestore();
  });

  it("ignores overrides for files that are no longer selected", () => {
    const result = applyEpisodeOverrides(files, [
      { id: 99, season: 3, episode: 1 },
    ]);
    expect(result).toEqual(files);
  });

  it("can move a file to another season", () => {
    const result = applyEpisodeOverrides(files, [
      { id: 3, season: 0, episode: 1 },
    ]);
    expect(result[0]).toMatchObject({ id: 3, season: 0, episode: 1 });
  });
});

describe("episodeOverrides schema", () => {
  it("rejects two overrides for one file", () => {
    expect(
      episodeOverridesSchema.safeParse([
        { id: 1, season: 1, episode: 1 },
        { id: 1, season: 1, episode: 2 },
      ]).success,
    ).toBe(false);
  });

  it("rejects two files on one season/episode", () => {
    const result = episodeOverridesSchema.safeParse([
      { id: 1, season: 1, episode: 1 },
      { id: 2, season: 1, episode: 1 },
    ]);
    expect(result.success).toBe(false);
    if (!result.success)
      expect(result.error.issues[0]?.message).toContain("season 1 episode 1");
  });

  it("accepts specials (season 0) and is patchable", () => {
    expect(
      patchEntrySchema.parse({
        episodeOverrides: [{ id: 100_001, season: 0, episode: 1 }],
      }).episodeOverrides,
    ).toEqual([{ id: 100_001, season: 0, episode: 1 }]);
    expect(
      episodeOverridesSchema.safeParse([{ id: 1, season: 1, episode: 0 }])
        .success,
    ).toBe(false);
  });
});

describe("library.patch with episodeOverrides", () => {
  it("drops the inspection cache but keeps probes and source checks", async () => {
    const library = await temporaryLibrary();
    const entry = await library.create({
      type: "series",
      name: "Show",
      magnetUri: "magnet:?xt=urn:btih:show",
    });
    await library.setInspectionCache(entry.id, {
      hash: "hash-show",
      selectedFiles: files,
      inspectedAt: new Date().toISOString(),
    });
    const before = (await library.get(entry.id))!;
    expect(before.inspectionCache).toBeDefined();

    const patched = (await library.patch(entry.id, {
      episodeOverrides: [{ id: 1, season: 1, episode: 4 }],
    }))!;
    expect(patched.inspectionCache).toBeUndefined();
    expect(patched.episodeOverrides).toEqual([
      { id: 1, season: 1, episode: 4 },
    ]);
    expect(patched.fileOverrides).toBeUndefined();

    const cleared = (await library.patch(entry.id, { episodeOverrides: [] }))!;
    expect(cleared.episodeOverrides).toBeUndefined();
  });
});

describe("inspection with episodeOverrides", () => {
  const packStatus = {
    title: "Pack",
    hash: "hash-pack",
    stat: 1,
    stat_string: "Torrent working",
    file_stats: [
      // Off-by-one release: the file named E01 is really the pilot's recap.
      { id: 1, path: "Show S01E01.mkv", length: 100 },
      { id: 2, path: "Show S01E02.mkv", length: 100 },
      { id: 3, path: "Show S01E03.mkv", length: 100 },
    ],
  };
  const extraStatus = {
    title: "Extra",
    hash: "hash-extra",
    stat: 1,
    stat_string: "Torrent working",
    file_stats: [{ id: 1, path: "Show S01E02 Proper.mkv", length: 100 }],
  };

  function torrServer() {
    const byLink = (link: string) =>
      link.includes("extra") ? extraStatus : packStatus;
    return {
      addMagnet: vi
        .fn()
        .mockImplementation((link: string) => Promise.resolve(byLink(link))),
      waitForFiles: vi
        .fn()
        .mockImplementation((hash: string) =>
          Promise.resolve(hash === "hash-extra" ? extraStatus : packStatus),
        ),
      get: vi.fn().mockResolvedValue(packStatus),
    } as unknown as TorrServerClient;
  }

  it("applies repairs after filename parsing and source merging", async () => {
    const library = await temporaryLibrary();
    const entry = await library.create({
      type: "series",
      name: "Show",
      magnetUri: "magnet:?xt=urn:btih:pack",
      extraSources: [{ magnetUri: "magnet:?xt=urn:btih:extra" }],
    });
    const repaired = (await library.patch(entry.id, {
      episodeOverrides: [
        { id: 1, season: 0, episode: 1 },
        { id: 2, season: 1, episode: 1 },
        { id: 3, season: 1, episode: 2 },
      ],
    }))!;

    const inspection = await inspectEntry(repaired, torrServer(), library);

    // The extra source's automatic S01E02 would normally win over file 3;
    // the manual repair keeps file 3 and drops the automatic claimant.
    expect(
      inspection.selectedFiles.map((file) => [
        file.id,
        file.season,
        file.episode,
      ]),
    ).toEqual([
      [1, 0, 1],
      [2, 1, 1],
      [3, 1, 2],
    ]);
    const stored = (await library.get(entry.id))!;
    expect(stored.inspectionCache?.selectedFiles).toHaveLength(3);
    expect(stored.episodeOverrides).toHaveLength(3);

    // A later full re-inspection reproduces the same repaired order.
    const again = await inspectEntry(stored, torrServer(), library);
    expect(again.selectedFiles.map((file) => file.id)).toEqual([1, 2, 3]);
  });

  it("serves the repaired order from cache for streams", async () => {
    const library = await temporaryLibrary();
    const entry = await library.create({
      type: "series",
      name: "Show",
      magnetUri: "magnet:?xt=urn:btih:pack",
    });
    const repaired = (await library.patch(entry.id, {
      episodeOverrides: [{ id: 1, season: 1, episode: 4 }],
    }))!;
    await inspectEntry(repaired, torrServer(), library);
    const cached = (await library.get(entry.id))!;

    const resolved = await resolveStreamSource(cached, torrServer(), library);
    expect(resolved.selectedFiles.at(-1)).toMatchObject({
      id: 1,
      season: 1,
      episode: 4,
    });
  });

  it("keeps a repaired file playable when a later source claims its slot", async () => {
    const library = await temporaryLibrary();
    const entry = await library.create({
      type: "series",
      name: "Show",
      magnetUri: "magnet:?xt=urn:btih:pack",
      extraSources: [
        {
          magnetUri: "magnet:?xt=urn:btih:extra",
          fileOverrides: [{ id: 1, included: true, season: 1, episode: 2 }],
        },
      ],
    });
    const repaired = (await library.patch(entry.id, {
      episodeOverrides: [{ id: 2, season: 1, episode: 2 }],
    }))!;
    await inspectEntry(repaired, torrServer(), library);
    const cached = (await library.get(entry.id))!;

    const targeted = await inspectEntry(cached, torrServer(), library, {
      fileId: 2,
    });
    expect(targeted.selectedFiles).toContainEqual(
      expect.objectContaining({ id: 2, season: 1, episode: 2 }),
    );
    expect(targeted.selectedFiles.map((file) => file.id)).toEqual([1, 2, 3]);
  });
});
