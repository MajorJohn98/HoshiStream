# 2026-09-30 — Stream test before Add

Status: phase 1 implemented 2026-09-30 (see "Phase 1 as built"); phase 2,
the Chrome companion, implemented 2026-10-01 (see "Phase 2: Chrome
companion" at the end); phase 3 planned. Decision: entry 0029 in
[decision-log.md](../decisions/decision-log.md).

## Problem

A torrent streams smoothly only if its peers deliver data faster than the
file plays. Two limits decide that: the **swarm** (how fast its peers send)
and the owner's **line** (their Internet download speed). Today the owner
finds out only after saving a series and pressing play, when it stalls.
Post-save source checks (0019, 0023) prove the file is readable, not that it
keeps up.

## Goal

An owner-triggered **Test streaming** action on a torrent before it is
saved. The action answers three questions in about a minute:

1. How fast does this file play? (bitrate, Mbps)
2. How fast do its peers deliver it here? (sustained swarm rate, Mbps)
3. Which one is the bottleneck, and what can the owner do about it?

Example result card:

```
Won't keep up. The swarm is the limit.
Needs 9.8 Mbps · peers deliver 4.1 Mbps (23 peers) · your line 48 Mbps
Options:
  Start it, then pause about 58 min to buffer (1.8 GB; fits the cache)
  Copy it to disk first (about 1 h 40 min)
  Pick a release with more seeders
[Test longer]  [Test another file ▾]
```

The verdict is advice only. Save is never disabled or delayed.

## How the test works

1. **Register.** The test calls `registerSource()` (TorrServer `add` with
   `save_to_db: false`) and records whether TorrServer already knew the
   hash.
2. **Metadata.** It calls `waitForFiles()` with a 30 s limit (60 s when
   testing longer). A timeout gives an Inconclusive result: "No peers
   answered".
3. **Pick a file.** The test uses the same rules as inspection
   (`selectMediaFiles`): the main video for a movie, or the first episode for
   a series (form type and hints). The owner can pick another playable file.
4. **Measure, in parallel:**
   - **Bitrate.** The bounded `probeMedia()` on the `/play` URL (the rest
     of the run's time budget; see "Live test" below)
     gives the average bitrate and duration. When ffprobe reports no
     bitrate, the test uses size × 8 / duration.
   - **Swarm rate.** The test reads the file from its start through
     `/play/{hash}/{id}` as fast as data arrives, as a player that is
     filling its buffer would. Meanwhile it samples `/cache` every 2 s for
     `download_speed`, `active_peers`, `connected_seeders` and `Filled`.
     The first 10 s are warm-up and are ignored. The sustained rate is the
     median of the later samples, cross-checked against the test's own
     read throughput; the lower figure counts.
5. **Stop** at the time budget, at the byte cap, or when the owner cancels.
   The test closes its reader and keeps the result in memory.

The test needs no new TorrServer endpoints. Reads go through `/play`,
which runs no preloader.

Because the reads start at byte 0, playing right after the test may start
from cache. This isn't guaranteed: TorrServer drops idle torrents after
`TorrentDisconnectTimeout`, which ships at 600 s.

## Verdict

Inputs:

- `B`: the file's average bitrate (Mbps).
- `D`: its duration (s).
- `S`: its size (bytes).
- `R`: the sustained swarm rate (Mbps): what a player gets, in order.
- `T`: TorrServer's download rate, the median of its `download_speed`
  samples after warm-up (Mbps). It counts every byte peers send, overhead
  and out-of-order pieces included, so it can run well above `R`. With too
  few samples, `T` is `R`.
- `L`: the line speed (Mbps). This is the median of the recent speed tests,
  or the configured `HOME_SPEED_MBPS`, shown with its age. The stream test
  never starts a speed test, because the two would compete for the line.
- `K`: TorrServer's `DownloadRateLimit`, if set (KiB/s × 1024 × 8 / 10⁶).
- `C`: the read-ahead window (`CacheSize` × `ReaderReadAHead`%; 3 GiB as
  shipped).

`R` and `T` are observed through the real line, so they already reflect `L`
and `K`. `L` and `K` only decide which limit gets named. They cap what peers
send, not what arrives in order, so they are compared with `T`: at a
0.8 Mbps limit, a live test saw `T` = 0.8 Mbps but `R` = 0.4 Mbps.

| Level | Rule |
| --- | --- |
| Smooth | `R ≥ 1.2 × B` (`SUSTAIN_MARGIN`, as in playback telemetry) |
| Tight | `B ≤ R < 1.2 × B`: plays, but with little room for peer churn or bitrate peaks |
| Won't keep up | `R < B` |
| Inconclusive | No metadata in time, no peers, fewer than 5 samples after warm-up, or an unknown bitrate (numbers still shown) |

The named bottleneck is chosen in this order:

1. **The TorrServer limit**, if `K` is set and `T ≥ 0.9 × K`.
2. **The owner's line**, if `T ≥ 0.9 × L`.
3. **The swarm**, otherwise.

If `T > 1.1 × L`, the line reading is stale, so the card offers **Measure
line** (the existing `POST /api/speedtest`). It is shown only when no test
is running.

Remedies, shown when `R < 1.2 × B`:

- **Wait before playing**: `W = D × (B / R − 1)` s. For Tight results, the
  wait for a 1.2× margin is `D × (1.2 × B / R − 1)`.
- **Peak buffer**: `P = D × (B − R) × 10⁶ / 8` bytes, reached when playback
  starts. The wait is offered only if `P ≤ C`. Otherwise the card says the
  buffer won't fit in TorrServer's cache.
- **Copy to disk first** (0002 disk copies): `S × 8 / (R × 10⁶)` s.
- **If the line is the limit**: releases up to `R / 1.2` Mbps should play
  smoothly. For this runtime that is about `R / 1.2 × D / 8` MB.
- **If the swarm is the limit**: pick a release with more seeders, copy it
  to disk, or wait before playing.

Measurement flags:

- **At least X Mbps.** The byte cap ended the test before the time budget,
  so `R` is only a lower bound. If Smooth is not yet proven, the card
  suggests Test longer.
- **Still speeding up.** The median of the last third of samples is at
  least 1.25 × the first third. Swarms often speed up over the first minute
  as more peers connect, so the card suggests Test longer.
- **Line shared with a disk copy.** A disk copy was downloading during the
  test, so the line may be the limit only because of that.

Worked examples (fixtures for the tests):

- **42-minute episode, 3.1 GB.** `B` 9.8, `R` 4.1, `L` 48, so the swarm
  is the limit and the result is Won't keep up. `W` ≈ 58 min, `P` ≈ 1.8 GB
  (fits in 3 GiB), and the copy takes about 1 h 40 min.
- **2-hour 4K remux, 54 GB.** `B` 60, `R` 40, `L` 42, so the line is the
  limit and the result is Won't keep up. `P` ≈ 18 GB does not fit the
  cache, so the card offers the copy (about 3 h) and a target of about 33
  Mbps (≈ 30 GB for this runtime).

## Limits and safety

- **Explicit only.** One test, on one torrent, per click. No automatic,
  batch or background tests. Search and ranking (0028) still contact no
  peers.
- **One at a time.** The work slot in `source-checks.ts` becomes a small
  shared FIFO lock. Checks and tests take turns, and a waiting test shows
  "Waiting for a source check" (entry 0023: one coordinator runs all
  analysis).
- **Budgets.** A basic test takes at most 90 s and about 256 MB; Test
  longer takes at most 180 s and about 1 GB. Bytes are counted as the
  growth of `/cache` `Filled`, and data peers already had in flight can add
  a little more.
- **Playback first.** A test won't start while HoshiStream is streaming
  (stream activity in the last 10 s; the error is `streaming_active`). If
  a stream starts during a test, the test stops early and reports what it
  measured. The archiver treats a running test like playback for its
  between-files yield.
- **Memory only.** Results are kept for 10 minutes: at most 1 running,
  3 queued and 8 kept in total. Nothing is persisted, sent to the pointer or
  included in feedback reports.
- **Cleanup.** When a test is cancelled or expires, or its draft is
  discarded, the test removes the torrent (TorrServer `rem`). It does so
  only if the test registered it, and no library entry, draft, preview or
  other test uses the hash. Saving the source keeps the torrent registered.
  The shutdown code cancels tests and waits for their readers to close.
- **Logs.** Logs record the test ID, phase, outcome, rates and durations,
  never a magnet, file path, file name or token.
- **Privacy.** A test joins the swarm just as playback does: trackers and
  peers see the public IP, and TorrServer may upload pieces it holds.

## API (management, bearer token)

```
POST   /api/stream-tests
  { source: { magnetUri } | { torrentFilePath } | { draftId },
    type?: "movie" | "series", seasonHint?, episodeHint?,
    fileId?, mode?: "basic" | "extended" }
  → 202 { testId, phase: "queued", expiresAt }
GET    /api/stream-tests/{testId}  → the test's current state
DELETE /api/stream-tests/{testId}  → 204 (cancels and cleans up)
```

- **Magnet links** must hold a single BTv1 identity; the test reuses the
  import parser.
- **`torrentFilePath`** must be a staged upload under the upload root
  (`isManagedMediaPath`).
- **`draftId`** resolves the source of an `ImportService` draft.
- **Errors:**
  - `400 invalid_source`
  - `404 not_found`
  - `409 streaming_active`
  - `410 draft_expired`
  - `429 stream_test_busy`
  - `503` while the server is shutting down
- **State** is returned as:
  - `phase`: queued, metadata, measuring, done, cancelled or failed
  - `hash` and the elapsed time
  - `file`: its ID, name and size
  - `files`: the playable files, at most 200
  - `bitrate`, `swarm` (sustained, TorrServer's download rate, peak,
    at-least, still-speeding-up, peers and seeders), `line` and `verdict`

  It never includes a magnet or a path.

## Code changes (phase 1)

- `src/stream-verdict.ts`: the pure verdict and remedy math above.
- `src/stream-tests.ts`: a `StreamTests` service. It holds the in-memory
  records and the queue, and runs each test (register, metadata, pick,
  probe alongside read-and-sample). It also handles cleanup, the TTL and
  `close()`.
- `src/analysis-slot.ts`: the shared work slot. `source-checks.ts` is moved
  onto it with no change in behaviour.
- `src/imports/service.ts`: a draft-source lookup, plus a hook that cancels
  a draft's tests when the draft is dropped or expires.
- `src/routes/stream-tests-api.ts`: Zod schemas and handlers; registered in
  the route table and wired in `src/index.ts`.
- `src/archiver.ts`: counts a running test as activity in its playback
  yield.
- `assets/manage/components/stream-test.js`: the progress and result card.
- `assets/manage/views/add.js`:
  - A **Test streaming** button for Magnet link and `.torrent` sources. It
    reuses `prepareSource()`, so a tested `.torrent` isn't uploaded twice
    on Save.
  - A **Cancel** control.
  - Changing the source or closing the sheet cancels the test.

## Phases

1. **Server and Add Media.** Everything above. Only the main torrent is
   tested; extra series torrents can be tested after saving, in a later
   phase.
2. **Chrome companion.** The native commands `startStreamTest`,
   `getStreamTest` and `cancelStreamTest` are added to the helper's
   allowlist, keyed by draft. The side panel's review shows the same card,
   and discarding the draft cancels its test. See "Phase 2: Chrome
   companion" below.
3. **Search (0028).** Each result can be tested through a draft. Before any
   test, results show an estimated need from `videoSize` and the Cinemeta
   runtime.

## Tests

- `tests/stream-verdict.test.ts` covers:
  - every level and bottleneck (swarm, line, limit)
  - `W`, `P` and whether it fits the cache, copy time and target size
  - the lower-bound and still-speeding-up flags
  - an unknown bitrate
  - both worked examples
- `tests/stream-tests.test.ts` uses a fake TorrServer, fake probe and fake
  clock. It covers:
  - the normal flow and a metadata timeout
  - the byte cap and the time budget
  - cancelling, a stream starting mid-test, and the refusal while streaming
  - turn-taking with a running source check, in both directions
  - cleanup only when the test registered the torrent and the hash is
    otherwise unused, and keeping the torrent after Save
  - the TTL, queue limits and shutdown
- `tests/stream-tests-api.test.ts` covers:
  - auth and validation
  - a `.torrent` path outside the upload root, an expired draft and an
    unknown test
  - responses carrying no magnet or path
  - log hygiene (no magnet, path, file name or token)
- `tests/stream-test-ui.test.ts` covers the card's progress, verdict and
  remedy rendering, and cancelling on a source change.

Run from `addon/`: `npm run typecheck`, `npm test`, `npm run lint` and
`npm run format:check`.

## Docs to update

- `api/management-api-reference.md`: the three endpoints.
- `api/torrserver-endpoints-used.md`: sustained `/play` reads with a byte
  cap, `/cache` sampling, `rem` for cleanup, and the `DownloadRateLimit`
  unit (KiB/s, `server/torr/btserver.go`).
- `guides/adding-media.md`: how to read the verdict and remedies.
- `guides/privacy-and-network.md`: testing contacts peers before Add.
- `architecture/architecture-overview.md`: the new modules.
- `guides/chrome-companion.md` (phase 2), a changelog entry, and
  `index.md`.

## Out of scope

- Remote viewers' limit: the home **upload** speed. The speed test measures
  download only.
- Tests on capture, on every episode of a pack, or in the background.
- Tracker scrapes or seeder counts before a test; learned or remote scores.
- Saving results on entries.

## Open questions

- Offer an opt-in auto-test when the companion captures? The default is no.
- Are the budgets right: 90 s / 256 MB basic, and 180 s / 1 GB for Test
  longer?
- Should the verdict carry over to the saved entry's health card? The
  default is no, memory only.

## Phase 1 as built (2026-09-30)

Summary: [changelog/pre-add-stream-test.md](../changelog/pre-add-stream-test.md).
The open questions keep their defaults. Differences from the plan above:

- **Timing and bytes.**
  - The bitrate probe may use the rest of the run's time budget (see
    "Live test" below).
  - The byte cap counts the larger of `/cache` growth and the bytes the
    test's reader received.
  - A test that reads the whole file stops as `complete`.
  - If the probe finds no duration, it is estimated as size × 8 ÷ bitrate.
  - Inconclusive results suggest Test longer unless a stream stopped the
    test.
- **Queue.**
  - `streaming_active` is also reported when a queued test reaches the
    front.
  - A test left queued past its TTL is cancelled with `expired`.
  - A source check queued behind a test keeps its own deadline running.
- **API.**
  - `POST` returns the full test state, not only `{testId, phase,
    expiresAt}`.
  - The state carries a live `progress` field while measuring.
  - `fileId` accepts any nonnegative integer.
  - Without the service, the API answers `409 stream_test_unavailable`.
  - `DELETE` also removes the record. A test cancelled because its draft
    was dropped stays visible until it expires.
  - File names are paths inside the torrent. The torrent is registered
    without a title, and logs leave out hashes as well.
- **Cleanup and activity.**
  - Failed and no-metadata tests release their torrent at once. A finished
    test holds it until its record goes.
  - Queued tests also count as users of their hash, so Test longer and
    Test this file keep the torrent between tests.
  - Cleanup spares a hash used by a save in flight (`ImportService`
    `committing`). It matches saved entries by `.torrent` path as well as
    hash.
  - A 60 s sweep prunes records and re-checks the torrents tests
    registered.
  - `activity.ts` tracks tests, and playback telemetry skips tested hashes.
- **Add Media.**
  - A `.torrent` is tested by its staged upload path, not through a draft.
    A tested upload that is never saved stays in managed uploads (at most
    1 MB).
  - Test longer and Test this file start the new test before deleting the
    old one.
  - Editing a tested field marks the result out of date instead of
    cancelling it.
  - Closing the browser tab sends a keepalive `DELETE`.
  - The file picker is a select plus **Test this file**, and the client
    checks the `magnet:?` prefix.
  - Durations round to the minute, and the remedy wording differs from the
    examples above.

## Live test (2026-10-01)

Phase 1 was run against a real TorrServer (MatriX.141) in a throwaway state
folder, never the installed app, with Sintel (Blender Foundation, CC BY),
using its archive and WebTorrent torrents. Confirmed: a Smooth verdict,
`DELETE` cleanup, magnet tests and cancel, the multi-file pick and `fileId`.
To reproduce a slow swarm, TorrServer's `DownloadRateLimit` was set to
96 KiB/s (0.8 Mbps) before any torrent was added. Two fixes followed:

- **Probe budget.** A 1.2 Mbps Sintel MP4 came back Inconclusive
  (`unknown_bitrate`) at 0.4 Mbps. Its index (`moov`) sits at the end of the
  file, so ffprobe needs the tail before the start, and the 20 s budget ran
  out first. A player fetches that tail first too, so the probe may now use
  the whole run: the time left until the test's deadline. After the fix, the
  same file measured 1.2 Mbps over 888 s.
- **Bottleneck.** TorrServer reported the 0.8 Mbps cap while only 0.4 Mbps
  arrived in order, so comparing `R` with `0.9 × K` blamed the swarm and
  suggested a better-seeded release. The limit and line checks now use `T`,
  added to the state as `swarm.downloadMbps`, and the details list shows it
  as **TorrServer download rate** when it differs from `R`. The re-run said
  Won't keep up, bottleneck the limit.

Without a cap, `T` also ran above `R` (9.3 against 7.4 Mbps).

Known issue, not fixed: with a connected torrent (such as one a finished
test holds), changing TorrServer settings can leave TorrServer without a
BitTorrent client. It drops all torrents, and its peer port stops
listening. Adding a torrent then fails until TorrServer restarts or the
settings are saved again. `SetSettings` in MatriX.141 ignores the error from
reconnecting the client. This matters here because the limit remedy leads
the owner to raise the limit while the test still holds its torrent.

## Phase 2: Chrome companion (2026-10-01)

The side panel tests the prepared draft before Add, with the same card text
as Add Media. No server change: the helper relays the phase 1 endpoints.

- **Helper allowlist.** Three strict commands, each one fixed route:
  - `startStreamTest` → `POST /api/stream-tests` with `source: {draftId}`,
    plus the optional `type`, `seasonHint`, `episodeHint`, `fileId` and
    `mode`. A magnet or a `.torrent` path is never accepted from the
    browser.
  - `getStreamTest {testId}` → `GET /api/stream-tests/{testId}`.
  - `cancelStreamTest {testId}` → `DELETE`, answered `{cancelled: true}`.
  - The helper validates the state it relays and drops what the panel
    doesn't need (the infohash).
- **Shared text.** The card's wording helpers move to a dependency-free
  `stream-test-text.js`. The extension can't import from the management
  page, so it keeps a byte-identical copy in `lib/`, and a test fails if
  the two differ. The companion has no Measure line button, so the stale
  line note points at the speed test on the app's Status page instead.
- **Panel state.** A `streamTest` section in session storage holds the
  last test, the type and numbering it ran with, and any error. Selecting
  another source, a fresh draft and a save clear it. A test result survives
  a series preview (which consumes the draft), but a new test needs a live
  draft. Editing the type or numbering after a test marks it out of date.
- **Lifecycle.** The panel polls every 2 s while a test runs, through a
  second check poller. Closing the panel doesn't cancel the test: it keeps
  running and the panel picks it up again. Discarding the draft (another
  source, Clear source) cancels it, as does a save. Test again and Test
  this file end the previous test only after the new one starts, so the
  torrent stays registered.
- **As built.** Details settled during the build:
  - Polls merge only the `streamTest` section and don't broadcast, so a
    poll never overwrites fields the owner is typing.
  - While a new test starts, the card hides the previous result; a failed
    start shows it again with the error.
  - Test longer and Test this file reuse the shown test's type and
    numbering.
  - Cancel treats `not_found` as cancelled. A finished test has nothing to
    stop, so its result stays.
  - A poll's `not_found` clears the card with the server's "Test again"
    message.
  - An older app's helper rejects the new commands with `invalid_request`;
    the card then asks the owner to update HoshiStream.
  - The card stays visible after a series preview reserves the draft,
    with a hint to cancel the preview and prepare the source again.
  - Ending a test is the last step of releasing a draft (preview, then
    draft, then test). With nothing else holding the torrent, TorrServer
    drops it at once instead of at the next sweep.
  - The extension version is 0.2.0.
- **Card.** Between the details and the duplicate warning: a badge, the
  summary, live progress, the figures, the remedies, the notes, a details
  list, Test streaming / Test again / Cancel test / Test longer (up to
  3 min), Refresh status after poll errors, and a file picker for
  multi-file torrents.
- **Out of scope.** Measuring the line from the companion (the speed test
  takes longer than the helper's 15 s request limit), and testing after a
  series preview consumed the draft.
- **Tests.** Protocol accept/reject, helper routes and field stripping,
  the identical copies, panel state (reset, staleness, payload, recovery),
  the poller's `isActive` option, and the panel's element IDs. A contract
  test relays real `StreamTests` reports through the helper client. A
  service-worker harness with a fake `chrome` and native port covers
  start, replace, poll, cancel and release order. A packaging guard checks
  that every extension import stays inside the extension folder. Full
  suite: 1313 passed, 2 skipped.
