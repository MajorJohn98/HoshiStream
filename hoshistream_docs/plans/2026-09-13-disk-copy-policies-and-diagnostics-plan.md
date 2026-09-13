# Disk-copy policies and diagnostics bundle

Date: 2026-09-13
Status: implemented — see
[disk-copy policies](../changelog/disk-copy-policies.md) and
[diagnostics bundle](../changelog/diagnostics-bundle.md).
Detail for Phases 8 and 9 of the
[expansion plan](2026-09-12-playback-pointer-library-expansion-plan.md).

## Phase 8 — Disk-copy policies

Goal: the archiver works ahead of the viewer and cleans up behind them,
per series, opt-in, on top of the existing manifest and watched state.

### Data

- `diskCopy.policy` (optional): `{ keepAhead?: 0–50, evictWatched?: boolean }`.
  Absent or `keepAhead: 0` with `evictWatched` unset means no policy — the
  shipped default.
- `diskCopy.files[].evictedAt` (optional ISO time): the policy removed this
  copy. The file stays in the manifest as `included: false, state: "missing"`
  so it is visible and reversible: re-including it through the existing
  selection UI clears the mark and re-downloads.

### Rules (`src/disk-policy.ts`, pure)

`planDiskPolicy(entry, anchorFileId, protectedKeys)` returns the new file list
and the files to evict:

1. Episode order is the inspected selection sorted by season, episode, id
   (the same order `resumeFile` uses).
2. **Anchor** = the file just played (the watch event's file). Without one,
   the most recent watch state; with none at all, the window starts at the
   first episode.
3. **Ahead window** = the next `keepAhead` files after the anchor whose watch
   state is not `watched`. They become `included: true` (clearing
   `evictedAt`). Nothing else gains inclusion.
4. **Eviction** (only when `evictWatched`): files that are `watched`, on disk
   (`complete` or `partial`), not the anchor, not in the ahead window, and not
   in `protectedKeys` (files a client is streaming right now). Eviction waits
   until every ahead-window file is `complete` — "once keepAhead is
   satisfied" — so the viewer never has fewer playable copies than before.
5. Enabling `keepAhead` switches `scope` to `selected` and resets inclusion to
   files that already have bytes on disk plus the ahead window. The policy
   owns inclusion from then on; the user can still tick extra episodes.

### Archiver

- `Archiver.applyPolicy(entryId, anchorFileId?)`: plan → delete evicted files
  (destination and `.partial`, containment-checked through
  `destinationPath`) when the volume is online → persist → enqueue when new
  work appeared. Logged as `disk_policy_applied` with counts and
  `disk_policy_evicted` per file (source key only).
- Triggers: every `WatchStates` change (started, watched, cleared) through
  `WatchStates.subscribe`; start-up for every entry with a policy; and the end
  of an entry's own copy pass, which is when the ahead window becomes
  complete and eviction may run.
- The copy loop re-reads the manifest before each file so inclusion changes
  made mid-pass are picked up; `persistFiles` merges only `state` by source
  key so a concurrent policy write is never clobbered. An `enqueue` during
  the entry's own pass requeues it once the pass ends.

### API and UI

- `PUT /api/library/{id}/disk-copy/policy` `{keepAhead?, evictWatched?}` →
  updated entry; `409` unless a torrent-backed series with disk copy enabled.
  Applies the policy immediately.
- Entry sheet → Keep on disk: a "Rolling window" block (number of episodes
  ahead, "Remove watched copies" checkbox). Evicted files show as "Evicted".
- Storage page → Kept on disk: the row meta names the policy.

## Phase 9 — Diagnostics bundle

Goal: one JSON a viewer can paste into a support message with no secrets.

- `GET /api/diagnostics` (token-guarded, `no-store`) → `src/diagnostics.ts`
  assembles: app/release identity, OS and Node versions, uptime, effective
  TorrServer settings (`POST /settings {action:"get"}`, schema-validated,
  `TorrentsSavePath` redacted like every home-relative path), recent speed
  tests, playback telemetry summary (last sample per active stream), pointer
  drift observation (outcome and timestamps only), archive queue summary, the
  library shape (counts by type/source kind, no titles), and a redacted tail
  of the add-on's own recent log lines (an in-memory ring buffer fed by a
  `console` tap installed at start-up; the supervisor's `server.log` stays
  where it is).
- `redactDiagnostics(text, secrets)` removes the access token, the pointer
  push secret, `Authorization` header values, `magnet:` URIs, `xt=urn:btih`
  hashes' surrounding magnet text, `token=` query values, the `/api/…`
  bearer forms, and paths under the home directory (`~`). Applied to the
  whole serialized bundle as the last step so nothing slips through a new
  field.
- UI: System → Status gains **Copy diagnostics** (clipboard) next to the
  existing status rows.
- Docs: troubleshooting "Ask for help".
