# Pre-add stream test

Phase 1 of [decision 0029](../decisions/decision-log.md) and the
[pre-add stream test plan](../plans/2026-09-30-pre-add-stream-test-plan.md).
A torrent could look fine, be saved, and only then turn out to download more
slowly than it plays. Add Media can now check that before you save: **Test
streaming** measures the file's bitrate against the rate its peers sustain
through TorrServer, names the bottleneck, and suggests what to do. It is
advice only and never blocks **Add to library**.

## Server

- **`/api/stream-tests`** (`routes/stream-tests-api.ts`): `POST` starts a
  test from a magnet, a staged `.torrent` path or a companion draft; `GET
  /{id}` polls it; `DELETE /{id}` cancels it and removes its record. Records
  live in memory only: 10 minutes each, at most 8, with up to 3 queued.
  See the [management API reference](../api/management-api-reference.md).
- **`stream-tests.ts`** registers the torrent with `save_to_db: false`, waits
  for metadata, picks the file as inspection does (series hints included),
  reads `/play` from byte 0 and samples `/cache` every 2 s after a 10 s
  warm-up. The bounded ffprobe reads the bitrate. A basic test stops at 90 s
  or 256 MiB; **Test longer** at 180 s or 1 GiB; either stops at the end of
  the file.
- **`stream-verdict.ts`** holds the pure math. **Smooth** needs a sustained
  rate of at least 1.2 × the bitrate, **Tight** at least the bitrate, and
  anything slower **won't keep up**. It blames TorrServer's download limit or
  the line when the rate reaches 90% of it, otherwise the swarm. Remedies:
  the wait to buffer and whether it fits TorrServer's read-ahead cache, the
  disk-copy time, a bitrate and size that should fit, or a better-seeded
  release. Flags cover "at least", "still speeding up", a disk copy sharing
  the line and a line reading the peers beat.
- **`analysis-slot.ts`**: source checks and stream tests take turns in one
  FIFO slot, so a test never measures a swarm or line another check is
  using. A queued source check's deadline keeps running.
- **`activity.ts`** marks hashes under test. Playback telemetry ignores
  them, the disk archiver yields while a test runs, a test refuses to start
  within 10 s of streaming (`streaming_active`), and playback starting ends a
  test early (inconclusive `stream_started`).
- **`ImportService`** gains `draftSource`, `hashInUse` (drafts, previews and
  commits in flight) and `onDraftDropped`. Discarding or expiring a draft
  cancels its tests.
- A test removes its torrent from TorrServer when it ends, unless the test
  didn't register it or another test, a draft, a preview, a save in flight or
  a library entry (by hash or `.torrent` path) uses it. A 60 s sweep prunes
  expired records. After a save the torrent stays registered, so playing
  soon after may start from data the test downloaded.
- Logs carry the test ID, outcome and rates only: no hashes, magnets, paths
  or file names.

## Add Media

- A **Stream test** card on the Magnet link and `.torrent` tabs
  (`assets/manage/components/stream-test.js`): **Test streaming** / **Test
  again**, live progress, **Cancel test**, the result with its figures and
  details, remedies and notes, **Test longer**, **Measure line**, and a file
  picker with **Test this file** for multi-video torrents.
- Editing the magnet, `.torrent`, type or series numbering marks a result out
  of date. Saving, switching tabs or closing the sheet cancels a running test;
  closing the browser tab sends a keepalive `DELETE`.
- A tested `.torrent` is uploaded once and Save reuses that upload.

## Tests

- New: `analysis-slot`, `stream-verdict`, `stream-tests`, `stream-tests-api`
  and `stream-test-ui`.
- Extended: `activity`, `playback-telemetry`, `search` (import drafts and
  commits) and `management`.
- Full suite: 1286 passed, 2 skipped.

## Docs

- [Adding media](../guides/adding-media.md): "Test streaming before you
  save".
- [Privacy and network](../guides/privacy-and-network.md): what a test sends
  and downloads.
- [TorrServer endpoints used](../api/torrserver-endpoints-used.md) and the
  [architecture overview](../architecture/architecture-overview.md).

## Not in this change

- Phase 2: a test button in the Chrome companion's review step.
- Phase 3: ranking in-app search results by the test
  ([decision 0028](../decisions/decision-log.md), not yet implemented).
- Testing **Additional torrents**; only the main torrent is tested.

## Live-test fixes (2026-10-01)

A live run against TorrServer MatriX.141 with Sintel, with TorrServer
capped at 0.8 Mbps to stand in for a slow swarm, found two bugs (details in
the plan's "Live test" section):

- **Bitrate probe budget.** An MP4 indexed at its end came back Inconclusive
  (`unknown_bitrate`) on a slow swarm because the 20 s probe ran out before
  the tail arrived. The probe may now use the rest of the run.
- **Wrong bottleneck under a limit.** TorrServer reached the cap while only
  about half of it arrived in order, so the verdict blamed the swarm. The
  limit and line checks now use TorrServer's own rate, reported as
  `swarm.downloadMbps` and shown as **TorrServer download rate**. The level
  still uses the in-order rate.

Tests: slow-probe cases for basic and **Test longer**, a limit-attribution
case built from the live numbers, a stale-line case, and the new detail
row. Full suite: 1291 passed, 2 skipped.

Known issue, not fixed: changing TorrServer settings while a torrent is
connected (for example one a finished test holds) can leave TorrServer
without a BitTorrent client until it restarts or the settings are saved
again.
