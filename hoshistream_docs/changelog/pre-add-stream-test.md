# Pre-add stream test

Phases 1 and 2 of [decision 0029](../decisions/decision-log.md) and the
[pre-add stream test plan](../plans/2026-09-30-pre-add-stream-test-plan.md).
A torrent could look fine, be saved, and only then turn out to download more
slowly than it plays. Add Media, and since phase 2 the Chrome companion, can
now check that before you save: **Test streaming** measures the file's
bitrate against the rate its peers sustain through TorrServer, names the
bottleneck, and suggests what to do. It is advice only and never blocks
**Add to library**.

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

- Phase 2: a test button in the Chrome companion's review step (added
  2026-10-01; see "Chrome companion" below).
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

## Chrome companion (2026-10-01)

Phase 2. The companion's side panel (extension 0.2.0) tests the prepared
source before **Add to HoshiStream**, with the same card and wording as Add
Media. There is no server change.

- **Native helper.** New allowlisted commands relay the phase 1 endpoints
  for a prepared draft only. `startStreamTest` takes a draft ID with the
  form's type, numbering, file and mode. `getStreamTest` and
  `cancelStreamTest` take a test ID. A magnet or file path is never
  accepted from the browser. The helper validates each report and drops
  the infohash.
- **Side panel.** A **Stream test** card in the review step offers:
  - **Test streaming** / **Test again**;
  - live progress and **Cancel test**;
  - the result with its figures, remedies, notes and details;
  - **Test longer (up to 3 min)**;
  - a file picker with **Test this file**;
  - **Refresh status** after a polling error.

  Changing the type or series numbering marks a result out of date.
- **Lifecycle.** Closing the panel doesn't stop a test; reopening it picks
  the test up again. Choosing another source, **Clear source**, saving, or a
  replacement test ends it. A replacement ends the old test only after the
  new one starts.
- **Line speed.** The companion can't measure the line, so its note
  points to the speed test on HoshiStream's Status page.
- **Older app.** If the app's helper predates these commands, the card
  asks you to update HoshiStream.
- **Shared wording.** The card text helpers moved to a dependency-free
  `stream-test-text.js`. The extension keeps a byte-identical copy in
  `lib/`.

Tests:

- New: `chrome-extension-stream-test` (panel state, polling, and a service
  worker harness with a fake `chrome` and native port).
- Extended:
  - `browser-native`: protocol, routes, and error relay;
  - `stream-tests`: real reports relayed through the helper client;
  - `stream-test-ui`: the identical text copies;
  - `chrome-extension-core`: imports stay inside the extension folder.
- Full suite: 1313 passed, 2 skipped.

Docs: [Chrome companion](../guides/chrome-companion.md) ("Test streaming
before you add") and the plan's "Phase 2: Chrome companion" section.

## Test anyway (2026-10-01)

On a fast line, waiting for playback to stop before testing was needless.
When playback refuses or stops a test, Add Media and the companion now offer
a one-off **Test anyway**, with a hint about what it costs. Nothing is
remembered: the next test waits for playback again.

- **Server.** `POST /api/stream-tests` and the helper's `startStreamTest`
  accept `allowPlayback`. Such a test skips the `streaming_active` checks at
  start and in the queue, and playback starting doesn't stop it. If
  something streamed while it measured, the verdict flags
  `sharedWithPlayback` and the level stays the same.
  `stream_test_started` logs `allowPlayback: true`.
- **Add Media.** **Test anyway** repeats the start that playback refused,
  or reruns the stopped test with the same mode and file.
- **Companion.** The same button. The panel remembers which start
  produced the shown test, so a test that failed in the queue reruns its
  chosen file.
- **Notes.** "Something was streaming during the test and shared your
  line." A conclusive result from a test that playback stopped early now
  says so too.

Tests:

- `stream-tests`: Test anyway while streaming (at start, through metadata
  and measuring) with the shared flag, and a queued Test anyway when
  playback starts before its turn.
- `stream-tests-api` and `browser-native`: the new field, valid and invalid.
- `stream-verdict`: the flag leaves the verdict otherwise unchanged.
- `stream-test-ui` and `chrome-extension-stream-test`: the notes, the hint,
  the retry options and the relayed payload.
- Full suite: 1321 passed, 2 skipped.

Docs: [Adding media](../guides/adding-media.md), [Chrome companion](../guides/chrome-companion.md),
the [management API reference](../api/management-api-reference.md) and the
plan's "Test anyway" section.
