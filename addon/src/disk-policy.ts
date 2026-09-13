// Disk-copy policies (Phase 8, plans/2026-09-13-disk-copy-policies-and-
// diagnostics-plan.md): a per-series rolling window on top of the manifest.
// Pure planning here; the archiver deletes files and persists the result.
import { sourceKey } from "./disk-copy.ts";
import type { SelectedFile } from "./media-file-selection.ts";
import type { DiskCopyFile, DiskCopyPolicy, LibraryEntry } from "./types.ts";

export interface DiskPolicyPlan {
  files: DiskCopyFile[];
  // Files whose copies should be removed from the drive, in manifest order.
  evict: DiskCopyFile[];
  // Source keys newly included by this plan (work for the archiver).
  added: string[];
  changed: boolean;
}

export function policyActive(policy: DiskCopyPolicy | undefined): boolean {
  return Boolean(
    policy && ((policy.keepAhead ?? 0) > 0 || policy.evictWatched),
  );
}

export function describePolicy(policy: DiskCopyPolicy | undefined): string {
  if (!policyActive(policy)) return "";
  const parts: string[] = [];
  const ahead = policy?.keepAhead ?? 0;
  if (ahead > 0) parts.push(`next ${ahead} ahead`);
  if (policy?.evictWatched) parts.push("removes watched");
  return parts.join(" · ");
}

function episodeOrder(a: SelectedFile, b: SelectedFile): number {
  return (
    (a.season ?? 0) - (b.season ?? 0) ||
    (a.episode ?? 0) - (b.episode ?? 0) ||
    a.id - b.id
  );
}

// The file the window hangs off: the one just played when the caller knows
// it, else the most recent watch state. Undefined starts the window at the
// first episode.
export function policyAnchor(
  entry: Pick<LibraryEntry, "watchStates">,
  anchorFileId?: number,
): number | undefined {
  if (anchorFileId !== undefined) return anchorFileId;
  let latest: { fileId: number; at: number } | undefined;
  for (const state of entry.watchStates ?? []) {
    const at = Date.parse(state.at) || 0;
    if (!latest || at > latest.at) latest = { fileId: state.fileId, at };
  }
  return latest?.fileId;
}

/**
 * Apply the entry's policy to its manifest. `protectedKeys` are source keys
 * that must not be evicted (a client is streaming them right now). Returns
 * the current files unchanged when the entry has no active policy or no
 * inspected selection.
 */
export function planDiskPolicy(
  entry: LibraryEntry,
  options: { anchorFileId?: number; protectedKeys?: Iterable<string> } = {},
  now = new Date(),
): DiskPolicyPlan {
  const diskCopy = entry.diskCopy;
  const cache = entry.inspectionCache;
  const unchanged: DiskPolicyPlan = {
    files: diskCopy?.files ?? [],
    evict: [],
    added: [],
    changed: false,
  };
  if (!diskCopy || !cache || !policyActive(diskCopy.policy)) return unchanged;
  const policy = diskCopy.policy!;
  const keepAhead = policy.keepAhead ?? 0;
  const protectedKeys = new Set(options.protectedKeys ?? []);
  const watched = new Set(
    (entry.watchStates ?? [])
      .filter((state) => state.state === "watched")
      .map((state) => state.fileId),
  );
  const ordered = [...cache.selectedFiles].sort(episodeOrder);
  const keyOf = (file: SelectedFile) => sourceKey(cache.hash, file);
  const anchorId = policyAnchor(entry, options.anchorFileId);
  const anchorIndex =
    anchorId === undefined
      ? -1
      : ordered.findIndex((file) => file.id === anchorId);
  const anchorKey =
    anchorIndex === -1 ? undefined : keyOf(ordered[anchorIndex]);
  const ahead = new Set(
    ordered
      .slice(anchorIndex + 1)
      .filter((file) => !watched.has(file.id))
      .slice(0, keepAhead)
      .map(keyOf),
  );
  const watchedKeys = new Set(
    ordered.filter((file) => watched.has(file.id)).map(keyOf),
  );
  const byKey = new Map(diskCopy.files.map((file) => [file.sourceKey, file]));
  const aheadSatisfied = [...ahead].every(
    (key) => byKey.get(key)?.state === "complete",
  );
  const evict: DiskCopyFile[] = [];
  const added: string[] = [];
  let changed = false;
  const files = diskCopy.files.map((file) => {
    if (ahead.has(file.sourceKey)) {
      if (file.included && !file.evictedAt) return file;
      changed = true;
      if (!file.included) added.push(file.sourceKey);
      const next = { ...file, included: true };
      delete next.evictedAt;
      return next;
    }
    const onDisk = file.state === "complete" || file.state === "partial";
    if (
      policy.evictWatched &&
      aheadSatisfied &&
      onDisk &&
      watchedKeys.has(file.sourceKey) &&
      file.sourceKey !== anchorKey &&
      !protectedKeys.has(file.sourceKey)
    ) {
      changed = true;
      evict.push(file);
      return {
        ...file,
        included: false,
        state: "missing" as const,
        evictedAt: now.toISOString(),
      };
    }
    return file;
  });
  return { files, evict, added, changed };
}

/**
 * Inclusion reset for the moment a rolling window is switched on: the
 * policy owns intent from here, so only files that already have bytes on
 * disk stay included. The planner then adds the ahead window.
 */
export function resetInclusionForPolicy(files: DiskCopyFile[]): DiskCopyFile[] {
  return files.map((file) => {
    const onDisk = file.state === "complete" || file.state === "partial";
    return file.included === onDisk ? file : { ...file, included: onDisk };
  });
}
