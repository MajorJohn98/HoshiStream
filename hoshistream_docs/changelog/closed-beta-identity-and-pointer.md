# Closed beta identity, pointer and distribution

Date: 2026-09-07

Implements the phase 1-4 code/documentation slices of the
[closed beta plan](../plans/2026-09-07-closed-beta-readiness-plan.md), not a
release approval. Version remains `0.14.0`; exact recipient browser and
Nuvio/Stremio versions still require acceptance. The agreed contract is
Apple Silicon, macOS 13.5+, trusted LAN, one direct-play stream, and H.264/AAC
in MP4 as the baseline browser media. The approved macOS path is browser-first:
mpv remains an optional external installation, not a bundled prerequisite.
Redistribution approval and publication remain blocked.

## Phase 3-4: macOS distribution and quick start

- All four server/analysis executables are required. Download receipts bind
  Node/FFmpeg binaries to verified archives; Node's complete upstream license
  notices are retained. TorrServer is checked directly against its binary pin.
- The app is checked for portable arm64/system-library dependencies, minimum
  OS targets, executable tools and private/developer payload leaks. Its final
  signed bytes are inventoried before the DMG is created.
- Normal DMG creation requires reviewed macOS source/license/build materials;
  pin changes invalidate reviews. Windows retains its separate existing gate.
  A stage-only image is clearly labeled local-only, not distributable.
- Images have SHA-256, build identity, payload inventory and release-notes
  sidecars. Existing images are not overwritten. Nothing is published.
- README is now three independent quick starts: install the Mac app, run the
  whole stack in a foreground terminal, or build the Mac app. Linked guides
  correct external-player promises, terminal/installed state paths, actual
  runtime pins and the assisted ad-hoc Gatekeeper experience.

An isolated app and image were exercised without using installed state or
developer PATH entries. The normal release path still blocks because the exact
reviewed redistribution bundle is absent. The
[distribution guide](../guides/distributing-macos-app.md) records outstanding
materials; the [plan](../plans/2026-09-07-closed-beta-readiness-plan.md) separates
observed local outcomes from still-required recipient/client and phase 5-7 work.

## Installed pointer diagnosis

Disposable first-run runs through both the existing built macOS bundle's
bootstrap and the current source bootstrap generated distinct access/push
credentials but no `POINTER_URL`. Thus the local bundle reproduces the missing
endpoint/setup path, not missing Vercel credentials. This does not identify
the exact binary previously installed by a recipient.

The configured public URL was found locally without exposing secrets. Its
linked project and operator were confirmed with read-only Vercel project
metadata, and the user approved `https://hoshistream-pointer.vercel.app`,
operated by **Major John's projects**, as a suggested beta service. Its API
responded to an unauthenticated GET with method-not-allowed; that alone is
not evidence of successful registration or deployed authentication parity.
No deployment was changed and no live recipient records were created.

## Behavior

- Manifest, native app and candidate artifacts use one package version and
  build stamp. Status and About show that identity; unstamped runs identify
  themselves as source builds rather than accepted candidates.
- Setup is discoverable in Activity and the macOS menu. Save/enable is a
  private local write; registration, checking, updates and removal are manual.
  Custom services and explicitly disabled choices survive restart.
- Per-install credentials remain private and are never installer defaults.
  Missing credentials for existing pointer setup require deliberate recovery;
  neither the access token nor push secret is silently rotated to repair a claim.
- Status separates configuration, registration, stale addresses, expiry,
  reachability and authentication failures. A status 404 is explicitly
  ambiguous between a missing record and wrong credentials.
- Copies use pointer addresses only with current registration evidence.
  Get started and the native menu retain direct LAN URLs for service failures
  and browser clients that block HTTPS-to-HTTP redirects.
- Pointer storage failures no longer masquerade as an unclaimed record or
  successful removal. The service-side change takes effect only after an
  operator separately deploys it.
- A failed read-only service check allows correcting the endpoint without
  requiring a successful removal from a mistyped service. An unconfirmed
  registration attempt retains its possible-claim evidence.

## Acceptance boundary

Automated recipient scenarios use disposable state and the repository's
multi-tenant handlers with fixture storage, not production records or media.
Actual installed-candidate testing on two recipient Macs, deployed service
registration/update/removal, and manifest/catalog/stream use by identified
Nuvio/Stremio clients remain required before invitations. Do not treat local
checks or a responding public URL as that evidence.
