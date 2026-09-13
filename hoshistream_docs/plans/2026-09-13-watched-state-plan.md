# Watched state and Continue Watching (Phase 5)

**Date:** 2026-09-13
**Status:** implemented — see [changelog](../changelog/watched-state.md) and [ADR 0025](../decisions/0025-watched-state-from-observed-reads.md)
**Relates to:** [playback pointer / library expansion plan](2026-09-12-playback-pointer-library-expansion-plan.md) Phase 5

## Problem

The add-on knows when a stream was *requested* (`lastStreamedAt`) and, for the
browser and host players, where the viewer stopped (`playback`). It does not
know which episodes have been *watched*, so Nuvio opens every series on
episode 1, there is no Continue Watching row, and TorrServer's own viewed
marks are never kept in step.

## Open questions settled

- **Protocol fields.** `stremio-addon-sdk` 1.6.10 (protocol docs in
  `node_modules/stremio-addon-sdk/docs/api/responses/meta.md`) has no
  `watched` field on Video objects; Stremio keeps watched state client-side.
  The protocol does offer `behaviorHints.defaultVideoId` ("open the Detail
  page directly to that video's streams"), which is what a resume needs.
  Nothing is invented.
- **`bytes_read_useful_data`.** In the pinned MatriX.141 source
  (`server/torr/state/state.go`) this is a per-*torrent* counter accumulated
  since the torrent was added. For a season pack it says nothing about one
  episode. Phase 1's `/cache` reply already carries each reader's current
  piece and, via `Torrent = t.Status()`, the torrent's `file_stats`; the
  reader's byte offset relative to the file's offset is the playhead
  position at piece granularity. That is the signal used.
- **`/viewed`.** Verified in `server/web/api/viewed.go` and
  `server/settings/viewed.go`: `POST /viewed {action:"set"|"rem"|"list",
hash, file_index}`; `set`/`rem` answer 200 with no body; `list` answers
  `[{hash, file_index}]` (Go nil slice → `null` when empty); `file_index`
  is TorrServer's one-based raw index. Persisted in `config.db` with the
  shipped `StoreViewedInJson: false`.

## Design

### Persistence

`libraryEntrySchema` gains `watchStates?: { fileId, state: "started" |
"watched", at }[]`, keyed by the entry-wide (composite) file id used by
`playback.fileId` and `mediaFacts`. Additive and optional, so pre-Phase-5
library files load unchanged (asserted by a test). Cleared when the entry's
source path fields change (file ids belong to the old source). Server-owned:
create/patch reject it like `mediaFacts`.

`Library.setWatchState(id, fileId, state)` never downgrades `watched` to
`started` (a rewatch keeps the mark; only an explicit clear removes it) and
reports whether anything changed so callers skip the `/viewed` call on a
no-op. `Library.clearWatchState(id, fileId)` removes the record.

### Signals

`WatchProgress` (`addon/src/watch-state.ts`) receives
`observe(entryId, fileId, fraction, now)` from every place the add-on can see
bytes being read, and turns observations into two events:

- **started** — first observation of a file (in-memory dedupe; the library
  write is a no-op when a record exists).
- **watched** — an observation at ≥ 90 % of the file at least 60 s after the
  first one. The delay rejects the tail read players make at open time for
  MKV cues / MP4 `moov` atoms, which would otherwise look like the end.

Sources of observations:

- `PlaybackTelemetry` (torrent entries played from a direct TorrServer URL):
  each sample, the reader inside the target's file gives
  `(readerPiece × pieceLength − fileOffset) / fileLength`. Needs
  `file_stats` from the embedded `Torrent` status, added to the `/cache`
  schema — no new endpoint.
- `/local/...` and `/media/...` routes (local and disk-copy entries the
  add-on serves itself): the `Range` start over the file length.
- Browser player (`views/player.js`): `PUT /api/library/:id/watch` with
  `started` on first playback and `watched` at `ended` or ≥ 90 %.

"Started" is recorded on the first observed read rather than on
`stream_generated`, as the plan first said: Stremio requests streams when an
episode page is opened, and browsing a season would otherwise fill Continue
Watching with episodes never played.

### TorrServer sync

`WatchStates` (same module) wraps the library and TorrServer: persisting
`watched` calls `POST /viewed set`, clearing calls `rem`, both with the
file's raw index and its source hash, best-effort and logged at `warn` on
failure. `list` is not consumed; there is no second source of truth.

### Stremio

- Manifest: a `continue-watching` catalog per type (only the `skip` extra).
  `getCatalog` filters to entries with a started-or-watched file and at least
  one unwatched file, newest activity first, and sets
  `behaviorHints.defaultVideoId` to the resume episode.
- Resume episode: the most recent `started` file; else the first unwatched
  file after the last watched one in season/episode order; else the first
  unwatched file.
- Series `meta` carries the same `defaultVideoId` when the series has any
  watch history, so Nuvio's detail page opens on the next episode.

### Management UI

- Files tab: a watched dot per file and a toggle ("Mark watched" /
  "Mark unwatched").
- API: `PUT /api/library/:id/watch {fileId, state}` and
  `DELETE /api/library/:id/watch/:fileId`.

## Out of scope

- Position-level resume for external clients (Stremio never reports it).
- Reading TorrServer's viewed list back into the library.
- Consuming watched state in the archiver (Phase 8) or an Unwatched catalog
  (Phase 15).
