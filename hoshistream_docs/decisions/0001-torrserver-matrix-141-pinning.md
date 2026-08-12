# 0001 — Pin TorrServer to MatriX.141.1 and use only verified endpoints

- **Status:** Accepted
- **Date:** 2026-08-10 (recorded; decision made during MVP phases)

## Context

HoshiStream delegates all torrent handling to TorrServer. TorrServer's API surface varies across releases, and its documentation is the live Swagger document of the running build. Unverified API calls risk silent breakage on image updates.

## Decision

Pin the container image to `ghcr.io/yourok/torrserver:MatriX.141.1` (official Linux arm64 release; Swagger reports API `MatriX.141`). The adapter (`addon/src/torrserver-client.ts`) uses only endpoints verified against that build's Swagger/source:

- `GET /echo` — health/version
- `POST /torrents` with actions `add`, `get`, `list`, `rem`
- `POST /torrent/upload` — `.torrent` file registration
- `GET /play/{hash}/{id}` — direct playback

All responses are parsed with Zod schemas; unexpected shapes fail loudly. Torrents are added with `save_to_db: false` so TorrServer auto-drops them after inactivity.

## Consequences

- Upgrading TorrServer requires re-verifying each endpoint against the new build before bumping the tag (see AGENTS.md working agreement).
- No use of undocumented or version-drifting endpoints.
- The native macOS app pins matching TorrServer binaries via `packaging/torrserver-lock.json`.
