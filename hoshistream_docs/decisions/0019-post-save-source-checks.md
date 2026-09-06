# 0019 - Bounded post-save source checks

Status: accepted (2026-09-06).

## Context

Search success and a saved library record do not establish that torrent metadata,
video data, or a browser-compatible stream are available. The owner requested
comprehensive search/add hardening and explicitly chose automatic metadata
inspection plus a bounded playback check after saving, with a per-add opt-out.

## Decision

Keep saving and checking as separate operations. The interactive Add flows start
a source check by default after a successful new save; the owner can opt out.
Existing API clients can still save without checking. A failed check never
deletes the entry, repeats its creation, or silently changes the selected file.

Persist check progress/results with a source-definition revision and job ID.
Expose queued, inspecting, probing, complete, failed, cancelled and interrupted
states. Coalesce matching active requests, reject conflicting active options,
bound the queue, and run one check at a time. Source edits invalidate results;
late checks cannot overwrite a changed entry. Restart marks unfinished work
interrupted without automatically contacting providers or peers.

Use existing TorrServer endpoints and the bundled ffprobe. A check has a
60-second overall deadline; the probe has a 20-second process limit and bounded
analysis settings. It does not schedule an archive/full download or start
transcoding. TorrServer may prefetch cache pieces beyond the probe's analysis
window: this is not a strict total network-byte cap.

Probe one selected representative file. Report how many selected files exist and
which one was checked. A completed basic check is not a guarantee that all
episodes, every browser, or later swarm conditions will work. Keep player
buffering/decoding state separate and provide codec-aware recovery guidance.

Prefer validated torrent metadata when the provider supplies a trustworthy file.
Preserve safe supported discovery information rather than reducing every source
to a bare hash. A same-hash magnet fallback must be explicit; content mismatch,
private-source violations, unsafe targets and cancellation are not fallback
conditions.

## Consequences

New additions produce actionable availability feedback instead of a premature
ready-to-play claim. This adds no database, engine replacement, dependency,
challenge bypass or new transcoding feature. The existing library, source
selection, optional repair, and native-player paths remain in place.
