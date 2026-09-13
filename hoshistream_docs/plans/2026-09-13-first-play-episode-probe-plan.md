# First-play episode probe

**Date:** 2026-09-13
**Status:** ✅ implemented
**Relates to:** [playback pointer / library expansion plan](2026-09-12-playback-pointer-library-expansion-plan.md) (Phase 1 runway telemetry)

## Problem

"Analyze playback" probes one file per entry, so for a series only that
episode has a bitrate. The Activity page's runway line reads
"bitrate not analyzed" for every other episode, and the low-runway warning
never fires for them. Episodes in one release share encoder settings but
their bitrates still differ enough (±20–30 %) that borrowing a sibling's
figure is a guess, not a measurement.

## Decision

Probe each episode the first time it is played, then keep the result. The
per-file `mediaFacts` store already holds one fact per `(revision, fileId,
path, length, sourceHash)`, so a replay finds its fact and no probe runs.

## Design

- New `PlaybackProbes` (`addon/src/playback-probes.ts`), given the library
  and `SourceChecks`.
  - `ensure(target)`: no-op when the file already has a media fact, when a
    probe for that file is pending, when the same file failed within the
    last 10 minutes (cooldown), or when another check is active for the
    entry (a user-started check is never interrupted). Otherwise it runs
    `sourceChecks.check(entryId, { probe: true, fileId, mode: "extended" })`
    in the background and logs `playback_probe_finished` with the outcome.
  - `pending(target)`: whether a probe is in flight, for the UI.
- `PlaybackTelemetry` gets an optional `probes` collaborator. Each tick,
  every active stream target with no bitrate is handed to `probes.ensure`.
  When a probe yields a bitrate, `setStreamTargetBitrate` updates the live
  target so the next sample computes a runway. The report gains a
  `probing` flag per stream.
- The Activity runway line shows "measuring bitrate…" while a probe is
  pending instead of "bitrate not analyzed".

## Why this shape

- Triggering from the telemetry tick covers both paths (stream request from
  the add-on and a player going straight to TorrServer with a cached URL)
  without threading a new dependency through `streams.ts`.
- `SourceChecks` already serialises checks, persists per-file facts, updates
  the entry's check status, and has the extended time budget (metadata
  60 s / sample 120 s) a busy swarm may need. The torrent is already
  loaded in TorrServer while it plays, so the metadata stage is quick, and
  the bounded ffprobe sample (~2 MB from the file head) mostly hits pieces
  the player has already fetched.
- Cooldown and dedupe keep a failing file from being probed every 2 s.

## Out of scope

- Probing every episode up front (200 probes for a long series).
- Re-deriving the served file when a player changes episode through a
  cached URL; the add-on sees a fresh `stream` request per episode in
  practice.
