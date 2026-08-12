# Reliability Plan — Docker + Native App

## Problem
Both deployment modes work but have single points of failure that surface as "Nuvio suddenly can't play anything": stale LAN IPs baked into URLs, a library file whose corruption takes down every route, no retries against TorrServer, a native supervisor that gives up after one crash, and macOS sleep killing playback. The project also still has no git history — any fix is risky without it.

## Ranked findings

1. **LAN IP drift breaks all URLs (both modes).** `PUBLIC_ADDON_URL`/`PUBLIC_TORRSERVER_URL` are static (.env) or captured once at native startup (`lanIp()` in native-server.mjs). A DHCP change silently breaks manifest + stream URLs until manual reconfig/restart.
2. **Library corruption = total outage.** `Library.read()` throws on any parse/validation failure; `/ready`, catalogs, streams, and the management API all fail. Only recovery is hand-editing JSON (documented in README troubleshooting).
3. **No retry against TorrServer.** `TorrServerClient` does one attempt with a 10 s timeout. A transient hiccup returns empty streams to Nuvio, which caches the failure UX.
4. **Slow/fragile stream starts.** Every stream request re-registers the torrent and re-polls metadata (up to 30 s) because TorrServer drops torrents after 5 min idle and nothing is cached. Persisting the inspection result (hash + selected files) per entry makes stream resolution instant and immune to metadata-fetch flakiness.
5. **Native supervisor gives up after one crash.** `restartCount < 1` in HoshiStreamApp.swift → a second crash leaves "Error — see logs" until the user intervenes. Also health check/openLibrary hardcode port 7001, ignoring `ADDON_PORT`.
6. **macOS sleep stops playback.** README says run `caffeinate` manually. The app should hold a power assertion while a stream is active.
7. **No git repository.** Prerequisite for safely making any of these changes.

## Todos

1. `git-init` — Initialize git; verify `.gitignore` excludes `.env`, `build/`, `vendor/`, `native-data/`, `data/`, `addon/dist`, `node_modules`, `.DS_Store`; first commit.
2. `dynamic-public-urls` — Derive the addon's public base URL from the request `Host` header (fallback to configured `PUBLIC_ADDON_URL`), and re-resolve the TorrServer public host from the same request host (same machine in both modes). Native server keeps working when the LAN IP changes without restart. Tests for URL rewriting.
3. `library-backup-recovery` — On every successful write, keep `library.json.bak`. On read failure, log a structured error, fall back to the backup, and quarantine the corrupt file (`library.json.corrupt-<ts>`). `/ready` reports degraded state instead of hard-failing everything.
4. `torrserver-retries` — Add bounded retry with short backoff (e.g. 2 retries, 500 ms/1 s) for idempotent TorrServer calls (`echo`, `get`, `list`, `add` by hash). Keep total time within Nuvio's stream-request patience. Tests with a mocked flaky server.
5. `inspection-cache` — Persist `{hash, selectedFiles, inspectedAt}` on the library entry after successful inspection. Stream requests use the cache and just (re-)add the torrent by magnet/hash without re-polling metadata; invalidate on entry PATCH of source fields or preferredFileIndex/fileOverrides. Cuts stream start from ~30 s worst case to near-instant.
6. `supervisor-restart-backoff` — Native app: allow ~5 restarts with increasing delay (2 s → 30 s), reset counter after sustained health; read `ADDON_PORT` from .env for health check and Open/URL actions instead of hardcoded 7001.
7. `sleep-assertion` — Native app: hold an `IOPMAssertion` (prevent system sleep) while a stream was served recently (addon exposes "last stream activity" via `/api/status`; supervisor polls it and asserts/releases).

## Dependencies
- `git-init` first (safety net for everything else).
- `dynamic-public-urls`, `library-backup-recovery`, `torrserver-retries` are independent.
- `inspection-cache` depends on `torrserver-retries` (touching the same client/inspection path).
- `sleep-assertion` depends on `supervisor-restart-backoff` only in that both edit HoshiStreamApp.swift — do sequentially.

## Notes
- Scope respected: no search, no transcoding, no DB, no dashboard. Inspection cache lives in the existing JSON library.
- Validate per AGENTS.md: `npm run typecheck && npm test && npm run lint && npm run format:check`, plus `docker-compose config -q` (only standalone compose exists on this machine). Swift app rebuild via `packaging/build-macos-app.sh` for items 6–7.
- Docs: record the public-URL and inspection-cache decisions as ADRs; update changelog and API docs afterwards.
