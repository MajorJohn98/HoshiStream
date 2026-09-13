# Disk-copy policies

Date: 2026-09-13 · Phase 8 of the
[expansion plan](../plans/2026-09-12-playback-pointer-library-expansion-plan.md)
· design in
[disk-copy policies and diagnostics](../plans/2026-09-13-disk-copy-policies-and-diagnostics-plan.md).

A series kept on disk can now carry a **rolling window** so the archiver works
ahead of the viewer and cleans up behind them.

## What changed

- **Per-series policy** (`diskCopy.policy`): `keepAhead` (0–50) archives the
  next N unwatched episodes after the one just played; `evictWatched` removes
  disk copies of watched episodes once the window is on disk. Both default off.
- **Anchor**: the file that just started or finished playing (watch event),
  else the most recent watch state, else the first episode. The window is the
  next `keepAhead` non-watched files in season/episode order.
- **Eviction rules**: never the anchor, never a file currently streaming, never
  the copy being written; only when every window file is `complete`. Evicted
  files are marked `included: false`, `state: "missing"` and carry
  `evictedAt`; the file (and any `.partial`) is deleted only when the volume is
  online — otherwise the copy stays until the next application.
- **Triggers**: every watch-state change (`started`, `watched`, `cleared`),
  archiver start-up, and the end of each entry's copy pass (so evictions that
  wait for the window run without another play).
- **Enabling** `keepAhead` from 0 switches the disk copy to `scope: "selected"`
  and resets inclusion to files that already have bytes on disk; the planner
  then adds the window.
- **API**: `PUT /api/library/{id}/disk-copy/policy` with
  `{keepAhead?, evictWatched?}` → `200` entry; `409` unless the entry is a
  series with disk copy enabled. `diskCopy.policy` is carried through
  `PUT …/disk-copy` when `scope` stays `"selected"`.
- **UI**: a *Rolling window* block on the entry sheet's Storage tab (series
  with more than one file) with *Keep N ahead* and *Remove watched copies*;
  the Storage page's "Kept on disk" row shows the active policy; evicted files
  read "Evicted <ago>" in the Files list.
- **Logs**: `disk_policy_updated`, `disk_policy_applied` (added/evicted counts),
  `disk_policy_evicted` (per file, source key only).

## Code

- `addon/src/disk-policy.ts` — pure planner (`planDiskPolicy`,
  `resetInclusionForPolicy`, `describePolicy`).
- `addon/src/archiver.ts` — `applyPolicy()`, per-file persistence that merges
  state only, re-reads the manifest per file, requeues when enqueued mid-pass.
- `addon/src/watch-state.ts` — `WatchStates.subscribe()`.
- `addon/src/routes/disk-api.ts` — the policy route.
- `addon/assets/manage/views/{detail,storage,disk-policy}.js` — UI.
- Tests: `tests/disk-policy.test.ts`, `tests/archiver-policy.test.ts`,
  `tests/disk-policy-api.test.ts`.

## Exit criterion

`tests/archiver-policy.test.ts` — after S01E03 starts with `keepAhead: 2` and
`evictWatched`, E04–E05 archive and E01–E02 are evicted without touching E03.
