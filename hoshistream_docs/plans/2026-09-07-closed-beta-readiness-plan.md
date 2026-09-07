# Closed beta readiness

Date: 2026-09-07
Status: phase 1-4 code/documentation implemented; phase 3 redistribution exit remains blocked; phases 5-7, deployed-service and recipient acceptance remain outstanding

## Deferred blocker register (2026-09-07)

The user chose to record these blockers and revisit them later. Resolution work
is paused; **deferred does not mean resolved or waived**. No target date is set.
The existing redistribution gate and beta invitation/publication holds remain
in place. Resume the relevant work only when requested.

| Blocker | Status / phase | What is needed when revisited |
|---|---|---|
| Exact FFmpeg/x264 source inputs | Deferred; phase 3 release blocker | Obtain the exact x264 snapshot used in the pinned binaries and a supported binary-to-source mapping. Ask the current provider first; if unavailable, evaluate a source-complete replacement or a build from pinned inputs. |
| Remaining FFmpeg corresponding source | Deferred; phase 3 release blocker | Assemble incorporated dependency sources, notices, patches and controlling build scripts. Resolving x264 alone does not complete this review. |
| TorrServer corresponding source | Deferred; phase 3 release blocker | Complete Go dependency and embedded-web source/license coverage, account for generated files, and establish the actual build inputs and instructions. |
| npm license-notice provenance | Deferred; phase 3 release blocker | Resolve applicable historical notices for `tr46 0.0.3` and `uint8-util 2.3.2`; preserve the remaining package/browser notices. Do not invent missing text or assume a current upstream license applies retrospectively. |
| Recipient, player and deployed pointer acceptance | Deferred; phases 2 and 6 acceptance gates | Exercise the installed candidate on recipient Macs, record exact browser/Nuvio/Stremio versions and sustained playback, and establish independent live pointer registration/update/removal and client routing. |
| Updates, backup, restore and rollback | Deferred; phase 5 release blocker | Establish and exercise the stopped-state backup, restore and upgrade procedures, credential/media preservation, and explicit downgrade compatibility. |
| Cohort support readiness | Deferred; phase 7 invitation blocker | Name the release/support owner, choose a private reporting channel, and establish report requirements, success criteria and stop conditions. |
| Developer ID signing and notarization | Conditional; deferred | May remain deferred for an explicitly assisted technical beta. Required before claiming frictionless self-service installation for nontechnical users. |

Node's exact-archive notice retention has been addressed; it is not an
outstanding missing-notice blocker. The corresponding-source and npm entries
above describe missing materials/evidence, not confirmed playback defects or
automatic findings of infringement. Before distribution, assemble and review
the complete materials and establish the required source-access arrangement;
do not fabricate an attestation to unblock packaging.

The [exact-component review](../guides/distributing-macos-app.md#exact-component-review-findings-2026-09-07)
retains the upstream evidence. Windows and Chrome companion rollout continue
to have their separate conditional gates; neither is added to this first cohort.

## Approved phase 3-4 slice (2026-09-07)

Use **browser-first playback**, with separately installed mpv optional (approved
by the user for this slice); do not
bundle a new player or expand codec support. Implement only phases 3 and 4.

1. Require pinned Node, TorrServer, FFmpeg and ffprobe in the macOS payload;
   retain download provenance and Node notices, and reject missing tools,
   nonportable dependencies and private/developer state.
2. Apply the existing Windows-style reviewed-source gate to macOS without
   weakening Windows. Keep local validation artifacts explicitly separate
   from distributable DMGs; emit checksums and candidate notes, not releases.
3. Replace the README with the three independent quick starts and align the
   linked macOS, development and getting-started guides.
4. Run existing automated checks and isolated packaging/runtime checks. Record
   exact upstream review gaps honestly; do not fabricate an attestation or
   publish before phases 5-7 and the remaining acceptance gates pass.

Implementation evidence:

- The macOS build now requires all four pinned runtime executables, verifies
  fetched archive receipts and retained Node notices, checks arm64 deployment
  targets/system-only libraries and launches analysis tools with an OS-only
  PATH. Production dependencies and portable runtime state remain separate.
- App signatures are finalized before a sidecar inventory records the bytes.
  DMG generation checks identity, inventory, signature and portable plist state.
  It writes SHA-256, identity, payload and concise-notes sidecars and refuses to
  overwrite existing images.
- The normal DMG path requires reviewed macOS redistribution materials bound to
  the packaged lockfiles. The existing Windows gate is preserved. No review
  attestation or source-completeness claim was fabricated. Stage-only images
  are explicitly labeled `LOCAL-ONLY`, both in the name and inside the image.
- README was replaced with installed-app, foreground-source and app-build quick
  starts in that order. Linked guides now distinguish browser playback from the
  optional external-player API, actual state paths and ad-hoc signing.
- An isolated candidate app and local-only image were built under
  `build/phase-3-4-validation`, without replacing the installed app or the
  existing `build/HoshiStream.app`. Build ID:
  `0.14.0-83f6becb0f5b-dirty-20260907155734975-b0cff1f8`.
  The mounted image retained its signed payload and labels; packaged startup
  and controlled shutdown succeeded with disposable state, separate ports and
  no developer PATH or media downloads. The normal DMG command correctly
  blocked on missing reviewed materials. This is not recipient acceptance.
- Add-on typecheck, full tests (777 passed, one opt-in test skipped), lint,
  format and isolated app compilation passed.
  Checks used local Node 26; the packaged runtime is the unchanged v26.3.1 pin.
  Minimum source Node 22.18 and a recipient Mac on macOS 13.5 were not exercised.

**Remaining phase 3 exit:** assemble and review complete corresponding source,
notices and build materials for the exact shipped components. See the
[distribution review findings](../guides/distributing-macos-app.md#exact-component-review-findings-2026-09-07).
The upstream review found an unidentified x264 snapshot in the Riedl FFmpeg
build, incomplete TorrServer dependency/generated-web source coverage, and
missing historical license-notice provenance for `tr46 0.0.3` and
`uint8-util 2.3.2`. These are unresolved evidence/materials, not an assertion
that redistribution is inherently prohibited. Keep publication,
recipient/client acceptance, compatibility/rollback approval and invitations
blocked; this slice does not implement phases 5-7.

## Approved implementation slice (2026-09-07)

Implement phases 1 and 2 only, starting from revision `231ae20`. Keep version
`0.14.0` as the shared package version, and distinguish candidate builds by
revision and working-tree state. The initial contract is Apple Silicon,
macOS 13.5+, a trusted LAN, one direct-play stream, and H.264 video with AAC
audio in MP4 as the baseline browser media. Exact browser, Nuvio and Stremio
versions remain acceptance blockers; this is not a claim of tested support.
Native player bundling remains in phase 3.

The approved suggested pointer endpoint is
`https://hoshistream-pointer.vercel.app`, operated by the owner of the
**Major John's projects** Vercel team. Participation remains explicit,
custom endpoints are preserved, and neither saving setup nor launching the
app contacts the service.

Implementation order:

1. Share package/build identity between the manifest, packaged app, artifact
   names and visible support information.
2. Add private, persistent endpoint setup and manual pointer lifecycle states,
   preserving recipient credentials and making credential recovery explicit.
3. Wire the existing management UI and native menu to the same setup/status
   contract, including direct LAN fallback.
4. Exercise disposable recipient state, existing automated checks and builds;
   document observed results separately from outstanding deployed/client
   acceptance. Do not deploy, publish or modify the developer's live state.

Implementation evidence for this slice:

- Shared version/build identity is wired through the manifest, status API/UI,
  native About dialog, packaged runtime, plist and candidate DMG metadata.
- Installed endpoint setup, manual pointer lifecycle, direct LAN fallback and
  non-rotating credential recovery are implemented. A failed read-only service
  check does not prevent correcting a mistyped endpoint; a possibly created
  claim still requires deliberate removal.
- Add-on typecheck, lint, format and build passed; 759 tests passed, with the
  opt-in TorrServer integration test skipped. Pointer typecheck and 24 tests
  passed, including independent tenant routing/authentication and storage errors.
- An isolated macOS app/DMG was built without replacing the existing app.
  Build ID: `0.14.0-231ae204305f-dirty-20260907152408776-4b8503a4`.
  Its packaged bootstrap/client completed two disposable recipient lifecycles
  against a fixture service with distinct, preserved private credentials and
  no bundled `.env`. This local artifact is not published or release-approved.
- The available bundled runtime reported Node `v26.3.1`; source checks used the
  available local Node 26 runtime. Minimum Node 22.18 compatibility was not
  separately exercised. No runtime pin or dependency was changed in this slice.
- Existing Chrome exercised save, registration, reload, disable/re-enable,
  manual check, removal and ambiguous-404 display against a disposable preview.
  Desktop/mobile layouts and visible release information were checked.

These observations do not establish the final client version matrix,
recipient-Mac installation experience, live service authentication parity,
redistribution rights, or sustained playback. Service-side storage fixes still
require a separate operator deployment. Those acceptance gates remain open.

## Goal and scope

Prepare a small, supported closed beta rather than expand the feature set.
The recommended first cohort is 5-10 technically comfortable Apple Silicon
Mac users, on supported macOS versions, using a trusted home LAN and one
simultaneous direct-play stream.

The core product already includes onboarding, manual imports, retry-safe
additions, file-scoped source checks, playback, atomic library persistence,
recovery, and native lifecycle management. The remaining work is release
packaging, installed-app configuration, real-device acceptance, documentation,
and support.

This document records work to perform; it does not certify an existing
artifact or authorize deployment, publication, credential changes, or broader
feature implementation. Implement one agreed phase at a time.

## Baseline and release blockers

The assessment used local revision `231ae20`. Reconfirm these observations
when implementation starts:

| Area | Current observation | Required outcome and why |
|---|---|---|
| Release identity | `addon/package.json` is `0.14.0`, the add-on manifest advertises `0.8.0`, and the latest published download is a `0.8.2` DMG. | A current, identifiable candidate with consistent version/build information; support must know which code a tester is running. |
| Installed pointer | The reported installer experience leaves pointer functionality disabled because expected Vercel configuration/credentials are absent. Current bootstrap code generates a per-install push secret but leaves the pointer URL unconfigured. | Reproduce the packaged failure and provision the right configuration without copying developer secrets; source behavior alone does not establish installed behavior. |
| macOS host playback | The macOS build does not stage mpv, although the README implies no separately installed player is needed. | Bundle the supported player or accurately document the external-player/browser requirement; a developer's installed players must not conceal a missing dependency. |
| Distribution rights | Windows distributables are explicitly gated on an exact third-party redistribution review. | Review the applicable notices/source/build materials for both platforms before sharing binaries; private sharing is redistribution too. |
| End-to-end reliability | Historical host-playback evidence exists, but current clean-machine and representative client acceptance is incomplete. | Establish the advertised install-to-playback experience on actual recipient hardware; a readable sample is not sustained playback. |
| Updates and recovery | Atomic JSON writes and recovery exist; browser JSON export is not a full backup. | Provide a safe manual upgrade, backup, restore, and rollback procedure that preserves credentials, managed files, and linked originals. |
| User documentation | README and troubleshooting material contain obsolete feature, configuration, and path descriptions. | Give testers one simple, accurate entry point and current recovery instructions. |
| Beta operations | No cohort-specific support and expansion contract has been established. | Define private reporting, ownership, success criteria, and stop conditions before invitations. |

## Phase 1 - Freeze the candidate contract and release identity

**Why:** A narrow supported configuration makes failures actionable and avoids
promising every platform, player, codec, and network topology at once.

- Confirm the initial macOS minimum version, Apple Silicon requirement,
  supported browser/native-player path, and Nuvio/Stremio client versions.
  The current macOS distribution guide specifies macOS 13.5 or later.
- Identify the candidate revision and align package, add-on manifest, native
  app, artifact names, and visible support/build information. Reuse a shared
  version source rather than maintain contradictory version strings.
- Define the basic playback promise: manual authorized media, trusted LAN,
  one stream, and an explicit supported codec/container set.
- Treat working, explicitly enabled pointer setup as part of beta readiness.
  It is a stable address for LAN clients, not a new remote-streaming service.
- Keep Windows and the Chrome companion subject to their separate gates below.

**Exit:** A single candidate identity and supported-configuration list can be
used consistently in the app, release notes, README, and bug reports.

### Candidate contract and remaining acceptance

| Item | Approved candidate scope |
|---|---|
| Version | `0.14.0`, from `addon/package.json`; packaged build identity also records revision and dirty state. |
| Starting revision | `231ae20`; these working-tree changes are not an immutable published release. Record the final build identity when packaging the accepted candidate. |
| Host | Apple Silicon, macOS 13.5 or later. Intel and Windows are outside this initial cohort. |
| Network/workload | Trusted home LAN, one simultaneous direct-play stream, authorized manually added media. No router/public exposure. |
| Baseline media | MP4 with H.264 video and AAC audio; other containers/codecs are outside the initial acceptance promise. |
| Host browser/player | Browser-first playback; macOS does not bundle mpv. A separately installed external player is optional through the advanced host-player API. Exact browser/version and sustained playback acceptance are still required. |
| Nuvio / Stremio | Target LAN clients, not yet a tested version matrix. Record exact device, OS, client version, install method and playback outcome before invitations. |
| Pointer | Explicitly enabled stable LAN add-on address, manual updates only. It does not provide remote media access. |
| Other integrations | Windows and the Chrome companion retain their separate release gates. |

## Phase 2 - Fix installed pointer provisioning

**Why:** Pointer functionality cannot depend on a developer's checkout `.env`
or on recipients obtaining the developer's private Vercel credentials.

### Establish the actual missing value

Trace the shipped bundle through `scripts/bootstrap.mjs`,
`scripts/native-server.mjs`, `addon/src/index.ts`, the pointer client, and
the deployed pointer API. Compare a clean installation, an existing
installation, and terminal source mode using disposable state.

Current source already generates/backfills `POINTER_PUSH_SECRET`, forwards it
to the add-on, and creates a pointer client only when both it and `POINTER_URL`
are present. A fresh generated `.env` does not configure `POINTER_URL`.
Determine whether the reported failure is an older artifact, missing endpoint,
failed generation/persistence/forwarding, or a deployment still using legacy
authentication. Do not assume that embedding a secret is the fix.

**Observed locally (2026-09-07):** Running the existing built bundle's bootstrap
and the source bootstrap with disposable empty state generated distinct
`ACCESS_TOKEN`/`POINTER_PUSH_SECRET` values in both cases, while leaving the
endpoint unset. The local bundle therefore reproduces the missing-endpoint
setup gap. The exact recipient artifact and deployed authentication behavior
are not established by that reproduction. The approved public API responds
with 405 to an unauthenticated GET; no production registration was attempted.

### Preserve the credential boundary

| Value | Intended ownership and provisioning |
|---|---|
| `POINTER_URL` | Non-secret service address. Confirm the approved beta endpoint and provide explicit setup for it, or for a user-supplied deployment. |
| `POINTER_PUSH_SECRET` | Unique local credential generated on the recipient's machine, stored privately, and preserved across restarts/upgrades. Authenticate manual pointer operations with it. |
| `ACCESS_TOKEN` | Existing per-install private add-on credential; preserve it and never reuse the developer's token for recipients. |
| Vercel deployment credentials, Redis/Blob credentials, legacy deployment-wide `PUSH_SECRET` | Server/operator configuration, not installer assets, browser settings, source code, logs, or shared client credentials. |

- Follow [ADR 0013](../decisions/0013-multi-tenant-pointer-server.md):
  per-install authentication and claim-on-first-push, not a shared client secret.
- Make endpoint setup discoverable without requiring users to know which
  hidden state file to edit. Preserve self-hosted/user-configured endpoints.
  Confirm the shared endpoint and operator before implementing a release default.
- Keep participation explicit and pushes strictly user-triggered. Do not
  contact or register with a shared service merely because the app was installed.
- Distinguish disabled/unconfigured, registered, stale, expired, unreachable,
  and authentication-failed states, with actionable recovery instead of a
  silently unavailable feature or a success-shaped fallback.
- Preserve valid secrets during upgrades. If an already-claimed installation
  loses its secret, document deliberate recovery rather than silently rotating
  it and pretending the existing claim can still be updated.
- Reconcile the pointer setup guide, copied add-on URL, and native menu/UI
  behavior with the repaired installed path.
- Explain that pointer requests transit the chosen service, media stays on the
  LAN, LAN-address changes require a manual update, and some browser clients
  reject HTTPS-to-HTTP LAN redirects and need the direct LAN URL.

**Exit:** Two clean recipient installations have distinct private credentials,
can independently enable and manually register/update/remove their pointers,
and retain their identities through restart/upgrade. The intended clients can
use the resulting manifest/catalog/stream routes. Missing configuration,
expired records, service failures, and wrong credentials have clear outcomes.
No developer `.env`, token, deployment credential, or shared push secret is
included in an artifact.

## Phase 3 - Complete the macOS distribution contract

**Why:** The beta must work with the contents of its artifact and its stated
prerequisites, not tools or settings left on the development machine.

- Resolve the macOS player decision before finalizing instructions: either
  bundle the supported mpv build and dependencies or explicitly scope host
  playback to supported browser media/an installed external player.
- Ensure Node, TorrServer, and the media-analysis tools required by the
  advertised workflow are present and usable without developer PATH entries.
- Review exact third-party binaries, notices, corresponding-source obligations,
  and required build materials. Apply this review to macOS as well as Windows.
  Do not invent an attestation or bypass the Windows redistribution gate.
- Keep bundles portable, with recipient-owned state created at runtime.
  Exclude developer state, `.env`, logs, media, and checkout-specific paths.
- Publish the approved versioned DMG with a SHA-256 checksum and concise release
  notes only after the remaining required phases pass.
- Retain the previous approved artifact, with its data-compatibility limits.
- For a technical, assisted cohort, document the unsigned/ad-hoc Gatekeeper
  experience accurately. Do not ask users to disable system-wide protections.
  Require Developer ID signing/notarization before claiming frictionless,
  self-service installation for nontechnical users.

**Exit:** A recipient can follow the stated install/player prerequisites using
only the released artifact and documentation; redistribution review is complete.

## Phase 4 - Rewrite the README as a simple quick start

**Why:** Users need to choose how to run HoshiStream, not work through an
architecture/API manual before their first launch.

Rewrite the README itself during this phase; do not just add more sections to
the existing long document. Keep the three workflows below in this order,
with clear prerequisites and short, self-contained command sequences.
Detailed reference material stays in `hoshistream_docs/`.

### 1. Install the macOS app - recommended

- Explain the app and authorized-media/trusted-LAN scope in a short introduction.
- State supported Mac hardware/OS and link to the current release download.
- Cover downloading the DMG, installing to Applications, the actual signing/
  Gatekeeper experience, and opening the menu-bar app.
- Explain first-run setup, adding a title, and connecting a player; distinguish
  native/browser player prerequisites from the bundled server runtimes.
- Explain that installed-app users do not need Node, npm, or build tools.
- Link to optional pointer setup, companion installation, and troubleshooting.

### 2. Run from the codebase in a terminal - optional

- Require Git, Node 22.18+ and npm; show cloning the repository and `npm ci`
  from `addon/`.
- Use the documented foreground whole-stack path: fetch TorrServer and FFmpeg/
  ffprobe, then run `node scripts/native-server.mjs --dev` from the root.
  Do not confuse this with the add-on-only `npm run dev` command.
- Explain how to open the local management page using the privately generated
  token, keep the terminal open, and stop with Ctrl+C.
- State that this path runs TypeScript directly without compiling a macOS app
  or installing the menu-bar shell. Native pickers and companion registration
  must not be promised in this mode.
- Explain checkout configuration/state versus installed-app state, point to the
  development guide for the exact paths, and tell users to stop the other
  instance before using the same ports.
- Link to watch mode and the installed-state start/stop scripts as advanced
  alternatives rather than mixing them into the main command sequence.

### 3. Build the macOS app from source - optional

- List development/build prerequisites, including Apple's command-line tools.
- Cover installing npm dependencies, fetching the pinned Node/TorrServer/media
  runtimes and the player selected in Phase 3, then building the app and DMG.
- Explain where artifacts appear and how to install the locally built app.
- Leave `HOSHISTREAM_PROJECT_ROOT` unset for a portable recipient build; do not
  imply building from source copies the developer's configuration or secrets.
- Distinguish building for personal use from redistribution/signing requirements.
- Link to the full macOS build/distribution guide instead of duplicating all
  packaging details.

Also remove or correct obsolete claims about the management UI, existing opt-in
repair, cache defaults, runtime pinning, and state paths. Keep API examples,
architecture, advanced tuning, and detailed recovery in their existing guides.
Give Windows a short, honest candidate-status link rather than a second large
quick start. Update linked guides and `index.md` if material is moved.

**Exit:** A newcomer can follow any of the three paths independently, understands
which tools/state/features it uses, and does not need an existing developer
environment or private configuration. The README remains an entry point rather
than duplicating the documentation collection.

## Phase 5 - Make updates, recovery, and privacy supportable

**Why:** Beta fixes must not strand users, erase their library, or collect
private information incidentally.

- Document quit-before-replacement, safe installation updates, and rollback.
  Establish compatible older versions; do not promise arbitrary downgrade
  compatibility or overwrite new-format state with an old artifact.
- Define a consistent backup while the app is stopped, using resolved runtime
  paths for library, configuration, auxiliary JSON stores, managed `.torrent`
  files/media, and relevant disk-volume metadata. Preserve linked originals
  separately; do not describe metadata export or `.bak` as a full backup.
- Exercise restore, upgrade, and uninstall with disposable representative state.
  Credentials, library entries, and linked originals must survive where promised.
- Correct troubleshooting to reflect automatic recovery, current state locations,
  player dependencies, firewall approval, and LAN-address changes.
- Publish a short privacy/network statement: private URLs are credentials,
  TorrServer administration shares the trusted-LAN boundary, automatic startup
  speed measurement contacts Cloudflare, and pointer use contacts the selected
  service. Local-first/no telemetry does not mean no outbound requests.
- Keep router/public exposure and remote access outside the first cohort;
  enabling the pointer does not make media remotely accessible.

**Exit:** A tester can update, recover, or uninstall with clear data-preservation
expectations and understands the network/privacy boundary.

## Phase 6 - Establish current candidate acceptance

**Why:** Source checks observe individual samples, not whole files, future swarm
availability, every episode, or all players. Historical evidence does not
replace acceptance of the actual candidate artifact.

| Scenario | Required evidence |
|---|---|
| Clean recipient Mac | Install/launch without developer tools or hidden player dependencies; first-run onboarding and firewall guidance work. |
| Manual adding | Authorized local media, magnet, and `.torrent` paths save correctly; duplicates/retries and failures are understandable. |
| Movie and series playback | Advertised host and LAN clients can start, pause, seek, resume, and play a representative sustained session; episodes remain file-scoped. |
| Lifecycle | Restart/quit release owned processes and ports; sleep/resume and network changes have supported recovery. |
| Pointer | Phase 2 succeeds from the installed candidate, including separate recipients and manual address updates; direct LAN fallback is explained. |
| Data lifecycle | Upgrade/restore/uninstall preserve the promised library, credentials, managed data, and linked originals. |
| Bounded workload | One supported stream stays within the published resource expectations; startup/seek measurements are recorded as observations, not universal guarantees. |
| Browser usability | Core install-to-playback instructions and visible failure/retry states work through actual user interaction, not only source assertions. |

Use only authorized media and disposable acceptance state; never repurpose a
tester's private library or silently start downloads. Record candidate build,
OS/client versions, scenario, outcome, and known limitations without credentials
or full magnet URIs.

Run the existing typecheck, tests, lint, format, and build commands for affected
code. Use existing pointer/native suites for their respective changes. Keep
hardware/playback acceptance distinct from automated or cross-compilation
results; do not add a browser automation runtime just for this beta.

**Exit:** Required scenarios pass for the published scope and remaining limits
are visible in the release notes. There are no unresolved data-loss,
unintended-exposure, or repeatable advertised-playback blockers.

## Phase 7 - Run the supported cohort

**Why:** A beta is useful only if observations can become reproducible fixes.

- Name a release/support owner and use one private feedback channel.
- Provide a short report template: build, OS/client versions, source type,
  reproduction steps, expected/actual behavior, and sanitized errors.
- Do not request raw `.env`, private URLs, authorization headers, magnets, or
  whole libraries. Manual sanitized diagnostics are sufficient initially;
  telemetry and an in-app reporting service are not prerequisites.
- Invite the small cohort only after the required gates above are satisfied.
- Track first playback, whether setup required assistance, return usage,
  recurring failures, and upgrade success through voluntary feedback.
- Expand only after testers can reach first playback from the instructions,
  return for another session, and update without losing their library.
- Pause expansion for data loss, unintended exposure, broken pointer enrollment,
  or repeatable failure of an advertised playback path.

## Conditional gates and deferred work

| Area | Beta treatment |
|---|---|
| Windows | Defer invitations until the exact redistribution review and real Windows acceptance in the existing release plan are complete. Stage-only payloads are not distributable releases. |
| Chrome companion | Optional technical sub-cohort with the matching unpacked extension and native host. Web Store publication/identity alignment is required before presenting it as a finished mainstream installation flow. |
| Signing/notarization | May defer for explicitly assisted, trusted technical Mac testers; prerequisite for a frictionless nontechnical installation claim. |
| Advanced storage | Keep external-drive/archiver edge cases outside the initial advertised scope unless separately accepted; do not remove existing data or functionality. |
| Repair/remote access | Existing opt-in repair and remote access are outside initial acceptance. No new transcoding or public exposure. |
| Feature expansion | Defer automatic updates, Intel/other platform support, accounts, telemetry, databases, discovery, and broader codec/concurrency promises. |

Do not silently remove an agreed gate to meet a date. Change the advertised
scope explicitly, or hold that part of the rollout.

## References

- [Documentation index](../index.md)
- [Getting started](../guides/getting-started.md)
- [Development and terminal operation](../guides/development.md)
- [macOS distribution](../guides/distributing-macos-app.md)
- [Windows release plan](2026-09-06-windows-desktop-release-plan.md)
- [Windows distribution](../guides/distributing-windows-app.md)
- [Chrome companion](../guides/chrome-companion.md)
- [Pointer setup](../guides/pointer-server-vercel.md)
- [Multi-tenant pointer decision](../decisions/0013-multi-tenant-pointer-server.md)
- [File-scoped readiness decision](../decisions/0023-file-scoped-readiness-evidence.md)
