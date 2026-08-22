# Performance, Built-in Player, and Cross-Platform Plan

Status: Phases 1–4 shipped (see [changelog/0.6.0-performance.md](../changelog/0.6.0-performance.md)); Phases 5–6 partially done
Date: 2026-08-14

## Progress

| Phase | State |
|---|---|
| 1 — TorrServer tuning | Shipped |
| 2 — Server hot paths | Shipped; inspection cache measured at 5.9× on the hot path |
| 3 — Direct-play awareness | Shipped (D3 still deferred: warnings only, no remuxing) |
| 4 — Built-in player | Shipped, ahead of Phase 5 — see below |
| 5 — Cross-platform foundation | Partial: path-safety module and Windows vendoring done; supervisor rewrite not started |
| 6 — Windows packaging | Not started |

Two things changed from the original sequencing.

**The player shipped before the supervisor rewrite.** This plan originally ordered Phase 5
before Phase 4 on the grounds that building the player against the Swift supervisor would
mean writing it twice. That reasoning was wrong: the player belongs in the Node add-on,
which is already cross-platform, so it has no dependency on the supervisor at all.
Recorded in [ADR 0008](../decisions/0008-bundled-mpv-player-over-json-ipc.md).

**The path-safety module was pulled forward** out of Phase 5, because the POSIX
assumptions it replaces were live defects rather than only Windows blockers —
`removeManagedMedia` compared against a hardcoded `/` and would never have cleaned up
managed media on Windows.

## Remaining work and why it is blocked

- **D1, the supervisor technology decision, is still open**, so no ADR supersedes ADR 0003
  yet. The Go rewrite replaces roughly 470 lines of working Swift and cannot be verified
  on this machine, so starting it would trade working code for untested code.
- **Bundling `mpv` is blocked on its GPL distribution terms.** Until that is settled,
  binary resolution falls through to `PATH` and then to the system handoff, both of which
  work today.
- **Windows packaging needs a Windows machine** to build and verify. The vendoring
  lockfiles and fetch scripts are ready for it.
- **The Phase 1 playback measurement needs a real TV.** Time-to-first-frame and stall
  counts cannot be observed from a development environment, and they are the numbers that
  actually matter for the TorrServer tuning.

## Problem

Manage a personal movie library and direct-play torrent links and local files to a TV
without stalling. Three gaps stand between the current build and that goal.

1. **Throughput and latency.** TorrServer is configured conservatively enough that peer
   throughput, not network capacity, is the binding constraint. The add-on repeats
   expensive filesystem and parsing work on every HTTP range request.
2. **Client dependency.** Watching on the Mac itself requires Stremio or another
   third-party add-on client, even though the library, the streams, and the UI are all
   local.
3. **Platform lock-in.** The native app is macOS-only: a Swift/AppKit supervisor, POSIX
   shell scripts, a Unix domain socket picker, and hardcoded POSIX path handling.
   Windows is now a shipping target.

## Goals

- Remove buffering caused by configuration and by per-request server work.
- Play a library entry on the host machine without installing a separate client.
- Ship a single supported feature set on macOS and Windows from one codebase.

## Non-Goals

- Torrent search, indexers, or scrapers.
- A database. The JSON library stays.
- Video transcoding. Audio remuxing is discussed in Phase 3 but is explicitly gated on an
  ADR because it conflicts with the current working agreement.
- Linux packaging. The code should not preclude it, but it is out of scope here.

## Open Decisions

| # | Decision | Blocks | Recommendation |
|---|---|---|---|
| D1 | Supervisor technology for cross-platform | Phase 5, 6 | Go + system tray, replacing Swift/AppKit |
| D2 | Player strategy | Phase 4 | Bundle `mpv`, drive it over its JSON IPC socket |
| D3 | Allow audio-only remux for incompatible tracks | Phase 3 | Defer; surface a warning first, measure how often it matters |
| D4 | Keep Docker Compose as a supported mode | Phase 5 | Keep, but demote from the documented default |

---

## Phase 1 — TorrServer Tuning

No code. Highest impact per unit of effort. Applies to `torrserver/config/settings.json`
and `native-data/torrserver/config/settings.json`, which currently disagree.

| Setting | Current | Target | Rationale |
|---|---|---|---|
| `ConnectionsLimit` | 25 | 200 | The dominant throughput cap. A 25-peer ceiling starves well-seeded swarms. |
| `DisableUpload` | true | false | Peers reciprocate. Refusing to upload gets the client deprioritized or choked by most modern clients. |
| `PeersListenPort` | 0 | fixed (e.g. 32001) | Port 0 plus `DisableUPNP` means no inbound connections; only non-firewalled peers are reachable. |
| `DisableUPNP` | true | keep true | Prefer an explicit manual router forward over UPnP for a private setup. |
| `EnableIPv6` | false | true | Materially enlarges the reachable peer pool. |
| `TorrentDisconnectTimeout` | 30 native / 300 docker | 600 both | With `RemoveCacheOnDrop: true`, a 30s pause discards the cache and forces a cold rebuffer on resume. |
| `ReaderReadAHead` | 95 | 75 | At 95%, almost no cache sits behind the playhead, so every backward seek re-downloads. |
| `CacheSize` | 2 GiB | 4 GiB where RAM allows | Pairs with the lower readahead to keep a real backward window. |
| `PreloadCache` | 25 | 40 | Trades a slightly slower start for a much lower chance of an early stall. |

Also reconcile the two settings files so native and Docker behave identically, and
document each value's reasoning in the guide rather than leaving them bare.

**Verify:** measure time-to-first-frame and count stalls over a full episode, before and
after, on the same torrent.

## Phase 2 — Server Hot Paths

1. **Cache local inspection.** `serveLocalMedia` calls `inspectLocalEntry` on every
   request — a recursive `readdir` walk plus a `stat` per discovered file. TV players
   issue many range requests per seek, so a folder-backed series performs a full
   directory walk on every scrub. Add an in-memory cache keyed by entry id, invalidated
   on directory `mtime` change.
2. **Cache the library read.** `Library.list()` reads and Zod-parses the entire JSON file
   on every call, including from inside every range request. Hold the parsed array in
   memory, invalidate on write and on external `mtime` change. Keep the existing
   corrupt-file recovery path intact.
3. **Size the read buffer.** `createReadStream(...).pipe(response)` uses the 64 KiB
   default, which is syscall-heavy at 4K remux bitrates. Set `highWaterMark` to 4 MiB for
   media responses and call `setNoDelay(true)` on the socket.
4. **Stop re-registering cached torrents.** `resolveStreamSource` calls `registerTorrent`
   on every stream request even when `inspectionCache` is populated, adding a TorrServer
   round-trip before playback starts. Try `torrServer.get(hash)` first, re-add only on a
   miss.
5. **Prewarm the next item.** When a series entry is opened, register and preload the next
   episode in the background so its start is warm rather than cold.

**Verify:** `npm run typecheck`, `npm test`, `npm run lint`, `npm run format:check` from
`addon/`, plus `docker compose config -q` from root. Add regression tests for both new
caches, including invalidation.

## Phase 3 — Direct-Play Awareness

Most perceived "lag" on a TV is not bandwidth — it is the client falling back to software
decoding for DTS, TrueHD, or 10-bit HEVC. `media-probe.ts` already shells out to `ffprobe`
and extracts codec information, but nothing acts on it.

1. Persist the probe summary on the library entry alongside `inspectionCache`.
2. Show a direct-play indicator in the management UI: container, video codec, audio codec,
   bitrate, and a plain-language warning for common stutter sources.
3. Include the warning in the Stremio stream description so it is visible at selection time.
4. **Gated on D3.** If warnings prove insufficient, audio-only remux to AC-3 or AAC is
   cheap and near-realtime because video is stream-copied. Requires a new ADR amending the
   "no transcoding" rule in `AGENTS.md`; do not implement on the strength of this plan alone.

## Phase 4 — Built-in Player

Three approaches considered:

- **HTML5 `<video>` in the management UI.** Free, but neither WKWebView nor WebView2 plays
  MKV containers or DTS/TrueHD audio — most of a torrent-sourced library. Keep only as an
  MP4/H.264 fallback.
- **Hand off to an installed player** (IINA, VLC). Trivial, but still a third-party
  dependency, disjoint UX, and different launch mechanisms per platform.
- **Bundle `mpv` and drive it over its JSON IPC socket (recommended, D2).** `mpv` ships as
  a self-contained binary for macOS and Windows, decodes everything in a torrent library,
  and hardware-decodes via VideoToolbox and D3D11. Its `--input-ipc-server` socket exposes
  full control — load, play, pause, seek, audio and subtitle track selection, position
  reporting — as line-delimited JSON.

That last option is the key insight: it delivers the experience of an embedded player at
roughly the cost of a launcher, from one codebase, on both platforms. No video pipeline,
no decoder integration, no Electron, no second Windows implementation.

1. Vendor `mpv` per platform using the existing `packaging/fetch-*.mjs` plus lockfile
   pattern, SHA-256 pinned exactly as TorrServer and Node are today.
2. Add a player process manager spawning `mpv` with a per-session IPC socket path — Unix
   socket on macOS, named pipe on Windows.
3. Add a JSON IPC client with a typed request/response wrapper and Zod validation on
   inbound events, per the external-boundary rule.
4. Add a "Play here" control to the management UI, backed by a token-authenticated
   management endpoint.
5. For local entries, pass the file path directly to `mpv`, bypassing HTTP, Node, and the
   range-request machinery entirely. For torrents, pass the TorrServer `/play` URL with
   tuned `--cache-secs` and `--demuxer-max-bytes`.
6. Report playback position back to the library so resume works.

## Phase 5 — Cross-Platform Foundation

Already portable: the add-on is plain Node and ESM; `fetch-node-runtime.mjs` and
`fetch-torrserver.mjs` already key off `${process.platform}-${process.arch}`; the
management UI is static ES modules.

macOS-only and must change:

1. **Supervisor (D1).** `supervisor/macos/Sources/*.swift` is ~470 lines of AppKit: tray
   UI, process supervision, autostart, sleep prevention. Recommend a Go rewrite with a
   system-tray library — single static binary per platform, clean cross-compilation, and a
   match for the Syncthing-style architecture ADR 0003 already committed to. This
   supersedes ADR 0003 and needs a new ADR.
2. **Shell scripts.** `start-native.sh`, `stop-native.sh`, `healthcheck.sh`, and
   `find-lan-ip.sh` become subcommands of the Go supervisor rather than being ported to
   PowerShell, so behavior cannot drift between platforms.
3. **Picker IPC.** `PickerSocket.swift` uses a Unix domain socket. Node's `net` module
   speaks Windows named pipes through the same API, so this is mostly a path abstraction
   plus a Windows file-dialog implementation.
4. **Path handling.** Several POSIX assumptions are load-bearing, some security-relevant:
   - `MEDIA_ROOT` and `UPLOAD_ROOT` default to `/media` and `/data/media`.
   - `removeManagedMedia` compares with a literal `` `${UPLOAD_ROOT}/` ``, which never
     matches on Windows.
   - The containment guards in `validateBrowserLocalPath` and `isManagedMediaPath` use
     case-sensitive `startsWith`. Windows paths are case-insensitive, so the guard must
     normalize case there or it can be bypassed.

   Centralize in one path-safety module with tests covering both platforms.
5. **Sleep prevention.** `caffeinate` on macOS, `SetThreadExecutionState` on Windows.
6. **Lockfiles.** Add `win32-x64` entries for Node, TorrServer, and `mpv`.

## Phase 6 — Windows Packaging and Distribution

1. Portable directory layout mirroring the current `.app` bundle: supervisor binary,
   `runtime/bin/node`, `runtime/addon`, `runtime/vendor`.
2. Autostart via a per-user Registry `Run` entry, matching macOS launchd behavior.
3. State directory at `%LOCALAPPDATA%\HoshiStream`, mirroring
   `~/Library/Application Support/HoshiStream`.
4. Windows Firewall: the add-on port and the TorrServer peer port need inbound rules.
   Prompt on first run rather than modifying firewall state silently.
5. Installer: start with a plain zip. MSI or WinGet later only if warranted.
6. Code signing is a known gap on both platforms — macOS uses an ad-hoc signature, Windows
   will trigger SmartScreen. Document the expectation rather than pretending it is solved.

## Sequencing

Phases 1 and 2 are independent and deliver most of the responsiveness benefit, so they go
first. Phase 5 must precede Phase 6, and should also precede Phase 4 — building the player
against the Swift supervisor would mean writing it twice.

```
Phase 1 (config) ─┐
                  ├─> measure ─> Phase 3 (direct-play)
Phase 2 (hot paths)┘

Phase 5 (cross-platform shell) ─> Phase 4 (player) ─> Phase 6 (Windows packaging)
```

## Risks

- **The Go supervisor rewrite is the largest single item** and replaces working code.
  Mitigate by keeping the Swift app buildable until the Go version reaches macOS parity,
  then removing it in one commit.
- **Raising `ConnectionsLimit` and enabling upload increases network exposure.** Normal
  BitTorrent behavior, but the change should be deliberate and documented.
- **Bundling `mpv` adds a large vendored binary and a GPL obligation.** Verify
  distribution terms before shipping; record the finding in an ADR.
- **Windows path-guard changes touch security boundaries.** They need tests before the
  behavior changes, not after.

## Verification

Every phase ends with `npm run typecheck`, `npm test`, `npm run lint`, and
`npm run format:check` from `addon/`, plus `docker compose config -q` from root. Phases 1
and 2 additionally require a before/after playback measurement — time to first frame and
stall count over one full episode — since the point is perceived smoothness, which the
test suite cannot observe.

## Documentation Deliverables

Per `AGENTS.md`, alongside the code:

- This plan committed to `hoshistream_docs/plans/`.
- ADR superseding 0003 (supervisor technology change).
- ADR for the bundled-`mpv` player decision, including licensing.
- ADR for D3 if audio remuxing is ever approved.
- Updated `guides/setup-*.md`, a new Windows setup guide, and `index.md`.
- Changelog entries per shipped phase.
