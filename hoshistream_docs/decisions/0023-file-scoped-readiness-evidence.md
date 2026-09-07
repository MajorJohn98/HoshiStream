# 0023 - File-scoped readiness evidence

Status: accepted (2026-09-07).

Supersedes the result interpretation and basic-only check contract in
[ADR 0019](0019-post-save-source-checks.md). Saving remains separate from checks;
the queue, privacy, manual-import and no-automatic-restart decisions remain.

## Context

Torrent metadata, host-side media parsing, browser decoding, and sustained
playback are different observations. The earlier probe could identify a codec
from a header without reading a video frame. Legacy library analysis and newer
source checks used different time budgets and classifications. A representative
file's entry-wide verdict could also affect unrelated episodes.

## Decision

- Keep job lifecycle separate from attempt outcome. Bounded timeouts and
  insufficient sample evidence are inconclusive, not proof of an invalid source.
- Require a decoded video frame before recording that the limited sample was
  readable. Preserve richer codec metadata as support hints, not guarantees.
- Scope successful observations to source revision, file identity and job ID,
  with an observation timestamp. Commit them atomically with the guarded check
  result. Do not reuse one episode's evidence for another.
- Route technical analysis through one bounded, cancellable coordinator.
  Cancellation must drain active work before the execution slot is reused.
- Keep automatic checks bounded to 60 seconds. Permit an explicit longer retry
  bounded to 180 seconds, without automatic escalation.
- Preserve legacy JSON records as historical information. No destructive
  migration, automatic library-wide recheck, or new network activity on restart.
- Separate browser support, native-player advice and network measurements.
  Host Internet download speed does not decide source viability.
- Keep actual browser waiting, autoplay, playback and failure states distinct.
  Slow startup alone is not a reason to change quality.

## Consequences

A successful check reports only the observed file/sample and its time. It does
not guarantee complete media, all episodes, future swarm availability, sustained
throughput, or support in every browser. Stremio/native playback can succeed when
browser support is limited.

This uses existing bundled tooling and verified TorrServer endpoints. It adds no
transcoding capability, torrent discovery, database, dependency, or full download.
Existing opt-in repair stays available using matching file evidence or the
existing explicit override.
