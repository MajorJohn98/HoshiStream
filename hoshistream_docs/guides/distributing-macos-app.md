# Distributing the macOS app

The browser-first candidate targets **Apple Silicon, macOS 13.5+, a trusted
home LAN and one direct-play stream**. Browser baseline media is H.264/AAC MP4.
It bundles Node, TorrServer, FFmpeg and ffprobe, **not mpv**. Installed users
need a browser but no developer tools. The current release download remains
the older 0.8.2 artifact; no 0.14.0 release is approved by this guide.

## Build for local validation

Install Git, Node 22.18+ with npm, and Apple's Command Line Tools (or Xcode).
From the repository root, with `HOSHISTREAM_PROJECT_ROOT` unset:

```bash
cd addon
npm ci
cd ..
node packaging/fetch-node-runtime.mjs
node packaging/fetch-torrserver.mjs
node packaging/fetch-ffmpeg.mjs
export HOSHISTREAM_BUILD_DIR="$PWD/build/macos-candidate"
./packaging/build-macos-app.sh
./packaging/build-macos-dmg.sh --stage-only
```

The app build fails before replacing an existing build if downloaded runtime
provenance is missing or stale. Re-run the fetcher named in the error, not a
PATH-installed substitute. It preserves Node's upstream notices, installs only
production npm dependencies, and requires both media-analysis tools even when
stream repair is disabled. It checks executable permissions, arm64 architecture,
system-only dynamic libraries, deployment targets and tool startup under an
OS-only PATH. These checks do not establish real-recipient playback acceptance.

Build identity comes from `addon/package.json`, the actual Git revision, dirty
state and a unique stamp. The runtime, plist, **About HoshiStream**, **Status**
and artifact names share it. A post-signing `HoshiStream.app.payload.json`
inventory sits beside the app and binds the final payload bytes;
packaging rejects changed payloads, missing files, developer/private state and
checkout-pinned apps. A local app may use `HOSHISTREAM_PROJECT_ROOT` for personal
development, but it cannot be made into a portable DMG without rebuilding.

The stage-only image is named
`HoshiStream-<buildId>-darwin-arm64-LOCAL-ONLY.dmg`, with `.dmg.sha256`,
`.release.json`, `.payload.json` and `.notes.txt` sidecars. It is **local validation only, not
for sharing**. A DMG preserves app resources, executable permissions and the
Applications link. Existing images are never overwritten; rebuild for a new ID.

## Redistribution gate

**Private sharing is redistribution too.** macOS now follows the same reviewed
materials principle as [Windows](distributing-windows-app.md), without relaxing
Windows' separate .NET/mpv requirements.

Assemble exact notices, licenses, corresponding sources, dependency versions,
patches and build instructions under `vendor/macos-redistribution/`. The
`manifest.json` schema is in `packaging/macos-third-party.txt`. It binds each
reviewed file's SHA-256 to the Node, TorrServer, FFmpeg and npm lockfiles included
in the actual app, not whichever locks happen to be in a later checkout.
Any pin change requires a new review. Reviewed browser-asset attribution/source
inventory also belongs in those materials.

No attestation is checked in. A few license texts, upstream links or a filled-in
manifest are not evidence that all corresponding-source obligations are met.
The technical gate catches stale/missing materials, not legal completeness.
Do not mark `completeCorrespondingSource` true until the exact materials have
actually been assembled and reviewed.

Once the materials are complete, the normal command includes them beside the
app in the disk image:

```bash
./packaging/build-macos-dmg.sh
```

It emits `HoshiStream-<buildId>-darwin-arm64.dmg` with matching checksum, identity
and notes. **Do not publish it yet:** recipient/client acceptance, deployed
pointer behavior, updates/recovery and support readiness in the
[beta plan](../plans/2026-09-07-closed-beta-readiness-plan.md) remain separate
gates. Neither packaging command deploys, publishes or invites testers.

Retain the previous approved DMG, checksum, notes and its compatible stopped-state
backup. The existing 0.8.2 download is not a proven downgrade target for 0.14.0
state. Do not replace the only approved artifact or claim data compatibility
without the phase 5 decision and recovery exercise.

### Exact-component review findings (2026-09-07)

**Deferred for later follow-up at the user's request (2026-09-07).** The
[beta plan's blocker register](../plans/2026-09-07-closed-beta-readiness-plan.md#deferred-blocker-register-2026-09-07)
tracks these source/notice gaps together with recipient acceptance, recovery,
support and conditional signing work. Deferral does not waive the distribution
gate or authorize sharing local-only artifacts.

**Review is incomplete, not an assertion that redistribution is prohibited.**
Published upstream digests match the locked macOS artifacts. Their identity and
system-only dynamic dependencies do not establish corresponding-source
completeness for statically incorporated code.

| Component | Established evidence | Outstanding release material |
|---|---|---|
| Node v26.3.1 | Official archive digest matches; the complete upstream `LICENSE`, including third-party notices, is now retained from that archive. | Include and review those notices in the release materials; no GPL-style Node source-distribution obligation was identified. |
| TorrServer MatriX.141 | GPLv3; source revision `d266990face0a530880a19a3e39666d21931aed9` matches the binary's Go metadata. | Complete Go dependency and embedded-web source/license coverage, generated files and build instructions. The binary reports Go 1.26.0 and `vcs.modified=true`; generated web/docs may explain the flag, but a pristine tag alone is not proven complete. |
| FFmpeg/ffprobe 9.0.1, Riedl build `1787073674_9.0.1` | Build-specific configuration enables GPL/version3 and static external libraries, selecting GPLv3-or-later. Core source and a matching candidate build recipe were located. | Exact x264 snapshot, all incorporated dependency sources/notices, build adjustments and a demonstrated mapping from the recipe/inputs to the locked ZIPs. The report says only x264 `0.165.x`; the recipe downloads mutable `master`. Today's master is not a valid substitute. |
| Production npm packages | Existing package notices are preserved, including licenses embedded in README files. | `tr46 0.0.3` and `uint8-util 2.3.2` have MIT metadata but their exact integrity-matched registry archives lack license/notice documents. Resolve historical notice provenance; do not invent copyright text or assume today's upstream license applies. Review browser-asset notices too. |

Primary evidence and located materials:

- Node: [official checksums](https://nodejs.org/dist/v26.3.1/SHASUMS256.txt),
  [versioned license](https://github.com/nodejs/node/blob/v26.3.1/LICENSE) and
  [build documentation](https://github.com/nodejs/node/blob/v26.3.1/BUILDING.md).
- TorrServer: [exact source archive](https://github.com/YouROK/TorrServer/archive/d266990face0a530880a19a3e39666d21931aed9.tar.gz),
  [release recipe](https://github.com/YouROK/TorrServer/blob/d266990face0a530880a19a3e39666d21931aed9/.github/workflows/ts_release.yml),
  [Go dependencies](https://github.com/YouROK/TorrServer/blob/d266990face0a530880a19a3e39666d21931aed9/server/go.mod)
  and [web dependency lock](https://github.com/YouROK/TorrServer/blob/d266990face0a530880a19a3e39666d21931aed9/web/yarn.lock).
  The release recipe uses Go `stable` and `swag@latest`; account for the actual
  generator/toolchain versions, not just these moving selectors.
- FFmpeg: [exact build report](https://ffmpeg.martin-riedl.de/download/macos/arm64/1787073674_9.0.1/versions.txt),
  [core source](https://ffmpeg.org/releases/ffmpeg-9.0.1.tar.bz2),
  [license details](https://github.com/FFmpeg/FFmpeg/blob/n9.0.1/LICENSE.md)
  and [candidate Riedl recipe archive](https://git.martin-riedl.de/ffmpeg/build-script/archive/f63b8aab8f5ce1a067da86ba69e34a36a7e217e5.tar.gz).
  That recipe is not an upstream binary-to-source attestation. Include its
  dependency adjustments and rav1e's Rust source closure as applicable.
- Missing npm notices: [tr46 source revision](https://github.com/Sebmaster/tr46.js/tree/a8009f9ce80ff5dbe71dd71e203afe4e4c878d28)
  also lacks a license document; [uint8-util upstream](https://github.com/ThaUnknown/uint8-util)
  has no established matching tag or registry `gitHead` for the locked version.
  These are unresolved provenance gaps, not automatic findings of infringement.

FFmpeg also calls for an Independent JPEG Group acknowledgement, now included
in the packaged notice. OpenSSL 3.x is compatible with FFmpeg's recorded GPLv3
configuration; its presence does not by itself make this build nonfree. Patent
clearance, including any assumptions about independently built OpenH264, has
not been established by this review.

The selected GPL source-access arrangement must keep complete corresponding
source and controlling build scripts available alongside the binary, with clear
directions and continuing availability. Upstream homepage links alone do not
satisfy this release's reviewed-materials gate. No source-completeness
attestation has been generated, and no binary has been published.

## Install an approved image

Use only a trusted, approved image and independently obtained release checksum.
In Downloads, replace the example filename with the actual approved filename:

```bash
cd ~/Downloads
shasum -a 256 -c 'HoshiStream-<buildId>-darwin-arm64.dmg.sha256'
```

An `OK` result identifies matching bytes; it is not proof of publisher trust.
Open the DMG, copy the app to Applications and open that copy. Quit an existing
HoshiStream instance before any replacement; do not delete its state.

### Ad-hoc signing and assisted installation

This candidate has an **ad-hoc signature, not a Developer ID signature or
notarization ticket**. Download quarantine may block launch; wording and
available override controls vary by macOS version and device policy. It may
report an unverified developer or a damaged app. A valid ad-hoc signature does
not imply Gatekeeper acceptance.

After trying to open a trusted copy, use **System Settings > Privacy & Security >
Open Anyway** if offered. Never turn off Gatekeeper, Defender or organization
policy. If no override is available, stop and request assistance.

For an explicitly assisted technical tester who has verified the origin and
checksum, an app-scoped quarantine removal is an alternative. Mount the image,
ensure there is no existing Downloads or Applications copy, then:

```bash
test ! -e "$HOME/Downloads/HoshiStream.app" &&
test ! -e "/Applications/HoshiStream.app" &&
ditto /Volumes/HoshiStream/HoshiStream.app "$HOME/Downloads/HoshiStream.app" &&
xattr -dr com.apple.quarantine "$HOME/Downloads/HoshiStream.app" &&
mv "$HOME/Downloads/HoshiStream.app" /Applications/ &&
open /Applications/HoshiStream.app
```

This intentionally removes quarantine only from that trusted app, not from the
whole disk or system. Staging in Downloads avoids permissions/App Management
restrictions that can affect an already installed bundle. Failure stops the
sequence; do not bypass a managed policy. For upgrades, retain the existing app
and follow an approved update procedure rather than deleting it to satisfy
these fresh-install guards.

Developer ID signing, hardened-runtime compatibility, notarization and ticket
stapling are required before claiming frictionless nontechnical installation.
They are not implemented by the ad-hoc build.

## First run and player prerequisites

HoshiStream appears in the menu bar, not the Dock. Allow incoming connections
on the trusted LAN when prompted. First launch creates recipient-owned
`~/Library/Application Support/HoshiStream` with private `.env`, unique access
and pointer credentials, library and managed runtime state. It does not ship
a developer `.env` or require editing configuration before launch.

Follow [Get started](getting-started.md): manually add a title, then choose
**Play** to watch in the browser or install the private add-on URL in Nuvio or
Stremio. Exact browser/client versions and sustained playback still need
acceptance; source checks do not guarantee successful playback.

mpv is optional, external and not part of the macOS image. The management
page's Play action does not invoke it. See the
[advanced playback notes](setup-native-macos.md#playback-notes).
Pointer participation remains explicit and updates manual; use
[pointer setup](pointer-server-vercel.md). A pointer does not expose LAN media
remotely. See [troubleshooting](troubleshooting.md) for firewall and LAN issues.

## Updates and cohort release gate

Ship the [backup, restore and update procedure](backup-restore-updates.md),
[privacy/network statement](privacy-and-network.md), and
[private support instructions](closed-beta-support.md) with the release links.
Record exact artifact/client results in the
[candidate acceptance record](closed-beta-acceptance.md). No older published
artifact is currently approved to read this candidate's newer state.

Repository implementation of phases 5-7 does not waive recipient installation,
sustained playback, live pointer, recovery/upgrade or private-channel acceptance.
The selected feedback repository remains unprovisioned/unverified at the owner's
request. Keep distribution and invitations on hold while these gates or exact
third-party materials are outstanding.
