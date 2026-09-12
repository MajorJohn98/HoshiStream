# Playback telemetry and line fit

Implements Phases 1 and 2 of the
[playback, pointer and library expansion plan](../plans/2026-09-12-playback-pointer-library-expansion-plan.md):
first observe how far ahead of the player TorrServer has buffered, then tell
the viewer plainly which stream their line can carry.

## Phase 1 — Playback telemetry

- **`TorrServerClient.cacheState(hash)`** (`src/torrserver-client.ts`) posts
  `{ action: "get", hash }` to `/cache` and normalizes the Go-cased
  `CacheState` (no JSON tags upstream) into camelCase: `capacity`, `filled`,
  `pieceLength`, `pieceCount`, `completed` (piece index → done), `readers`
  (`startPiece`/`endPiece`/`readerPiece`, absolute piece indexes),
  `downloadSpeedBps`, `activePeers`, `connectedSeeders`. Returns `undefined`
  when TorrServer replies `{}` (no cache yet); a 404 surfaces as `not_found`.
  Verified against the pinned MatriX.141 source
  (`server/torr/storage/state/state.go`, `torrstor/reader.go`,
  `web/api/cache.go`).
- **`PlaybackTelemetry`** (`src/playback-telemetry.ts`) samples every 2 s for
  each library entry whose recent activity is `streaming`, keeps a 60-sample
  ring per hash, and computes:
  - `bytesAhead` — the **contiguous** completed pieces from each reader's
    current piece to the end of its read-ahead window × piece length, taking
    the minimum across readers. A gap in front of the reader counts as zero
    runway because that is where the player will stall; this is slightly
    stricter than the plan's "completed pieces ahead" wording.
  - `runwaySeconds` — `bytesAhead × 8 / (bitrateMbps × 1e6)` when the entry
    has a probed average bitrate; `undefined` otherwise.
  - Logs a structured `playback_sample` **warn** when a reader is attached and
    runway drops below 10 s, at most once per entry every 30 s. Hashes only;
    no tokens or magnet URIs.
- **`GET /api/playback/telemetry`** (no-store) returns `{ streams: [...] }`
  with each active target's latest sample and ring. Repo convention is
  `/api/<thing>`, so this replaced the plan's `/api/system/playback` name.
- **Management UI → Activity** polls the endpoint every 3 s and shows a runway
  line under each streaming session: `Runway N s` (green ≥ 10 s, yellow
  below), `No reader attached`, or `Runway unknown` (no bitrate yet).
- Wiring: `src/index.ts` starts/stops the sampler with the archiver;
  `getStreams` registers the served file as a telemetry target.
- **Streams TorrServer serves on its own (2026-09-12 fix).** Playback goes
  straight to TorrServer, so the `stream` request was the add-on's only
  signal: a film fell back to `Idle` (and lost its runway row) five minutes
  in, and a client that reused a cached stream URL or resumed after a restart
  was never seen at all. The sampler now also lists TorrServer's working
  torrents each tick; any torrent owned by a library entry that has an open
  cache reader becomes a target (file located from the reader's piece offset,
  bitrate from the cached media facts), and every sample that still sees a
  reader refreshes the entry's streaming activity. The hash → entry index is
  re-read from the library at most every 15 s; TorrServer is asked for cache
  state only for working torrents without a target. Streaming ages out five
  minutes after the player disconnects. TorrServer reports `download_speed`
  and similar live stats as `null` for a working torrent with no measurable
  speed yet; the list schema now accepts that instead of rejecting the whole
  list (which had hidden every stream from discovery), and a failed list is
  logged as `playback_discovery_failed` at most every five minutes.
- **Several entries sharing one torrent (2026-09-13 fix).** A series added
  twice (same infohash, two library entries) was credited to whichever entry
  the hash → entry maps indexed last, so the Activity page showed `Idle` and
  no runway row while the other entry was in fact streaming. `/api/playback`
  and the sampler's owner index now keep every owner per hash: the session
  reports the owner that is streaming (or downloading), and discovery
  credits the owner already seen streaming, else one holding a bitrate for
  the file being read, else the most recently streamed.
- Tests: `tests/playback-telemetry.test.ts`, `tests/runway-ui.test.ts`, new
  `cacheState` cases in `tests/torrserver-client.test.ts`, the route in
  `tests/routes.dispatch.test.ts`.

**Phase 1 exit criterion still open:** watch one full film on the TV and
confirm the runway line and warn log agree with what the viewer sees before
Phase 3 (playback-aware TorrServer tuning) is started.

## Phase 2 — Bitrate-aware stream presentation

- **One rule** (`src/line-fit.ts`): a file _fits_ when its average bitrate is
  at most 80 % of the line speed (`LINE_FIT_MARGIN = 0.8`). `lineFit(line)`
  returns `{ lineMbps, fitMbps }`; `fitsLine` returns `undefined` when either
  side is unknown so nothing is demoted on missing data.
- **Stream list** (`src/streams.ts`): every assembled stream carries a
  `bitrateMbps` — the probed source bitrate for direct play, remux and audio
  repairs; the configured encode target for video re-encodes and the
  lower-bitrate rendition. `presentStreams` lists fitting streams first (order
  preserved within each group) and appends heavy ones with
  `• needs 12.0 Mbps, line ~9 Mbps` on the description. Nothing is hidden.
- **Speed test median** (`src/speedtest.ts`): the effective speed is the
  median of the last three runs (`SPEED_HISTORY`), so one bad run does not
  demote every heavy file. `currentSpeed()` gains `samples`;
  `recentSpeeds()` exposes the history; `/api/speedtest` returns the raw run
  plus `effective`.
- **`/api/status`** includes `lineFit`, and the source-check panel adds a
  **Line fit** row (`Fits · needs 4.0 Mbps of ~9 Mbps` /
  `Heavy · needs 12.0 Mbps, line ~9 Mbps`) computed from that server value, so
  the UI verdict cannot drift from the stream ordering.
- Tests: `tests/line-fit.test.ts`, `presentStreams` and bitrate cases in
  `tests/streams.test.ts`, median cases in `tests/speedtest.test.ts`, the row
  in `tests/source-check-ui.test.ts`, status shape in
  `tests/routes.dispatch.test.ts`.

## Not changed

No new dependencies, no TorrServer settings writes (Phase 3), no
ARM64/`x265` work, no pointer or library changes. `getStreams` still returns
only the requested file's variants, so ordering applies within that list.
