# HoshiStream Documentation Index

## Architecture

- [architecture/architecture-overview.md](architecture/architecture-overview.md) — System diagram, module map, data flow, deployment modes, and state layout.

## Decisions (ADRs)

- [decisions/0001-torrserver-matrix-141-pinning.md](decisions/0001-torrserver-matrix-141-pinning.md) — Pin TorrServer to MatriX.141.1 and use only Swagger-verified endpoints.
- [decisions/0002-disk-cache-over-ram-tiering.md](decisions/0002-disk-cache-over-ram-tiering.md) — Single bounded 2 GiB disk cache instead of RAM + disk tiering.
- [decisions/0003-native-menu-bar-app-no-electron.md](decisions/0003-native-menu-bar-app-no-electron.md) — Syncthing-style native supervisor app; Electron rejected.
- [decisions/0004-token-in-path-and-bearer-security-model.md](decisions/0004-token-in-path-and-bearer-security-model.md) — Path-token add-on URLs, bearer management API, trusted-LAN boundary.
- [decisions/0005-host-header-public-urls.md](decisions/0005-host-header-public-urls.md) — Derive public stream URLs from the request Host header with configured fallback.
- [decisions/0006-inspection-cache-on-entries.md](decisions/0006-inspection-cache-on-entries.md) — Persist inspection results on library entries for instant stream resolution.

## Guides

- [guides/setup-docker.md](guides/setup-docker.md) — Configure `.env` and run the Docker Compose stack.
- [guides/setup-native-macos.md](guides/setup-native-macos.md) — Build and install the native menu-bar app.
- [guides/adding-media.md](guides/adding-media.md) — Add magnets, `.torrent` files, and local media; inspection and viability.
- [guides/development.md](guides/development.md) — Dev commands, working agreement, and code conventions.
- [guides/troubleshooting.md](guides/troubleshooting.md) — AirPlay port conflict, LAN reachability, stalls, corrupt library.

## API

- [api/management-api-reference.md](api/management-api-reference.md) — Auth, library CRUD, inspection, status, uploads, and token-gated routes.
- [api/addon-protocol.md](api/addon-protocol.md) — Tokenized manifest, catalog/meta/stream routes, IDs, and stream objects.
- [api/torrserver-endpoints-used.md](api/torrserver-endpoints-used.md) — The verified TorrServer endpoint subset and client behavior.

## Plans

- [plans/2026-08-10-project-assessment.md](plans/2026-08-10-project-assessment.md) — Project health assessment: verified checks, risks, next steps.
- [plans/2026-08-12-reliability-plan.md](plans/2026-08-12-reliability-plan.md) — Reliability findings and the seven fixes shipped in 0.3.0.
- [plans/desktop-app-strategy.md](plans/desktop-app-strategy.md) — Installed-app strategy: native supervisor, bundled runtimes, ship order.

## Changelog

- [changelog/0.1.0-mvp.md](changelog/0.1.0-mvp.md) — Five completed MVP phases, post-MVP additions, known gaps.
- [changelog/0.3.0-reliability.md](changelog/0.3.0-reliability.md) — Git init, host-derived URLs, library recovery, retries, inspection cache, supervisor hardening, sleep prevention.
