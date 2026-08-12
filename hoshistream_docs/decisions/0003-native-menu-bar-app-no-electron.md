# 0003 — Native menu-bar supervisor app, not Electron

- **Status:** Accepted
- **Date:** 2026-08-10 (recorded; strategy in `../plans/desktop-app-strategy.md`)

## Context

The Docker Compose stack works but requires Docker Desktop/Colima. A friendlier install should require no Docker and no separately installed Node.js, while keeping the existing web management UI.

## Decision

Follow a Syncthing-style model: a small platform-native menu-bar/tray app (Swift on macOS, `supervisor/macos`) supervises two child processes — the HoshiStream Node daemon (bundled Node runtime) and a native TorrServer sidecar binary. The web UI remains the primary management surface, opened in the default browser. Electron is rejected.

Runtimes are fetched and pinned by `packaging/fetch-node-runtime.mjs` and `packaging/fetch-torrserver.mjs` with lockfiles; `packaging/build-macos-app.sh` assembles `HoshiStream.app`.

Ship order: macOS Apple Silicon → macOS Intel → Windows x64 → Linux x64 → others only after TorrServer binaries are verified.

## Consequences

- No Electron footprint or duplicated UI; one management page for both deployment modes.
- Native Finder file/folder pickers reach the daemon over a local Unix socket (`NATIVE_PICKER_SOCKET`), so original media is linked without copying.
- The daemon and its modules stay shared between Docker and native modes; `addon/src/index.ts` remains a thin entry point.
- First release excludes auto-update, App Store distribution, Windows service, and Linux daemon.
