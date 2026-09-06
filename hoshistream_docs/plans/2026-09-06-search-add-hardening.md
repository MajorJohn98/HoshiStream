# Search and add reliability hardening

Date: 2026-09-06
Status: implemented.

## Approved behavior

The owner requested comprehensive hardening and selected automatic metadata
inspection plus a bounded playback check after saving, with a per-add opt-out.
Checks may contact peers and read video data, but must not launch a full download
or transcoding. Failed checks retain the saved entry and offer recovery.

## Work

1. Prefer validated torrent metadata over reconstructed magnets when a trustworthy
   torrent URL is available. Preserve supported safe discovery hints; never hide
   hash mismatches, private-source violations, cancellation, or blocked access.
   Explicitly report any same-hash magnet fallback.
2. Add bounded, cancellable source checks with persisted progress and outcomes:
   queued, inspecting, probing, complete, failed, cancelled, interrupted.
   A completed basic check is not a promise that every player or future swarm
   connection will work. Expose codec limitations separately from source errors.
3. Guard late inspection/probe results against source edits, coalesce duplicate
   check requests, bound queues and probing, and mark interrupted work honestly
   after restart rather than silently resuming network activity.
4. Make manual Add retry-safe, retain upload results across retries, validate
   external input without breaking existing library files, and separate saved
   state from follow-up check failures.
5. Reuse the same check/retry/cancel UI for search imports, manual additions and
   entry details. Preserve the existing design, selection choices and opt-in
   repair/native-player paths. Improve blocked, timeout, format, empty, and
   partial-result messages rather than adding challenge bypasses.
6. Cover provider resolution, metadata integrity, lifecycle/concurrency,
   persistence, upload/retry, UI state and browser compatibility with existing
   tests and isolated authorized/synthetic fixtures. Run repository checks and
   restore the user's visible development server.

## Boundaries

No engine replacement, database, additional index sites, browser runtime,
challenge-solving service, new transcoding feature, or new dependency.
New TorrServer endpoints require pinned source/Swagger confirmation. Its running
Swagger currently exposes upload and torrent actions, not a documented raw
metadata export endpoint; do not invent one.

Prefer surgical changes to the existing provider, library, inspection and player
surfaces. Do not change or delete the user's chosen sources during recovery.
