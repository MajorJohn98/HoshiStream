# Closed beta support

**Release and support owner: MajorJohn98.**
The selected single reporting channel is the intended private repository
`MajorJohn98/HoshiStream-beta-feedback`. It could not be resolved with the
current GitHub account on 2026-09-07; the owner chose to defer its creation.
**The channel is not operational and invitations remain blocked.** Do not post
reports to a public repository or fall back to unsolicited email.

The initial cohort is 5-10 technically comfortable Apple Silicon Mac users,
macOS 13.5+, trusted home LAN, one direct-play stream, browser-first H.264/AAC
MP4. Exact browser and Nuvio/Stremio versions must first pass the
[acceptance record](closed-beta-acceptance.md). Windows, Chrome companion rollout,
remote access, advanced storage and broader codecs keep their separate gates.

## Before the first invitation

MajorJohn98 owns the go/no-go decision, artifact identity/checksum, access
control, incident triage and compatibility notes. Create/provision the selected
repository privately only with owner authorization. Confirm its visibility,
enable Issues, and limit access to the owner and explicitly invited testers.
Verify report access with an intended recipient; GitHub issue visibility is
repository-wide, not reporter-only. Never place credentials or raw diagnostics
there even though it is private.

Copy the report template below into that repository's issue form/template.
Keep technical documentation and sanitized implementation fixes in the main
code repository; only publish an incident summary after manual review. No
telemetry, accounts feature or reporting backend is required.

Do not invite anyone until redistribution materials, current-artifact recipient
acceptance, deployed pointer/client behavior, recovery/upgrade acceptance and
this support-channel gate are all satisfied. Retain the prior approved artifact
and its explicitly documented compatibility limits. A locally generated DMG is
not authorization to share it.

## Copyable private report template

Use one report per failure, with a neutral title that contains no media title,
user name, private URL or magnet. Supply only what is needed to reproduce:

```text
Build ID and package version (About HoshiStream):
Mac model/architecture and macOS version:
Browser/player name, exact version, client device and OS:
Installation/update path (no personal filesystem paths):
Source type: linked file / linked folder / upload / magnet / .torrent
Authorized synthetic/repro fixture alias (no URI, hash or private title):
Network: trusted LAN; host / separate LAN device; Ethernet / Wi-Fi
Pointer: unused / direct LAN / enabled; state label only
Steps to reproduce:
Expected result:
Actual result and frequency:
Approximate time and time zone:
Sanitized error/event text (minimal excerpt, no raw log attachment):
Diagnostics bundle (System → Status → Copy diagnostics, pasted after review):
Impact: setup / playback / upgrade / data loss / exposure
Last working build, if known:
Assistance required and workaround, if any:
```

Do not attach `.env`, headers, tokens, private URLs, magnets, `.torrent` files,
whole libraries/backups, raw logs, HAR captures or browser storage. The
**Copy diagnostics** bundle is the one log-derived artifact that is allowed:
it is redacted on the server (see
[troubleshooting](troubleshooting.md#ask-for-help-with-a-diagnostics-bundle))
and carries library counts, not titles. Screenshots
must omit address bars, media titles/paths, device names and credentials.
Replace sensitive substrings with `[redacted]` locally before submission and
inspect the entire excerpt; automatic logging redaction is not sufficient.
Do not request a tester's media when a synthetic/authorized fixture can reproduce
the problem.

## Triage and stop conditions

The owner reviews incoming reports before the next invitation or candidate
promotion. This is assisted, best-effort support, not a 24-hour service or a
promised response-time SLA. If the owner is unavailable, pause rollout rather
than leave new testers unsupported.

| Priority                                                                                   | Owner response                                                                                                                                                                                                                         |
| ------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Suspected data loss or unintended exposure                                                 | Stop distribution/expansion immediately; advise the affected tester to quit and preserve stopped state privately. Do not ask for the state itself. Establish affected builds before any restart, credential change or rollback advice. |
| Broken pointer enrollment, failed update/restore or repeatable advertised playback failure | Hold the candidate and further invitations; record a minimal reproduction and previous working build. Offer only a documented direct-LAN/workload workaround, not a waived gate.                                                       |
| Non-blocking usability/problem outside advertised scope                                    | Record scope and workaround; do not silently expand supported configurations or promise a deadline.                                                                                                                                    |

For accidental credential disclosure, stop the affected service, remove access
to the exposed report/attachment and notify the owner through the provisioned
private channel. Deletion alone cannot revoke a copied credential. Coordinate
deliberate pointer removal/claim recovery and client-URL replacement; never
silently rotate the push secret or claim old URLs remain safe.

Resume only after the owner records the cause, affected builds, corrective
candidate, relevant repeated acceptance outcomes and data compatibility. If an
accepted fix is unavailable, keep the hold. Preserve only minimal sanitized
incident evidence; the owner reviews closed reports before expanding the cohort
and removes unnecessary personal information. No indefinite raw-data archive.

## Voluntary success record and expansion

Ask for a short opt-in check-in after first playback, a later return session,
and the first update. Record a tester-chosen alias, build, first-playback result,
whether instructions needed assistance, return-session result, recurring
failure category and update/credential/library preservation. Mark unanswered
items **unknown**, not passed; do not collect viewing histories, media titles,
IP addresses, device identifiers or automatic usage events.

Expansion requires a documented owner decision after the initial cohort has
completed those milestones without unresolved advertised-path blockers.
Evaluate assistance reports against the instructions and fix recurring setup
problems first. Missing responses are not success evidence: gather voluntary
evidence or keep expansion on hold rather than infer adoption.

See [the release gates](../plans/2026-09-07-closed-beta-readiness-plan.md),
[privacy](privacy-and-network.md) and
[backup/recovery](backup-restore-updates.md).
