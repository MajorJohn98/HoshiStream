# State Durability and Failure Handling Plan

Date: 2026-09-27. Status: implemented.

## Problem

A reliability scan (2026-09-27) found five gaps that turn ordinary faults — a
power cut, two overlapping requests, a TorrServer hiccup, a stray exception —
into lost settings or a dead server:

1. **Silent reseed on corruption.** `Tags` treats any read failure as a first
   run, reseeds the default genres, and persists them — overwriting the user's
   registry. `IdentityStore`, `DeviceNames`, and `MetadataSettingsStore` also
   fall back to defaults on corruption, and their next write replaces the
   unreadable file with no copy kept.
2. **Unserialized writers with a fixed temp name.** `IdentityStore`,
   `DeviceNames`, and `MetadataSettingsStore` read-modify-write without a queue
   and all write `<file>.tmp`, so overlapping requests can lose an update or
   fail the rename. `ArchiveSchedule` and `DiskCleanupTombstones` are
   serialized but share the fixed-name pattern.
3. **No `fsync`.** Every store writes temp + rename, which prevents torn reads
   but not loss on power failure: the rename can land before the data blocks.
4. **Transient TorrServer failure reads as "file gone".** `proxyTorrent`
   answers 404 "Unknown media file" when resolving the torrent throws (timeout,
   TorrServer restarting). Players treat 404 as permanent. The 502 path also
   writes to responses whose client already disconnected.
5. **No process-level crash handling.** Neither the native supervisor script
   nor the direct `index.ts` entry handles `uncaughtException` /
   `unhandledRejection`, so a stray error kills Node without running shutdown;
   TorrServer and mpv children can be orphaned holding ports. The direct entry
   also ignores SIGINT/SIGTERM.

## Changes

1. `addon/src/json-file.ts` (new, Node built-ins only):
   - `writeJsonFile(path, value)` — unique temp name, owner-only mode, `fsync`
     the file, rename, then best-effort `fsync` of the parent directory
     (unsupported on Windows; skipped there). Temp file removed on failure.
   - `readJsonFile(path, schema)` — returns `undefined` when the file is
     missing; on malformed JSON or schema failure, moves the file aside to
     `<file>.corrupt-<ts>`, logs `state_file_quarantined`, and returns
     `undefined`; any other I/O error is rethrown so callers never overwrite
     a file they could not read.
2. Stores:
   - `Tags`, `IdentityStore`, `DeviceNames`, `MetadataSettingsStore`,
     `ArchiveSchedule`, `DiskCleanupTombstones` use both helpers.
   - `IdentityStore`, `DeviceNames`, `MetadataSettingsStore` gain a mutation
     queue. Their reads still degrade to defaults on an I/O error (the manifest
     must keep serving) but do not cache that result; writes propagate it.
   - `Library`, `VolumeRegistry`, `OnboardingStore`, and the pointer config
     writer switch to `writeJsonFile` for `fsync` durability; their existing
     backup/recovery logic is unchanged.
3. `media-source.ts`: a resolution failure answers **503** with
   `Retry-After: 5`; 404 remains for a resolved source that lacks the key.
   Skip resolution/upstream work and error writes once the client is gone.
4. `scripts/native-server.mjs`: `uncaughtException` and `unhandledRejection`
   log a redacted, structured error and run the existing idempotent `stop(1)`
   (already bounded by the forced-exit timer), so the supervisor restarts a
   clean process. `index.ts` direct entry: the same handlers plus SIGINT and
   SIGTERM call `close()`.

## Out of scope

Server timeouts, transcode kill escalation, supervisor retry budget, log
rotation, pointer-server atomicity, CI changes (findings 6–14 of the scan).

## Validation

`npm run typecheck && npm test && npm run lint && npm run format:check` in
`addon/`, with new tests for quarantine, serialized writes, and 503 mapping.
