# HoshiStream — Project Assessment

## What it is
Private, local-first Stremio/Nuvio add-on (Node 22 + TypeScript) that fronts TorrServer (MatriX.141.1) for direct-play of personally authorized media. Two deployment modes: Docker Compose stack, and a native macOS menu-bar app (Swift supervisor + bundled Node/TorrServer runtimes).

## Verified health (run 2026-08-10)
| Check | Result |
|---|---|
| `npm run typecheck` | ✅ clean |
| `npm test` (vitest) | ✅ 30 passed, 1 skipped (TorrServer integration, opt-in) |
| `npm run lint` (eslint) | ✅ clean |
| `npm run format:check` (prettier) | ✅ clean |
| `docker-compose config -q` | ✅ valid (note: `docker compose` plugin absent on this machine; only standalone `docker-compose` works) |
| `npm audit --omit=dev` | ✅ 0 vulnerabilities (2 runtime deps: stremio-addon-sdk, zod; pinned overrides for path-to-regexp/tmp) |

## Code shape
- `addon/src`: ~1,800 LOC across 20 modules (routes, library, torrserver-client, streams, catalog, management, security, media-probe, local-media, native-picker…). Clean separation; 14 test files mirror modules.
- `supervisor/macos`: small Swift menu-bar app (HoshiStreamApp.swift, PickerSocket.swift).
- `packaging/`: lockfile-pinned Node + TorrServer fetch scripts and app build script.
- Compose: mem/cpu limits, healthchecks, log rotation, read-only media mount — matches README claims.
- README and AGENTS.md are detailed and consistent with observed layout; TorrServer endpoints documented against verified Swagger (per working agreement).

## Status vs plan
All five MVP phases complete per README. Desktop-app strategy doc defines the post-MVP direction (macOS → Intel → Windows → Linux); macOS phase appears built (`build/HoshiStream.app` exists).

## Findings / risks
1. **No git repository.** A `.gitignore` exists but the folder is not version-controlled — the biggest project risk (no history, no backup, no diff safety).
2. **Committed-in-tree artifacts:** `build/` (400 MB), `vendor/` (207 MB), `native-data/` (logs + library state), `dist/` under `addon/`, `.env` with real secrets, `.DS_Store`. If/when git is initialized, `.gitignore` coverage must be confirmed before first commit.
3. **`docker compose` plugin missing locally** — README uses `docker compose`; only `docker-compose` works here (README already mentions this fallback).
4. **Untested live playback** on Mac/webOS acknowledged in README as remaining validation.
5. Minor: `img/` holds loose ChatGPT PNGs; `dist/` is checked into the source tree alongside `src/`.

## Overall verdict
Healthy, disciplined MVP: all quality gates green, scope discipline respected (no search/transcoding/DB/dashboard), security posture documented and consistent. Main gap is operational, not code: absence of version control and large binary/state artifacts living in the project folder.

## Suggested next steps (not started)
- Initialize git; verify `.gitignore` excludes `.env`, `build/`, `vendor/`, `native-data/`, `data/`, `addon/dist`, `.DS_Store` before first commit.
- Perform the outstanding live playback validation with authorized media.
