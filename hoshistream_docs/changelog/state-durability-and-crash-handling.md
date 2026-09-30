# State durability and crash handling

Plan: [2026-09-27-state-durability-and-failure-handling-plan.md](../plans/2026-09-27-state-durability-and-failure-handling-plan.md)

## Fixed

- **Tags no longer reset on a bad file.** A malformed `tags.json` used to be
  silently replaced by the default genre list. It is now moved aside as
  `tags.json.corrupt-<time>` before defaults are seeded, and an unreadable
  (not missing) file is never overwritten.
- **Overlapping saves keep every change.** Add-on identity, device names, and
  metadata settings now serialize their writes; previously two requests at once
  could drop one update or fail on a shared `.tmp` file.
- **State survives power loss.** Every JSON store (library, volumes, tags,
  identity, device names, metadata settings, onboarding, disk schedule and
  cleanup, pointer state) writes through one helper that `fsync`s the file and
  its directory around the rename.
- **Transient TorrServer failures are retryable.** The stable `/media/...`
  playback route answers `503` with `Retry-After: 5` when the torrent source
  cannot be resolved, instead of a permanent-looking `404`. It also stops
  writing error responses to clients that already disconnected.
- **Stray exceptions shut down cleanly.** The native supervisor script and the
  direct `npm start` entry handle `uncaughtException` and `unhandledRejection`
  by logging a redacted `uncaught_exception` / `unhandled_rejection` event and
  running the normal shutdown, so TorrServer and mpv release their ports and
  the menu-bar app restarts a fresh process. The direct entry also closes
  cleanly on SIGINT/SIGTERM.

- **Quitting no longer races the shutdown.** TorrServer runs with
  `--dontkill`, so it ignored the supervisor's SIGTERM and every stop waited
  5 s for a SIGKILL — skipping TorrServer's own database close — while the
  macOS app gave the whole shutdown only 7 s before killing Node. A slow quit
  therefore left a stale `runtime.lock` and TorrServer running on its
  port for a few more seconds. The supervisor now stops TorrServer through its
  `GET /shutdown` route (clean DB close, exit 0; SIGKILL only after 4 s), and
  the macOS app waits 12 s, longer than the supervisor's own 10 s forced
  exit. Shutdown dropped from ~5 s to well under 1 s in the native smoke test.

## Internals

- New `addon/src/json-file.ts`: `writeJsonFile` (unique temp, `fsync`, rename,
  directory `fsync`; skipped on Windows; writes to one path run one at a time
  in call order, because Windows rejects two renames racing onto one file
  with `EPERM`) and `readJsonFile` (missing →
  `undefined`, malformed/invalid → quarantined, other I/O errors rethrown).
- Tests: `json-file.test.ts`, store failure cases in `tags`, `device-names`,
  `board-rows` (identity) and `metadata-enrichment` (settings), 503/404 in
  `media-source`, and spawned direct-run crash/signal tests in `shutdown`.
