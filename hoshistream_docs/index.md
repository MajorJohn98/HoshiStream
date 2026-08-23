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

## Guides

- [guides/setup-native-macos.md](guides/setup-native-macos.md) — Build and install the native app, configure `.env`, tune TorrServer, and forward the peer port.
- [guides/adding-media.md](guides/adding-media.md) — Add magnets, `.torrent` files, and local media; inspection and viability.
- [guides/development.md](guides/development.md) — Dev commands, working agreement, and code conventions.
- [guides/troubleshooting.md](guides/troubleshooting.md) — AirPlay port conflict, LAN reachability, stalls, corrupt library.
- [guides/remote-access-cloudflare-tunnel.md](guides/remote-access-cloudflare-tunnel.md) — Cloudflare Tunnel setup and LAN-aware stream URLs.

## API

- [api/management-api-reference.md](api/management-api-reference.md) — Auth, library CRUD, inspection, status, uploads, and token-gated routes.
- [api/addon-protocol.md](api/addon-protocol.md) — Tokenized manifest, catalog/meta/stream routes, IDs, and stream objects.
- [api/torrserver-endpoints-used.md](api/torrserver-endpoints-used.md) — The verified TorrServer endpoint subset and client behavior.

## Plans

- [plans/2026-08-10-project-assessment.md](plans/2026-08-10-project-assessment.md) — Project health assessment: verified checks, risks, next steps.
- [plans/2026-08-12-reliability-plan.md](plans/2026-08-12-reliability-plan.md) — Reliability findings and the seven fixes shipped in 0.3.0.
- [plans/2026-08-12-management-ui-plan.md](plans/2026-08-12-management-ui-plan.md) — Library management & UI improvement plan shipped in 0.4.0.
- [plans/2026-08-12-tunnel-lan-plan.md](plans/2026-08-12-tunnel-lan-plan.md) — Cloudflare Tunnel + LAN-aware stream URL plan shipped in 0.5.0.
- [plans/2026-08-14-performance-and-cross-platform-plan.md](plans/2026-08-14-performance-and-cross-platform-plan.md) — Playback performance, built-in mpv player, and macOS + Windows shipping roadmap.
- [plans/2026-08-14-native-only-plan.md](plans/2026-08-14-native-only-plan.md) — Remove Docker, retarget config to real paths, and the Windows launcher path.
- [plans/desktop-app-strategy.md](plans/desktop-app-strategy.md) — Installed-app strategy: native supervisor, bundled runtimes, ship order.
- [plans/2026-08-23-realtime-transcoding-plan.md](plans/2026-08-23-realtime-transcoding-plan.md) — Opt-in real-time stream repair: pipeline, session model, seek handling, phased rollout.
- [plans/2026-08-23-frontend-redesign-and-transcoding-plan.md](plans/2026-08-23-frontend-redesign-and-transcoding-plan.md) — Preact+htm management UI redesign, transcoding UI surface, and the no-Docker dev loop.

## Changelog

- [changelog/0.1.0-mvp.md](changelog/0.1.0-mvp.md) — Five completed MVP phases, post-MVP additions, known gaps.
- [changelog/0.3.0-reliability.md](changelog/0.3.0-reliability.md) — Git init, host-derived URLs, library recovery, retries, inspection cache, supervisor hardening, sleep prevention.
- [changelog/0.4.0-management-ui.md](changelog/0.4.0-management-ui.md) — UI restructured into static ES modules, Finder linking/relinking, cache-aware detail view, status refresh.
- [changelog/0.5.0-tunnel-lan-detection.md](changelog/0.5.0-tunnel-lan-detection.md) — Cloudflare Tunnel support with LAN-aware stream URLs for at-home clients.
- [changelog/0.7.0-native-only.md](changelog/0.7.0-native-only.md) — Docker removed; native app is the only deployment mode, config retargeted to real paths, TorrServer defaults shipped with the app.
- [changelog/0.6.0-performance.md](changelog/0.6.0-performance.md) — TorrServer throughput tuning, hot-path caching, larger read buffers, stream prewarming, direct-play detection, a built-in mpv player, and Windows vendoring groundwork.
- [changelog/0.8.0-ui-and-stream-repair.md](changelog/0.8.0-ui-and-stream-repair.md) — Preact rebuild + Cinema redesign of the management UI, opt-in stream repair, mDNS LAN discovery, and the in-browser player.
