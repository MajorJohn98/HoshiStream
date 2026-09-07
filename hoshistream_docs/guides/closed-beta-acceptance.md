# Closed-beta candidate acceptance

This runbook implements phase 6 of the [closed-beta plan](../plans/2026-09-07-closed-beta-readiness-plan.md).
**Repository checks and an isolated local smoke are not recipient acceptance,
release approval, or a production-readiness claim.** Sharing and invitations
remain blocked until the applicable distribution, client, recovery, pointer
and support gates pass. A `LOCAL-ONLY` image must never be shared.

## Scope and evidence rules

- Apple Silicon, macOS 13.5+, trusted home LAN, one direct-play stream.
  Baseline media: H.264/AAC MP4. Record exact browsers and Nuvio/Stremio versions;
  “current browser” or an unspecified client is not a tested matrix.
- Use fresh disposable acceptance state and explicitly authorized media. Never
  reuse a person's private library or live `.env`, register media silently, or
  trigger a torrent/media download as part of automated smoke.
- Media scenarios below require a separate, explicit human decision to use a
  legal fixture, disclose possible peer traffic, and authorize any download.
  Until then mark them **BLOCKED**, not passed from source checks.
- No automatic telemetry, discovery, scraping, public exposure, transcoding,
  or benchmark guarantees. Do not infer remote playback from pointer success.
- Share only the allowlisted record below. Never attach `.env`, control files,
  raw logs, bearer headers, private install/stream URLs, full magnets, private
  library exports, or screenshots containing them. Use invented fixture labels.

Use **PASS** only for the exact observed scenario on the named candidate and
device; **FAIL** for an executed check that misses its criterion; **BLOCKED**
for a missing prerequisite; **NOT RUN** for available work not executed; and
**OUT OF SCOPE** only for explicitly excluded functionality. Partial evidence
does not pass a whole row. Date each observation. Rebuilding creates a new
candidate, even from the same revision; retain previous results but do not
transfer their acceptance automatically.

## Candidate preparation and isolated no-media smoke

Before work, name the operator, release/support owner and private evidence
destination. Review [distribution](distributing-macos-app.md),
[privacy/network](privacy-and-network.md), and
[backup/restore](backup-restore-updates.md). Pause on missing approved materials;
only a local validation image may be built while redistribution is blocked.

Implementation sequence: harden the existing smoke's isolation, candidate
binding and safe output; run its targeted tests; build a fresh isolated app and
local-only image; execute both shutdown paths; record facts and outstanding
human gates separately. Do not replace the installed app or existing
`build/HoshiStream.app`.

From the repository root, after existing pinned prerequisites are available:

```bash
export HOSHISTREAM_BUILD_DIR="$PWD/build/phase-5-7-validation"
unset HOSHISTREAM_PROJECT_ROOT
./packaging/build-macos-app.sh
./packaging/build-macos-dmg.sh --stage-only
RUNTIME="$HOSHISTREAM_BUILD_DIR/HoshiStream.app/Contents/Resources/runtime"
node packaging/macos-contract.mjs verify "$HOSHISTREAM_BUILD_DIR/HoshiStream.app"
/usr/bin/env PATH=/usr/bin:/bin:/usr/sbin:/sbin \
  "$RUNTIME/bin/node" scripts/smoke-native.mjs \
  --runtime-root="$RUNTIME" \
  --state-parent="$HOSHISTREAM_BUILD_DIR/smoke-state"
/usr/bin/env PATH=/usr/bin:/bin:/usr/sbin:/sbin \
  "$RUNTIME/bin/node" scripts/smoke-native.mjs \
  --runtime-root="$RUNTIME" \
  --state-parent="$HOSHISTREAM_BUILD_DIR/smoke-state" --control-stop
```

Use a new dedicated build directory if this one already contains evidence
needing preservation. Never overwrite a prior DMG. The build performs existing
compile, pinned-tool, signature and payload checks; missing tools are a blocker,
not permission to substitute a PATH-installed runtime or relax the pins.

The harness uses the candidate's Node, runtime/control helpers and stamped
release metadata, not checkout control code. It rejects source mode for a
packaged run. Disposable state lives outside the signed bundle under the
explicit state parent (default: `build/native-smoke`), with a generated token,
empty library, separate ports, DHT/PEX/mDNS disabled, and no inherited developer
credentials or player paths. It checks readiness, both shutdown methods
(separate runs), ownership release, TCP port release and state cleanup. It
prints only a structured summary; raw child output is withheld even on failure.
Retained failure state stays private for local inspection, not attachment to a
support report. Do not delete retained state until its owned processes stop.

This is **not an offline/network-sandbox test**: TorrServer still binds its
administration listener on the trusted LAN, and ordinary startup may contact
Cloudflare for speed measurement. No media is registered or downloaded by this
procedure. A runtime-child test does not open the native menu UI, exercise
Gatekeeper/firewall prompts, or establish absence of every OS-level resource
leak. Timing is a single local observation, not a performance promise.

Retain the app's payload inventory, release metadata, DMG checksum and sanitized
smoke summaries under the candidate directory. Independently verify the DMG
checksum with `shasum -a 256 -c <exact-name>.dmg.sha256` from that directory.
If checking a mounted image, mount read-only at a dedicated directory beneath
the validation folder, verify its app inventory/signature, local-only notice,
release identity, executable bits and Applications link, then detach that
specific mount. Do not launch/copy into Applications during local validation.

## Phase 6 scenario procedure and pass criteria

### 1. Clean recipient Mac

**Prerequisites:** approved distributable/checksum, real Apple Silicon recipient
Mac with no developer tools or hidden player dependency, disposable recipient
account/state, named assisted installer if using ad-hoc signing.

1. Follow the install guide from the downloaded image, checking its checksum.
   Record copy-to-Applications, quarantine/Gatekeeper and firewall outcomes;
   never disable system protections or bypass organization policy.
2. Launch the installed copy. Confirm a menu-bar app, first-run guidance, an
   empty library, recipient-owned private state, unique credentials generated
   without asking the operator to paste secrets, and no torrent registration.
3. Compare About and Status build/version with the DMG's release metadata.
   Skip then resume onboarding and confirm documented browser prerequisites.

**Pass:** installation and first-run instructions work without unstated tools.
Record assistance and exact macOS build. A developer-host smoke is partial
startup evidence only, not this pass. macOS 13.5 minimum and newer versions need
their own observations before being described as accepted.

### 2. Manual adding

**Prerequisites:** separately authorized local MP4, magnet, and `.torrent`
fixtures, including one movie and a multi-file series; disposable state.

1. Add a local file through actual Add Media interaction. Cancel once, save,
   reload, and verify the entry without moving/deleting its linked original.
2. With explicit consent for torrent traffic, review and save the magnet and
   `.torrent` fixtures manually. Confirm expected selected files and source type.
3. Repeat a save/import and retry an interrupted/failed operation. Try a
   deliberately malformed fixture and an unavailable source. Record visible
   error, retry action, duplicate behavior, and whether a partial entry remains.

**Pass:** all three paths persist the intended entry after restart; duplicate,
cancel, invalid-source and retry outcomes are understandable and non-destructive.
Metadata or sampled readiness must not be presented as full-file playback proof.
Do not record the actual magnet or private file paths in shared evidence.

### 3. Movie and series playback

**Prerequisites:** scenario 2 media consent, compatible direct-play fixtures,
host browser and actual LAN Nuvio/Stremio devices; one active stream at a time.

1. In the installed host's browser, play the movie; pause, resume, seek forward
   and backward, and resume again. Record first-frame and seek observations,
   audio/video synchronization, interruptions and whether repair was disabled.
2. Repeat on each advertised Nuvio and Stremio device/version after installing
   the private add-on using the documented procedure; never capture its URL.
3. For the series, choose two distinct episode files, verify the right episode
   plays and file-scoped readiness does not leak between episodes. Repeat the
   pause/seek/resume operations on advertised playback paths.
4. For each host/client path, predeclare and record a representative sustained
   duration (suggested minimum: 30 minutes, or the full authorized shorter
   fixture with its length recorded). Do not count a preview/sample as a session.

**Pass:** each declared movie/series/client row completes its operations and
duration without repeatable advertised-playback failures. Specify any codec or
client exclusion rather than silently dropping a failing row. No sustained
browser/player session was performed by the automated smoke.

### 4. Lifecycle

1. Run both isolated packaged shutdown modes above. Repeat startup after the
   previous run. Record exit status, ownership/TCP release and state cleanup.
2. On the actual installed candidate with disposable persistent state, quit
   from the menu, confirm only its owned process tree/listeners disappear,
   relaunch, and verify the saved library and settings persist.
3. Pause a session, sleep/wake the recipient Mac and resume. Record whether
   reload/retry is needed and whether documented recovery succeeds.
4. Change the host's LAN address on the same trusted network. Check direct
   client reconnection and updated LAN URL; follow explicit manual pointer
   updates if opted in. Do not change a live shared network for an unattended test.

**Pass:** quit/restart leave no owned orphan or occupied listener, data survives,
and sleep/network-change recovery matches instructions. Runtime TCP checks
alone do not establish native-menu, UDP, sleep/wake or persistent-state behavior.

### 5. Installed pointer

**Prerequisites:** approved deployed service, two independent disposable
recipient installs, explicit participation, and an operator authorized to
remove only these test claims. No service deployment is part of this runbook.

1. Confirm pointer starts disabled, direct LAN connection works, and saving a
   selected endpoint neither publishes an address nor silently contacts it.
2. Configure the documented service from each installed candidate without
   copying developer secrets. Explicitly check/connect/update; verify distinct
   recipients resolve only to their own addresses.
3. Restart/reconfigure and confirm credentials persist without rotation.
   Simulate reachable-service failure and stale address, then correct the
   configuration and manually retry. Observe honest status and LAN fallback.
4. Change a test recipient's address, explicitly push the update, verify only
   that tenant changes, then deliberately disable/remove its claim and confirm
   persistence/re-enrollment behavior matches the pointer guide.
5. Use operator-approved expired-record and wrong-credential cases belonging
   only to the disposable test recipients. Confirm distinct disabled, expired,
   unreachable and authentication-failed messages; a lost credential requires
   deliberate recovery, not silent rotation. Do not interrupt a shared service
   or alter another recipient's claim to manufacture an error.
6. On the declared clients, follow the resulting manifest, catalog and stream
   flow; record HTTPS-to-HTTP LAN redirect rejection where applicable and use
   the documented direct LAN fallback. Preserve a user-supplied endpoint when
   checking setup/restart; compare menu and management UI behavior.

**Pass:** the [phase 2 contract](../plans/2026-09-07-closed-beta-readiness-plan.md)
works from the installed artifact against the selected deployment, including
isolation, non-rotating credentials, explicit removal and manual updates.
Local fixture tests are separate evidence, never deployed-service acceptance.
Record only invented recipient labels and sanitized outcomes, not credentials,
private URLs, public addresses or raw service responses.

### 6. Data lifecycle

**Prerequisites:** approved predecessor/candidate pair and explicit format
compatibility decision, stopped disposable representative state, separate safe
copies of linked originals and managed media. Follow the
[backup, restore and update guide](backup-restore-updates.md), not an improvised
`.bak` or browser-export-only recovery.

1. Record resolved state/config/managed-media locations privately. Make a
   stopped full backup and a non-secret inventory (counts and fixture labels).
2. Upgrade using the approved pair; verify library, tags/settings, managed
   `.torrent` files/media, credentials (compare privately), and linked originals.
3. Exercise stopped restore at the documented paths; verify the same inventory.
   Test corrupt-library recovery only in a disposable copy, then verify saved
   backup behavior and clear recovery messaging.
4. Quit and remove only the disposable installed app, checking preserved state
   and linked originals; reinstall/restore as documented. Distinguish uninstall
   from a separately authorized permanent data deletion.

**Pass:** every promised item survives and the approved recovery path works.
An older published DMG is not automatically a compatible rollback target.
Unit fixtures can support this row but cannot pass a real cross-version
installed upgrade. Do not perform a production upgrade or delete real data.

### 7. Bounded workload

1. Use the same authorized single-stream direct-play session and record host
   hardware/RAM, network type, resolution/codec/bitrate, storage class and whether
   linked local or torrent-backed. No repair, concurrency or remote streaming.
2. With existing Activity Monitor/system tools, observe candidate-owned Node,
   TorrServer and native app CPU/RSS, disk/cache growth and errors at idle,
   startup, representative playback intervals, seeks and stopped playback.
3. Record startup, first-frame and seek timings, stalls and whether resources
   return to a reasonable idle state. Compare disk cache with the configured
   bounded cache policy; do not present that disk limit as a total-RAM guarantee.

**Pass:** the published single-stream expectations hold without exhaustion,
unbounded growth or repeatable playback failure over the declared interval.
If no numerical CPU/RAM/startup budget is published, record observations and
have the owner define an acceptance budget before making such a claim.
An empty-stack startup timing is not a streaming benchmark.

### 8. Browser usability

**Prerequisites:** a human using the exact installed candidate in the named
browser. Existing browser interaction tools may assist; do not add an automation
runtime or use DOM/source assertions as a substitute for interaction.

1. Follow getting-started from empty state without developer explanation. Skip
   and resume onboarding; open Add Media, cancel, add a fixture, and connect a
   client. Record any undocumented step or assistance.
2. Use keyboard navigation and the target window size through dialogs, save,
   retry and playback. Confirm focus, labels and progress/failure messages are
   usable, with actionable recovery for invalid input and unavailable source.
3. Reload/reopen after saved data and failure states, retry deliberately, and
   verify there is no accidental duplicate action or lost accepted save.
4. Reach first playback and return for another session. Record observed user
   actions and outcomes; redact screenshots locally before sharing.

**Pass:** core instructions and failure/retry paths work through actual human
interaction on the supported browser matrix. First playback and sustained
playback retain their separate evidence requirements.

## Evidence template

Copy into the agreed private evidence destination, not a public issue. One
candidate header may cover many rows; every new artifact needs a new header.

```text
Record date/time (UTC):
Operator / release owner / private evidence reference:
Scope: LOCAL VALIDATION ONLY | approved recipient acceptance
Version / build ID / build number / builtAt:
Full Git revision / dirty true|false (as stamped, not today's checkout):
DMG exact filename / SHA-256:
Payload inventory filename / SHA-256:
Smoke harness revision or SHA-256 (harness is not bundled):
OS version + build / architecture / device model / RAM:
Candidate Node / TorrServer / FFmpeg / ffprobe versions:
Browser name + exact version:
LAN client / device / OS / exact Nuvio or Stremio version:
Network type / storage type / fixture alias and authorized source type:
Media consent + sustained duration (no private paths, magnets or URLs):
Scenario ID / steps executed:
Outcome: PASS | FAIL | BLOCKED | NOT RUN | OUT OF SCOPE
Observed behavior / sanitized error category:
Startup / first-frame / seek / playback duration / CPU/RSS/cache observations:
Assistance / deviation from instructions:
Evidence filenames (sanitized only):
Known limits / missing prerequisite / owner + next action:
Retest build and outcome (new row; do not overwrite an earlier failure):
```

## Available local candidate evidence — 2026-09-07

**Disposition: local validation only; not approved for sharing or invitations.**
The agent ran the existing build and checks on the available developer Mac.
No recipient installation, real browser interaction, playback, media import or
deployed pointer enrollment was performed. No installed app, existing
`build/HoshiStream.app`, live state or approved release was replaced.

### Exact artifact and environment

| Field                                    | Observed value                                                                                 |
| ---------------------------------------- | ---------------------------------------------------------------------------------------------- |
| Version / build ID                       | `0.14.0` / `0.14.0-7493bc90360a-dirty-20260907162959559-015b5b2d`                              |
| Source revision / dirty                  | `7493bc90360a8dc49cf52576a18cdcff62cc1e7f` / `true`                                            |
| Build number / builtAt                   | `2981.33.9` / `2026-09-07T16:29:59.559Z`                                                       |
| Candidate directory                      | `build/phase-5-7-validation`                                                                   |
| DMG                                      | `HoshiStream-0.14.0-7493bc90360a-dirty-20260907162959559-015b5b2d-darwin-arm64-LOCAL-ONLY.dmg` |
| DMG SHA-256                              | `ac6b4889def0be402bc97b420292325bc56b3060ced7b8a680932fbac2040e44`                             |
| `HoshiStream.app.payload.json` SHA-256   | `f7304d4a4a7f6ca27fa23e881f1b52dced5a2e6949f975b9d2cb643b355cba87`                             |
| Final `scripts/smoke-native.mjs` SHA-256 | `bf25da35716ec624c48cdde607dda581cd540334f09b4a2df4b1514baa5fa094`                             |
| Host OS / architecture                   | macOS `26.6.2`, build `25G83`, `arm64`                                                         |
| Host model / RAM                         | `MacBookPro17,1`, 16 GiB (`17179869184` bytes)                                                 |
| Source test/build Node                   | `v26.7.0`                                                                                      |
| Candidate runtime Node                   | `v26.3.1`                                                                                      |
| Candidate TorrServer                     | Exact locked `MatriX.141` binary, checked by existing packaging provenance validation          |
| Candidate FFmpeg / ffprobe               | Both reported `9.0.1-https://www.martin-riedl.de` under OS-only PATH                           |
| Signing                                  | Ad-hoc; payload/signature verified, no Developer ID/notarization or recipient Gatekeeper claim |
| Browser / Nuvio / Stremio                | Not exercised; no accepted client-version matrix                                               |
| Media / pointer service                  | Empty disposable library; no media/torrent registrations or test pointer participation         |

The revision is the phases 1–4 checkpoint plus a dirty working tree, not an
immutable released revision. The smoke harness is deliberately outside the
bundle; its final hash identifies the code used for the recorded reruns.
Later documentation/test/harness edits do not change this stamped runtime or
DMG. Rebuild before accepting any changed runtime payload.

### Executed checks — PASS, with narrow meaning

| Check                        | Evidence / observation                                                                                                                                                                                                                                                                           |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Isolated app build           | Existing `build-macos-app.sh` completed with `HOSHISTREAM_BUILD_DIR` set only to the candidate directory; TypeScript/native compilation and pinned payload checks passed. No runtime pin was changed.                                                                                            |
| Local-only DMG               | Existing `build-macos-dmg.sh --stage-only` completed. Independently checking its generated SHA-256 sidecar returned `OK`; normal release/sharing was not attempted.                                                                                                                              |
| Read-only mounted image      | Mounted beneath the validation directory with `-readonly -nobrowse`. `macos-contract.mjs verify` and `codesign --verify --strict` passed; release metadata matched, the local-only notice existed, and Applications was a symlink to `/Applications`. The specific mount was detached afterward. |
| Parent-control smoke         | Final rerun: **754 ms** to ready, **5025 ms** shutdown; exit code 0, empty library, runtime/control ownership removed, add-on/TorrServer/peer/control TCP ports available, generated state removed.                                                                                              |
| Authenticated-control smoke  | Final rerun: **878 ms** to ready, **5064 ms** shutdown; the candidate's capability control acknowledged stop, exit code 0, same ownership/TCP/state checks passed.                                                                                                                               |
| Repetition                   | Both shutdown modes also passed once before the final harness reruns. Fresh disposable state was used each time; persistent-state restart was not tested by these runs.                                                                                                                          |
| Focused automated regression | Existing Vitest command over `smoke-native.test.ts`, `native-runtime.test.ts` and `windows-packaging.test.ts`: **53 tests passed, 3 files**. This includes failure-log withholding and preservation of unverified failure state; Windows fixture checks are not Windows hardware acceptance.     |
| Existing quality checks      | Add-on `npm run typecheck`, `npm run lint`, and `npm run format:check` passed after the smoke changes; existing Prettier formatted/checked the changed harness, test and this guide.                                                                                                             |

Final sanitized smoke records are
`build/phase-5-7-validation/parent-control-smoke.json` and
`build/phase-5-7-validation/authenticated-control-smoke.json`; release/checksum/
payload sidecars sit beside the DMG. These local artifacts are not uploaded.
The smoke-state parent was verified empty. Tests used project-local scratch
storage; no live credentials or libraries were copied.

### Integrated recovery and repository evidence

The full integrated add-on run passed **793 tests**, with two opt-in tests
skipped (TorrServer integration and the packaged-reader pair). Typecheck, lint,
format and build passed. The existing pointer typecheck and **24 fixture tests**
also passed; no pointer deployment or live claims were made.

The packaged-reader test was separately enabled and passed with the other
recovery/smoke tests (**17 tests across two files**). The exact predecessor was
the retained local-only phase 3-4 runtime:
`0.14.0-83f6becb0f5b-dirty-20260907155734975-b0cff1f8`; the successor was the
candidate identified above. Each used its own bundled Node, bootstrap and
compiled Library reader against one disposable original-path state directory.
The published backup/restore shell blocks were executed directly; after restore,
the predecessor reader could reopen its matching snapshot with unchanged
credentials. The same-artifact baseline restore also passed separately.

To repeat this narrow check from the repository root:

```bash
HOSHISTREAM_PREVIOUS_RUNTIME="$PWD/build/phase-3-4-validation/HoshiStream.app/Contents/Resources/runtime" \
HOSHISTREAM_CANDIDATE_RUNTIME="$PWD/build/phase-5-7-validation/HoshiStream.app/Contents/Resources/runtime" \
npm --prefix addon test -- tests/recovery-workflow.test.ts tests/smoke-native.test.ts
```

Fixtures include movie/series records, file-scoped selections, playback position,
tags, dismissed onboarding, private pointer state, managed files and an external
volume marker. Torrent/video/database bytes are synthetic preservation fixtures,
not playable media or a real TorrServer database, and are never submitted to
TorrServer. App-only uninstall/reinstall is a directory-move fixture, not a real
Finder installation. This establishes copy/restore and packaged reader evidence,
**not** full server startup over restored torrent state, installed cross-version
upgrade, real storage-device recovery or arbitrary older-version compatibility.
Those recipient acceptance gates remain open.

### Outstanding phase 6 acceptance — BLOCKED, not passed

| Scenario                     | Blocker / next evidence required                                                                                                                                                                                                                  |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Clean recipient Mac          | No actual recipient Mac or approved distributable. Owner must first clear redistribution, then observe installed first run, firewall/Gatekeeper and assistance on the declared OS scope, including the minimum supported version.                 |
| Manual adding                | No authorized media fixtures were registered. Obtain explicit media/download consent and run all three manual import paths, duplicates and failure/retry steps on disposable state.                                                               |
| Movie and series playback    | No real browser or LAN Nuvio/Stremio session; exact clients and sustained durations absent. Run the per-client/movie/episode matrix with authorized fixtures.                                                                                     |
| Lifecycle, complete scenario | Empty packaged runtime startup/quit passed only. Native menu quit, persistent-state restart, owned UDP/process-tree observation, sleep/wake and LAN address-change recovery still need actual installed-device work.                              |
| Installed pointer            | No two-recipient installed test against the approved deployed service. Local source/fixture evidence does not satisfy tenant isolation, enrollment, removal or manual address-update acceptance.                                                  |
| Data lifecycle               | Installed predecessor-to-candidate upgrade/restore/uninstall remains untested. The local packaged-reader and synthetic copy/restore evidence above does not replace recipient acceptance or a compatibility decision for a published predecessor. |
| Bounded workload             | Empty-stack timings are observations only. No streaming CPU/RSS, disk/cache, first-frame, seek or sustained-load measurements; run the declared single-stream budget check.                                                                       |
| Browser usability            | No human install-to-playback, keyboard/dialog, retry or return-session observation on a named browser. Follow the interaction checklist with the actual installed candidate.                                                                      |

Separate release blockers remain the exact third-party redistribution materials
and their review, plus owner-verified private support-channel readiness. A local
ad-hoc signature is not a frictionless installation claim. Minimum source Node
22.18, macOS 13.5, Windows/Intel, repair, remote access, advanced storage and
broader codecs/concurrency were not accepted here. Keep the narrow passed
checks and these blocked gates visible together; do not label phase 6 complete
or promote this local-only artifact.
