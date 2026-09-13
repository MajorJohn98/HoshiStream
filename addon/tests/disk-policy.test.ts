import { describe, expect, it } from "vitest";
import {
  describePolicy,
  planDiskPolicy,
  policyActive,
  policyAnchor,
  resetInclusionForPolicy,
} from "../src/disk-policy.ts";
import type { DiskCopyFile, LibraryEntry, WatchState } from "../src/types.ts";

const HASH = "a".repeat(40);
const NOW = new Date("2026-09-13T10:00:00.000Z");

function episodes(count: number) {
  return Array.from({ length: count }, (_, index) => ({
    id: index + 1,
    path: `Show/S01E0${index + 1}.mkv`,
    length: 1000,
    season: 1,
    episode: index + 1,
  }));
}

function manifest(
  count: number,
  states: Partial<Record<number, DiskCopyFile["state"]>> = {},
  included: (id: number) => boolean = () => true,
): DiskCopyFile[] {
  return episodes(count).map((file) => ({
    sourceKey: `${HASH}:${file.id}`,
    relativePath: file.path,
    length: file.length,
    included: included(file.id),
    state: states[file.id] ?? "missing",
  }));
}

function entry(
  files: DiskCopyFile[],
  policy: { keepAhead?: number; evictWatched?: boolean } | undefined,
  watched: number[] = [],
  started: number[] = [],
): LibraryEntry {
  const watchStates: WatchState[] = [
    ...watched.map((fileId, index) => ({
      fileId,
      state: "watched" as const,
      at: new Date(NOW.getTime() - (100 - index) * 60_000).toISOString(),
    })),
    ...started.map((fileId) => ({
      fileId,
      state: "started" as const,
      at: NOW.toISOString(),
    })),
  ];
  return {
    id: "hoshi:show",
    type: "series",
    name: "Show",
    magnetUri: `magnet:?xt=urn:btih:${HASH}`,
    inspectionCache: {
      hash: HASH,
      selectedFiles: episodes(files.length),
      inspectedAt: NOW.toISOString(),
    },
    diskCopy: {
      desired: "keep",
      volumeId: "vol",
      relativeDir: "Show-1",
      sourceRevision: "rev",
      scope: "selected",
      files,
      ...(policy ? { policy } : {}),
      updatedAt: NOW.toISOString(),
    },
    ...(watchStates.length ? { watchStates } : {}),
    createdAt: NOW.toISOString(),
    updatedAt: NOW.toISOString(),
  };
}

const key = (id: number) => `${HASH}:${id}`;
const includedIds = (files: DiskCopyFile[]) =>
  files
    .filter((file) => file.included)
    .map((file) => Number(file.sourceKey.split(":")[1]));

describe("policyActive / describePolicy", () => {
  it("treats an absent or zero policy as off", () => {
    expect(policyActive(undefined)).toBe(false);
    expect(policyActive({})).toBe(false);
    expect(policyActive({ keepAhead: 0 })).toBe(false);
    expect(policyActive({ keepAhead: 2 })).toBe(true);
    expect(policyActive({ evictWatched: true })).toBe(true);
    expect(describePolicy({ keepAhead: 2, evictWatched: true })).toBe(
      "next 2 ahead · removes watched",
    );
    expect(describePolicy({ keepAhead: 0 })).toBe("");
  });
});

describe("policyAnchor", () => {
  it("prefers the explicit file, else the most recent watch state", () => {
    const item = entry(manifest(5), { keepAhead: 1 }, [1, 2], [3]);
    expect(policyAnchor(item, 4)).toBe(4);
    expect(policyAnchor(item)).toBe(3);
    expect(policyAnchor(entry(manifest(5), { keepAhead: 1 }))).toBeUndefined();
  });
});

describe("planDiskPolicy", () => {
  it("leaves the manifest alone without an active policy", () => {
    const files = manifest(3);
    const plan = planDiskPolicy(entry(files, undefined, [1]), {}, NOW);
    expect(plan.changed).toBe(false);
    expect(plan.files).toBe(files);
  });

  it("includes the next N unwatched episodes after the anchor", () => {
    const files = manifest(6, {}, () => false);
    const plan = planDiskPolicy(
      entry(files, { keepAhead: 2 }, [1, 2], [3]),
      { anchorFileId: 3 },
      NOW,
    );
    expect(plan.changed).toBe(true);
    expect(includedIds(plan.files)).toEqual([4, 5]);
    expect(plan.added).toEqual([key(4), key(5)]);
    expect(plan.evict).toEqual([]);
  });

  it("skips watched episodes when filling the window", () => {
    const files = manifest(6, {}, () => false);
    const plan = planDiskPolicy(
      entry(files, { keepAhead: 2 }, [1, 4], [2]),
      { anchorFileId: 2 },
      NOW,
    );
    expect(includedIds(plan.files)).toEqual([3, 5]);
  });

  it("starts at the first episode when nothing has been watched", () => {
    const files = manifest(4, {}, () => false);
    const plan = planDiskPolicy(entry(files, { keepAhead: 2 }), {}, NOW);
    expect(includedIds(plan.files)).toEqual([1, 2]);
  });

  it("evicts watched copies only once the window is on disk", () => {
    const states = { 1: "complete", 2: "complete", 3: "complete" } as const;
    const policy = { keepAhead: 2, evictWatched: true };
    // E04/E05 still missing: nothing is removed yet.
    const pending = planDiskPolicy(
      entry(manifest(6, states), policy, [1, 2, 3]),
      { anchorFileId: 3 },
      NOW,
    );
    expect(pending.evict).toEqual([]);
    expect(pending.files.find((f) => f.sourceKey === key(1))?.included).toBe(
      true,
    );
    // E04/E05 complete: E01/E02 go, E03 (anchor) stays.
    const satisfied = planDiskPolicy(
      entry(
        manifest(6, { ...states, 4: "complete", 5: "complete" }),
        policy,
        [1, 2, 3],
      ),
      { anchorFileId: 3 },
      NOW,
    );
    expect(satisfied.evict.map((f) => f.sourceKey)).toEqual([key(1), key(2)]);
    const evicted = satisfied.files.find((f) => f.sourceKey === key(1))!;
    expect(evicted).toMatchObject({
      included: false,
      state: "missing",
      evictedAt: NOW.toISOString(),
    });
    expect(satisfied.files.find((f) => f.sourceKey === key(3))).toMatchObject({
      included: true,
      state: "complete",
    });
  });

  it("never evicts a protected (streaming) file or a partial anchor", () => {
    const states = {
      1: "complete",
      2: "partial",
      3: "complete",
      4: "complete",
    } as const;
    const plan = planDiskPolicy(
      entry(
        manifest(4, states),
        { keepAhead: 1, evictWatched: true },
        [1, 2, 3],
      ),
      { anchorFileId: 3, protectedKeys: [key(1)] },
      NOW,
    );
    // E02 is partial and watched → evicted (both files removed); E01 is
    // protected; E03 is the anchor; E04 is the window.
    expect(plan.evict.map((f) => f.sourceKey)).toEqual([key(2)]);
  });

  it("evicts without a window when only evictWatched is set", () => {
    const plan = planDiskPolicy(
      entry(
        manifest(3, { 1: "complete", 2: "complete" }),
        {
          evictWatched: true,
        },
        [1, 2],
      ),
      { anchorFileId: 2 },
      NOW,
    );
    expect(plan.evict.map((f) => f.sourceKey)).toEqual([key(1)]);
    expect(plan.added).toEqual([]);
  });

  it("re-including an evicted file in the window clears the mark", () => {
    const files = manifest(3, {}, () => false).map((file) =>
      file.sourceKey === key(2)
        ? { ...file, evictedAt: NOW.toISOString() }
        : file,
    );
    const plan = planDiskPolicy(
      entry(files, { keepAhead: 1 }, [], [1]),
      { anchorFileId: 1 },
      NOW,
    );
    const second = plan.files.find((f) => f.sourceKey === key(2))!;
    expect(second.included).toBe(true);
    expect(second.evictedAt).toBeUndefined();
  });

  it("does nothing when the window is already satisfied", () => {
    const files = manifest(
      4,
      { 3: "complete", 4: "complete" },
      (id) => id >= 3,
    );
    const plan = planDiskPolicy(
      entry(files, { keepAhead: 2 }, [1, 2], []),
      { anchorFileId: 2 },
      NOW,
    );
    expect(plan.changed).toBe(false);
  });
});

describe("resetInclusionForPolicy", () => {
  it("keeps only files with bytes on disk included", () => {
    const files = manifest(4, { 1: "complete", 2: "partial", 3: "invalid" });
    expect(includedIds(resetInclusionForPolicy(files))).toEqual([1, 2]);
  });
});
