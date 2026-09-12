# HoshiStream Documentation Index

## Architecture

- [architecture/architecture-overview.md](architecture/architecture-overview.md) — System diagram, module map, data flow, deployment modes, and state layout.
- [OpenCodeAnalysis.md](OpenCodeAnalysis.md) — Part-by-part codebase walkthrough: components, internals, and end-to-end request flows.

## Decisions (ADRs)

- [decisions/0001-torrserver-matrix-141-pinning.md](decisions/0001-torrserver-matrix-141-pinning.md) — Pin TorrServer to MatriX.141.1 and use only Swagger-verified endpoints.
- [decisions/0002-disk-cache-over-ram-tiering.md](decisions/0002-disk-cache-over-ram-tiering.md) — Single bounded 2 GiB disk cache instead of RAM + disk tiering.
- [decisions/0003-native-menu-bar-app-no-electron.md](decisions/0003-native-menu-bar-app-no-electron.md) — Syncthing-style native supervisor app; Electron rejected.
- [decisions/0004-token-in-path-and-bearer-security-model.md](decisions/0004-token-in-path-and-bearer-security-model.md) — Path-token add-on URLs, bearer management API, trusted-LAN boundary.
- [decisions/0005-host-header-public-urls.md](decisions/0005-host-header-public-urls.md) — Derive public stream URLs from the request Host header with configured fallback.
- [decisions/0006-inspection-cache-on-entries.md](decisions/0006-inspection-cache-on-entries.md) — Persist inspection results on library entries for instant stream resolution.
- [decisions/0007-lan-detection-via-public-ip-match.md](decisions/0007-lan-detection-via-public-ip-match.md) — Return LAN stream URLs to tunnel clients sharing the server's public IP.
- [decisions/0008-bundled-mpv-player-over-json-ipc.md](decisions/0008-bundled-mpv-player-over-json-ipc.md) — Drive mpv over its JSON IPC socket for host playback; no Electron, one implementation for macOS and Windows.
- [decisions/0009-native-only-deployment.md](decisions/0009-native-only-deployment.md) — Remove Docker; the native app is the only deployment mode, and Windows gets a minimal launcher rather than a supervisor rewrite.
- [decisions/0010-opt-in-realtime-transcoding.md](decisions/0010-opt-in-realtime-transcoding.md) — Proposed: opt-in tiered stream repair (remux, audio fix, hardware video transcode) via vendored ffmpeg, gated by the probe verdict.
- [decisions/0011-mdns-lan-discovery.md](decisions/0011-mdns-lan-discovery.md) — LAN discovery via a dependency-free mDNS responder in the add-on; external rendezvous rejected.
- [decisions/0012-vercel-pointer-server.md](decisions/0012-vercel-pointer-server.md) — Permanent manifest URL via a self-controlled Vercel pointer server with strictly manual pushes.
- [decisions/0013-multi-tenant-pointer-server.md](decisions/0013-multi-tenant-pointer-server.md) — Multi-tenant pointer server keyed by token hash with claim-on-first-push auth, Upstash/Blob storage, and open-redirect hardening.
- [decisions/0014-run-typescript-source-directly.md](decisions/0014-run-typescript-source-directly.md) — Run `addon/src` directly via Node type stripping: `.ts` import specifiers, erasable-only syntax, `--dev` launcher flag; `tsx` rejected.
- [decisions/0015-keep-json-stores-sqlite-deferred.md](decisions/0015-keep-json-stores-sqlite-deferred.md) — Keep atomic JSON stores; SQLite (`node:sqlite`) deferred with explicit revisit criteria and the inspection-cache split as the first remedy.

- [decisions/0016-opt-in-curated-torrent-search.md](decisions/0016-opt-in-curated-torrent-search.md) — Approved opt-in open-film search in Add Media, reviewed source pins, bounded torrent parsing, and retry-safe JSON import.

- [decisions/0017-local-search-bridges-and-series-import.md](decisions/0017-local-search-bridges-and-series-import.md) — Optional loopback Prowlarr/Jackett adapters, explicit public indexers, and collision-reviewed series source imports.

- [decisions/0018-bundled-direct-search-providers.md](decisions/0018-bundled-direct-search-providers.md) — Approved bundled YTS/Nyaa/1337x adapters, bounded HTML parsing, and no external search-service requirement.

- [decisions/0019-post-save-source-checks.md](decisions/0019-post-save-source-checks.md) — Opt-out bounded checks after saving, persistent progress, source-revision guards, and honest playback readiness.

- [decisions/0020-manual-import-chrome-companion.md](decisions/0020-manual-import-chrome-companion.md) — Retire discovery and use a least-privilege Chrome companion with a same-computer macOS native bridge.
- [decisions/0021-native-magnet-link-handler.md](decisions/0021-native-magnet-link-handler.md) — Opt-in macOS magnet handling with private, expiring handoff tickets and explicit Add Media review.
- [decisions/0022-windows-native-desktop-release.md](decisions/0022-windows-native-desktop-release.md) — Windows 11 tray, self-contained installer, native integration parity and preserved private/manual behavior.
- [decisions/0023-file-scoped-readiness-evidence.md](decisions/0023-file-scoped-readiness-evidence.md) — Separate metadata, sampled media, and player support; file-scoped facts, shared checks and explicit longer retries.
- [decisions/0024-immutable-pointer-blob-versions.md](decisions/0024-immutable-pointer-blob-versions.md) — Pointer Blob records become immutable versions located via `list`, because the public Blob CDN served in-place overwrites stale for days.

## Guides

- [Public setup and configuration guide](https://majorjohn98.github.io/HoshiStream/) — Complete macOS-first installation, settings, players, storage, remote access, Windows, recovery and troubleshooting guide.
- [guides/publishing-documentation.md](guides/publishing-documentation.md) — Public guide sources, dependency-free local build and documentation-only GitHub Pages deployment.
- [guides/backup-restore-updates.md](guides/backup-restore-updates.md) — Resolved-path stopped backups, same-path restore, manual upgrades, rollback limits and non-destructive uninstall.
- [guides/privacy-and-network.md](guides/privacy-and-network.md) — Credentials, trusted-LAN administration, automatic Cloudflare measurement, torrent traffic and explicit pointer/network contacts.
- [guides/closed-beta-acceptance.md](guides/closed-beta-acceptance.md) — Candidate-bound acceptance runbook, local evidence and outstanding recipient/player/service gates.
- [guides/closed-beta-support.md](guides/closed-beta-support.md) — Named owner, pending private feedback channel, sanitized report template, voluntary milestones and rollout stop conditions.
- [guides/getting-started.md](guides/getting-started.md) — First-launch setup: add a title, connect Nuvio or Stremio, skip and resume privately.
- [guides/chrome-companion.md](guides/chrome-companion.md) — Companion workflow, native registration, local testing, packaging and publication requirements.

- [guides/setup-native-macos.md](guides/setup-native-macos.md) — Build and install the native app, configure `.env`, tune TorrServer, and forward the peer port.
- [guides/setup-native-windows.md](guides/setup-native-windows.md) — Windows 11 desktop installation, tray behavior, native media/Chrome integration and terminal operation.
- [guides/distributing-windows-app.md](guides/distributing-windows-app.md) — Self-contained Windows staging, installer/ZIP commands, acceptance and redistribution gates.
- [guides/distributing-macos-app.md](guides/distributing-macos-app.md) — Browser-first macOS payload, pinned tools, reviewed redistribution gate, local-only DMGs, checksums and assisted Gatekeeper installation.
- [guides/adding-media.md](guides/adding-media.md) — Add magnets, `.torrent` files, and local media; inspection and viability.
- [guides/development.md](guides/development.md) — Dev commands, the no-build source-run loop (`npm run dev`, `start-native.sh --dev`), working agreement, and code conventions.
- [guides/troubleshooting.md](guides/troubleshooting.md) — AirPlay port conflict, LAN reachability, stalls, corrupt library.
- [guides/remote-access-cloudflare-tunnel.md](guides/remote-access-cloudflare-tunnel.md) — Cloudflare Tunnel setup and LAN-aware stream URLs.
- [guides/pointer-server-vercel.md](guides/pointer-server-vercel.md) — Deploy the Vercel pointer server for a permanent add-on URL and the manual "Update Remote Pointer" flow.

## API

- [api/management-api-reference.md](api/management-api-reference.md) — Auth, library CRUD, inspection, status, uploads, and token-gated routes.
- [api/addon-protocol.md](api/addon-protocol.md) — Tokenized manifest, catalog/meta/stream routes, IDs, and stream objects.
- [api/torrserver-endpoints-used.md](api/torrserver-endpoints-used.md) — The verified TorrServer endpoint subset and client behavior.
- [api/native-runtime-control.md](api/native-runtime-control.md) — Private local readiness, state ownership and graceful desktop/terminal shutdown contracts.

## Plans

- [plans/2026-09-12-playback-pointer-library-expansion-plan.md](plans/2026-09-12-playback-pointer-library-expansion-plan.md) — Eleven-phase expansion: playback telemetry and buffer-ahead gate, bitrate-aware streams, pointer drift detection, watched state, subtitles, mapping repair, disk-copy policies, diagnostics, TorrServer settings UI, signing and CI smoke.
- [plans/2026-09-12-stale-pointer-reads-and-slow-link-tuning.md](plans/2026-09-12-stale-pointer-reads-and-slow-link-tuning.md) — Root causes and fixes for stale pointer redirects (Blob CDN) and TV buffering on a ~9 Mbps line (TorrServer upload/connection tuning).
- [plans/2026-09-07-public-setup-guide.md](plans/2026-09-07-public-setup-guide.md) — Approved static setup guide and documentation-only GitHub Pages publication plan.
- [plans/2026-09-07-closed-beta-readiness-plan.md](plans/2026-09-07-closed-beta-readiness-plan.md) — macOS-first closed beta phases, deferred blocker register, installed pointer provisioning, quick starts, release acceptance, recovery and support.
- [plans/2026-08-10-project-assessment.md](plans/2026-08-10-project-assessment.md) — Project health assessment: verified checks, risks, next steps.
- [plans/2026-08-12-reliability-plan.md](plans/2026-08-12-reliability-plan.md) — Reliability findings and the seven fixes shipped in 0.3.0.
- [plans/2026-08-12-management-ui-plan.md](plans/2026-08-12-management-ui-plan.md) — Library management & UI improvement plan shipped in 0.4.0.
- [plans/2026-08-12-tunnel-lan-plan.md](plans/2026-08-12-tunnel-lan-plan.md) — Cloudflare Tunnel + LAN-aware stream URL plan shipped in 0.5.0.
- [plans/2026-08-14-performance-and-cross-platform-plan.md](plans/2026-08-14-performance-and-cross-platform-plan.md) — Playback performance, built-in mpv player, and macOS + Windows shipping roadmap.
- [plans/2026-08-14-native-only-plan.md](plans/2026-08-14-native-only-plan.md) — Remove Docker, retarget config to real paths, and the Windows launcher path.
- [plans/desktop-app-strategy.md](plans/desktop-app-strategy.md) — Installed-app strategy: native supervisor, bundled runtimes, ship order.
- [plans/2026-08-23-realtime-transcoding-plan.md](plans/2026-08-23-realtime-transcoding-plan.md) — Opt-in real-time stream repair: pipeline, session model, seek handling, phased rollout.
- [plans/2026-08-23-frontend-redesign-and-transcoding-plan.md](plans/2026-08-23-frontend-redesign-and-transcoding-plan.md) — Preact+htm management UI redesign, transcoding UI surface, and the no-Docker dev loop.
- [plans/2026-08-23-windows-launcher-plan.md](plans/2026-08-23-windows-launcher-plan.md) — Windows v1: portability fixes, PowerShell launcher, zip packaging, on-hardware verification.
- [plans/2026-09-06-windows-desktop-release-plan.md](plans/2026-09-06-windows-desktop-release-plan.md) — Approved Windows 11 x64 tray, native integration, bundled playback and private installer release plan.
- [plans/2026-09-01-stable-manifest-pointer-plan.md](plans/2026-09-01-stable-manifest-pointer-plan.md) — Stable manifest URL via a Vercel pointer/redirector server with a manual menu-bar IP push.
- [plans/2026-09-01-multi-torrent-series-plan.md](plans/2026-09-01-multi-torrent-series-plan.md) — One series entry backed by several torrents: extra sources, composite file IDs, merged episode list.
- [plans/2026-09-02-multi-tenant-pointer-and-dashboard-plan.md](plans/2026-09-02-multi-tenant-pointer-and-dashboard-plan.md) — Multi-tenant pointer server (token-keyed, claim-on-first-push), public-release hardening, and the local connected-clients dashboard.
- [plans/2026-09-02-disk-library-plan.md](plans/2026-09-02-disk-library-plan.md) — Save-to-disk toggle: volume registry for external drives, background archiver, disk-first playback with torrent fallback.
- [plans/2026-09-03-ui-redesign-plan.md](plans/2026-09-03-ui-redesign-plan.md) — Cinema shelf + live sidebar UI redesign: HUD, merged System page, entry sheet.
- [plans/2026-09-04-entry-tags-plan.md](plans/2026-09-04-entry-tags-plan.md) — Entry tags: default genre set, tag registry + API, Library filter, Tags page, Stremio genre extra.

- [plans/2026-09-05-torrent-search-plan.md](plans/2026-09-05-torrent-search-plan.md) — Completed phases 0-4: curated search, local Prowlarr/Jackett, and collision-reviewed series additions; generic Torznab deferred.

- [plans/2026-09-06-search-add-hardening.md](plans/2026-09-06-search-add-hardening.md) — Search/add reliability: metadata preservation, bounded automatic checks, retry-safe additions, honest readiness, and recovery.

- [plans/2026-09-06-chrome-companion-plan.md](plans/2026-09-06-chrome-companion-plan.md) — Replace in-app discovery with manual imports, a Chrome side panel and a same-computer macOS native bridge.

## Changelog

- [changelog/playback-telemetry-and-line-fit.md](changelog/playback-telemetry-and-line-fit.md) — TorrServer `/cache` runway sampling with an Activity runway line, and bitrate-aware stream ordering with a single line-fit rule (Phases 1–2 of the expansion plan).
- [changelog/pointer-freshness-and-slow-link-tuning.md](changelog/pointer-freshness-and-slow-link-tuning.md) — Immutable pointer Blob versions (fresh reads after every push) and TorrServer `UploadRateLimit`/`ConnectionsLimit` defaults for slow asymmetric lines.
- [changelog/closed-beta-identity-and-pointer.md](changelog/closed-beta-identity-and-pointer.md) — Phase 1-7 repository implementation: identity, pointer, distribution, quick starts, recovery, privacy and gated cohort operations.

- [changelog/windows-desktop.md](changelog/windows-desktop.md) — Windows tray, native integrations, playback, storage, lifecycle and packaging implementation.

- [changelog/new-user-onboarding.md](changelog/new-user-onboarding.md) — Skippable first-run guidance, persistent setup progress, and private player connection.
- [changelog/chrome-companion-manual-import.md](changelog/chrome-companion-manual-import.md) — Manual-import pivot, discovery removal, Chrome side panel and native messaging.
- [changelog/search-add-hardening.md](changelog/search-add-hardening.md) — Metadata-preserving resolution, durable additions/uploads, bounded post-save checks, and actionable recovery states.
- [changelog/bundled-direct-search-providers.md](changelog/bundled-direct-search-providers.md) — Direct YTS/Nyaa/1337x search, parser/transport limits, and current site availability.
- [changelog/local-search-bridges-and-series-import.md](changelog/local-search-bridges-and-series-import.md) — Optional Prowlarr/Jackett search, explicit provider selection, collision-reviewed series append, and managed extra-source cleanup.
- [changelog/curated-torrent-search.md](changelog/curated-torrent-search.md) — Opt-in Add Media search, three reviewed open films, pinned torrent metadata, reviewed-file selection, and retry-safe library import.
- [changelog/0.1.0-mvp.md](changelog/0.1.0-mvp.md) — Five completed MVP phases, post-MVP additions, known gaps.
- [changelog/0.3.0-reliability.md](changelog/0.3.0-reliability.md) — Git init, host-derived URLs, library recovery, retries, inspection cache, supervisor hardening, sleep prevention.
- [changelog/0.4.0-management-ui.md](changelog/0.4.0-management-ui.md) — UI restructured into static ES modules, Finder linking/relinking, cache-aware detail view, status refresh.
- [changelog/0.11.0-disk-library.md](changelog/0.11.0-disk-library.md) — Disk library: marker-identified storage volumes, per-episode disk copies, resumable archiver, stable `/media` playback URL with torrent fallback, Storage UI.
- [changelog/0.12.0-ui-redesign.md](changelog/0.12.0-ui-redesign.md) — Cinema shelf UI: sidebar with live activity HUD, merged System control center, full-screen entry sheet.
- [changelog/0.12.1-router-split.md](changelog/0.12.1-router-split.md) — Router split into `routes/` modules with an options object; per-range-request library cloning and throttle reads trimmed; TorrServer client releases failed response bodies.
- [changelog/0.12.2-dev-mode-without-build.md](changelog/0.12.2-dev-mode-without-build.md) — Add-on runs from source under Node type stripping; `--dev` launcher flag, `.ts` specifiers, erasable-only syntax, no `tsc` in the dev loop.
- [changelog/0.14.0-instrument-ui.md](changelog/0.14.0-instrument-ui.md) — Instrument-panel UI: sections and hairline rows replace nested cards, status dots replace pills and badges, segmented source picker, flattened entry sheet.
- [changelog/0.13.0-entry-tags.md](changelog/0.13.0-entry-tags.md) — Genre-style entry tags with a dynamic registry: Library tag filter, TagPicker in entry forms, Tags page, Stremio `genre` catalog extra.
- [changelog/0.12.3-system-page-split.md](changelog/0.12.3-system-page-split.md) — System page split into Status, Activity (devices + stream repair), and Storage; playback analysis moves to a Library toolbar button; Add Media becomes a modal; all old routes redirect.
- [changelog/0.5.0-tunnel-lan-detection.md](changelog/0.5.0-tunnel-lan-detection.md) — Cloudflare Tunnel support with LAN-aware stream URLs for at-home clients.
- [changelog/0.7.0-native-only.md](changelog/0.7.0-native-only.md) — Docker removed; native app is the only deployment mode, config retargeted to real paths, TorrServer defaults shipped with the app.
- [changelog/0.6.0-performance.md](changelog/0.6.0-performance.md) — TorrServer throughput tuning, hot-path caching, larger read buffers, stream prewarming, direct-play detection, a built-in mpv player, and Windows vendoring groundwork.
- [changelog/0.8.0-ui-and-stream-repair.md](changelog/0.8.0-ui-and-stream-repair.md) — Preact rebuild + Cinema redesign of the management UI, opt-in stream repair, mDNS LAN discovery, and the in-browser player.
- [changelog/0.8.1-portable-macos-build.md](changelog/0.8.1-portable-macos-build.md) — Runtime state-directory resolution, first-run `.env` and token generation, and `.dmg` packaging.
- [changelog/0.9.0-remote-pointer.md](changelog/0.9.0-remote-pointer.md) — Permanent add-on URL: Vercel pointer server, manual push API, and the "Update Remote Pointer" menu item.
- [changelog/0.10.0-multi-torrent-series.md](changelog/0.10.0-multi-torrent-series.md) — One series entry backed by several torrents: extra sources, composite file IDs, merged episodes.
- [changelog/0.11.0-multi-tenant-pointer-and-devices.md](changelog/0.11.0-multi-tenant-pointer-and-devices.md) — Multi-tenant pointer server (claim-on-first-push, hardening) and the local Devices dashboard.
- [changelog/0.8.2-shutdown-and-bundle-size.md](changelog/0.8.2-shutdown-and-bundle-size.md) — Fixes the server outliving its supervisor (leaked mDNS socket) and prunes devDependencies from the shipped bundle.
