# Watched state and Continue Watching

Date: 2026-09-13 · Phase 5 of the
[playback, pointer, library and operations expansion plan](../plans/2026-09-12-playback-pointer-library-expansion-plan.md)
· plan: [2026-09-13-watched-state-plan.md](../plans/2026-09-13-watched-state-plan.md)
· decision: [ADR 0025](../decisions/0025-watched-state-from-observed-reads.md).

## What changed

- **Per-file watch state in `library.json`.** Each entry may carry
  `watchStates: [{ fileId, state: "started" | "watched", at }]`. File ids are
  the entry-wide composite ids already used for episodes and disk copies.
  `watched` is sticky (a rewatch never demotes it); clearing a file removes
  its record, and the field disappears when empty. Changing an entry's source
  (magnet, torrent file, local path, extra sources) forgets its watch state,
  the same way it forgets `sourceHash` and `searchImport`. The field is
  server-owned: `POST`/`PATCH /api/library` reject it.
- **Derived from observed reads, not player reports.** External Stremio
  clients never send a playhead, so the add-on watches where the bytes go:
  - TorrServer-streamed files: `playback-telemetry.ts` already polls `/cache`
    every 2 s per active stream; the reply's `Torrent.file_stats` gives file
    offsets, so the absolute `Reader` piece becomes a fraction of the streamed
    file (`readerFraction`).
  - Local and disk-copy files served by the add-on itself (`/local/…`,
    `/media/…`): the `Range` start of each `GET` (`rangeFraction`).
  - The in-browser player reports `started` and `watched` directly.
    `WatchProgress` turns observations into events: the first observed read of a
    file marks it **started**; a read at ≥ 90 % of the file at least 60 s after
    that first read marks it **watched**. The delay rejects the tail reads
    players issue at open time (MKV cues, MP4 `moov`). Observations idle for
    30 min are forgotten so a replay weeks later starts the clock again.
- **TorrServer `/viewed` mirror.** Marking a torrent file watched calls
  `POST /viewed {action:"set"}` with the owning torrent's hash and raw file
  index; clearing calls `rem`. Failures log `viewed_sync_failed` and are
  otherwise ignored — the library is authoritative.
- **Continue Watching catalogs.** The manifest adds a `continue-watching`
  catalog for both `movie` and `series` (extra: `skip` only). Rows list
  entries that have watch state and something left to resume, newest activity
  first, and set `behaviorHints.defaultVideoId` to the resume file — for
  series `entry:season:episode`, matching the ids in `meta.videos`. The resume
  file is the most recently started file, else the first unwatched episode
  after the last watched one, else the earliest unwatched gap. Fully watched
  entries drop out of the row. Series `meta` also sets `defaultVideoId` when
  there is history, so opening the show from any catalog lands on the right
  episode.
- **Management UI.** The Files table on the entry page gains a **Watched**
  column: a dot plus label (Unwatched / In progress / Watched) that toggles the
  mark through `PUT /api/library/:id/watch` and
  `DELETE /api/library/:id/watch/:fileId`. The browser player sends `started`
  when playback first runs and `watched` when it reaches the finished tail.
- **API.** `PUT /api/library/:id/watch` `{ fileId, state }` returns the
  entry's `watchStates`; `DELETE /api/library/:id/watch/:fileId` returns 204;
  both 404 for unknown entries. `GET /api/library/:id` includes `watchStates`.

## Deviations from the master plan

- The plan proposed marking a file **started** on `stream_generated`. Stremio
  requests streams while the user browses episodes, which would fill Continue
  Watching with titles never played. Started is instead recorded on the first
  observed read.
- The plan mentioned a `watched` flag on `meta.videos`. The `stremio-addon-sdk`
  1.6.10 protocol has no such field; `behaviorHints.defaultVideoId` is used
  instead. Whether Nuvio honours `defaultVideoId` on series (as it does for
  movies today) has not been verified on a device — if it does not, the row
  still opens the right show and the episode list still works.

## Open questions

- Reader position comes from the `Reader` piece, which is where TorrServer is
  currently reading, not necessarily the player's playhead. Read-ahead is
  bounded by the cache window, so at ≥ 90 % it is a safe proxy.
- Files whose watch state should carry across a source change (same series,
  new torrent) do not; the plan's source-change rule is the simpler,
  conservative choice.

## Files

- `addon/src/watch-state.ts` (new), `addon/src/types.ts`,
  `addon/src/library.ts`, `addon/src/torrserver-client.ts`,
  `addon/src/playback-telemetry.ts`, `addon/src/catalog.ts`,
  `addon/src/manifest.ts`, `addon/src/metadata.ts`, `addon/src/addon.ts`,
  `addon/src/routes.ts`, `addon/src/routes/context.ts`,
  `addon/src/routes/library-api.ts`, `addon/src/routes/media.ts`,
  `addon/src/index.ts`.
- `addon/assets/manage/views/detail.js`, `addon/assets/manage/views/player.js`,
  `addon/assets/manage/styles.css`.
- Tests: `tests/watch-state.test.ts` (new), `tests/catalog.test.ts`,
  `tests/inspection.test.ts`, `tests/manifest.test.ts`,
  `tests/playback-telemetry.test.ts`, `tests/routes.dispatch.test.ts`,
  `tests/tags.test.ts`, `tests/torrserver-client.test.ts`.
