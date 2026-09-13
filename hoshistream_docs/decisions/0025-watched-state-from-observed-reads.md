# 0025 - Watched state derived from observed reads

Status: accepted (2026-09-13).

## Context

Phase 5 of the
[expansion plan](../plans/2026-09-12-playback-pointer-library-expansion-plan.md)
wants a Continue Watching row and per-episode watched marks. HoshiStream has
no signal from external Stremio clients about where the viewer is: the Stremio
add-on protocol carries no playback position, Nuvio sends none, and the only
client that knows its playhead is the add-on's own browser player. TorrServer
keeps a per-torrent `bytes_read_useful_data` counter and a viewed list
(`/viewed`), but nothing per file about how far a reader got.

What the add-on does see is where the bytes go: `/cache` (already polled every
2 s per active stream for runway telemetry) reports each reader's absolute
piece, and the add-on itself serves local and disk-copy files, so it sees every
`Range` request.

## Decision

- Watched state is **derived from observed reads** and stored per file in
  `library.json` as `watchStates[{ fileId, state, at }]`. The library is the
  source of truth; TorrServer's viewed list is mirrored (`/viewed set|rem`)
  best-effort so its UI agrees, and failures are logged, not surfaced.
- Three observation sources feed one in-memory `WatchProgress`: the `/cache`
  reader position mapped through `Torrent.file_stats`, the `Range` start on
  `/local/…` and `/media/…`, and the browser player's explicit signals.
- **Started** is the first observed read of a file — not `stream_generated`,
  which fires while browsing episodes. **Watched** is a read at ≥ 90 % of the
  file at least 60 s after the first read; the delay filters the tail reads
  players make at open time (MKV cues, MP4 `moov`). Watched is sticky.
- Continue Watching is a Stremio catalog per type that lists entries with
  something left to resume and points `behaviorHints.defaultVideoId` at the
  resume file. The protocol has no `watched` flag on videos, so no per-episode
  check marks are attempted in Stremio; the management UI shows and toggles
  them instead.
- Watch state is dropped when the entry's source changes, like other
  source-derived fields.

## Consequences

- No new endpoints or polling: `file_stats` rides along in the existing
  `/cache` reply, and `/viewed` is called only on transitions.
- The reader piece is where TorrServer reads, not exactly where the player is;
  read-ahead is bounded by the cache window, so at 90 % the error is small.
  Players that download a file wholesale would still be marked watched.
- A file watched with no reader attached (e.g. an external player that fully
  buffered it in the first minute) may be missed; the UI toggle covers that.
- Whether Nuvio honours `defaultVideoId` on series is unverified. If it does
  not, the row still opens the right show.

## Alternatives considered

- **Player-reported positions only.** Covers the browser player and nothing
  else; the main viewers are Nuvio devices.
- **`bytes_read_useful_data`.** Per torrent, so a series torrent could never
  tell episodes apart.
- **Mark started on `stream_generated`.** Simple, but pollutes Continue
  Watching with every episode whose stream list was opened.
- **TorrServer's viewed list as the store.** Lost on TorrServer resets, has
  no "started" notion, and would need a `list` call per catalog request.
