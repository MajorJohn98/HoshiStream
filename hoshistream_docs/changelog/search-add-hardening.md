# Search and add hardening

Date: 2026-09-06

The search/add pipeline now separates source retrieval, durable saving, metadata
inspection, a bounded video probe and actual player buffering/decoding.

## Source reliability

Provider resolution prefers usable torrent metadata and preserves safe discovery
hints. Explicit same-hash fallback warnings explain when peer metadata discovery
is still required. Blocked access, cancellation, invalid metadata, hash mismatch,
and missing peers are not treated as interchangeable empty results.

TorrServer errors now have sanitized codes, metadata polling has a real deadline,
and cancelled requests do not start or replay mutations. Cached stream resolution
only re-registers a source on a verified not-found response, not every network
failure. Request logs no longer emit arbitrary exception text.

## Saving and checking

Interactive Add defaults to **Inspect and check after saving**, with a per-add
opt-out. The check runs separately from creation, so failures preserve the entry
and a lost response does not cause another Add. Progress and final results are
persisted; retry and cancellation operate on the check, not on library creation.

Checks are serialized and queued within bounds. Source-definition and job-ID
guards prevent stale results from changing a newer source. Interrupted work is
marked on restart without automatic network activity.

The video probe is time-limited and restricted to media formats/protocols, with
no page scripts or playlist traversal. It examines one selected file and reports
browser support conservatively. Actual playback may still buffer or fail later.
TorrServer cache prefetch is separate from the probe's analysis-data limit.

Manual additions use retry receipts, reusable upload results, real server-returned
paths and non-clobbering publication. Retrying or cancelling an upload must not
delete an existing file. Source-check state is server-owned and is not part of an
ordinary create/patch/import payload.

Partial folder uploads retain their batch and successful per-file results for
retry. Invalid upload responses no longer produce guessed `/data/media` paths.
Lost save responses reuse the original request rather than upload another copy.

Check-status polling reports connection failures with bounded retries and a
read-only refresh action. Late responses cannot update a different entry, and
library badges continue updating after the Add dialog is closed.

The native supervisor keeps signal handlers installed during shutdown so repeated
terminal/watch signals cannot bypass asynchronous child cleanup.

See [the hardening plan](../plans/2026-09-06-search-add-hardening.md) and
[ADR 0019](../decisions/0019-post-save-source-checks.md).

## Readiness follow-up

The readiness contract now distinguishes file metadata, decoded sample evidence
and browser support. Empty metadata and header-only video no longer establish a
readable sample; timeouts are inconclusive rather than unplayable-source claims.
Automatic checks stay bounded and an explicit longer retry is available.

Technical analysis shares the source-check coordinator. Successful observations
are stored atomically with source/file/job identity, so late work cannot certify
an edited source or another episode. Legacy verdicts remain historical, and
network speed is advisory rather than a permanent compatibility grade.

Management and Chrome companion labels expose the observed evidence. Browser
startup no longer changes formats merely because metadata is slow, and autoplay,
buffering, actual playback, and fatal player errors are distinct.

See [ADR 0023](../decisions/0023-file-scoped-readiness-evidence.md).
