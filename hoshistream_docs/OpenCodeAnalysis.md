# OpenCode Analysis — How HoshiStream Works

A part-by-part walkthrough of the codebase: what each component does, how the pieces connect, and the end-to-end request flows. Written after a full scan of `addon/src`, `supervisor/macos`, `scripts`, and `packaging`. Companion to [architecture/architecture-overview.md](architecture/architecture-overview.md), which covers intent and design rationale; this document focuses on mechanics.

---

## 1. Big picture

HoshiStream is three cooperating processes plus one external service:

```text
┌───────────────────────────── macOS ─────────────────────────────┐
│                                                                 │
│  HoshiStream.app (Swift menu-bar supervisor)                    │
│    │  spawns & supervises, polls health every 2 s               │
│    │  owns Finder picker unix-socket, sleep assertion           │
│    ▼                                                            │
│  node scripts/native-server.mjs   (bundled Node runtime)        │
│    ├── spawns vendored TorrServer (:8090)                       │
│    └── imports addon/dist/index.js  → HTTP server (:7000)       │
│          │                                                      │
│          ▼                                                      │
│     Nuvio clients (LAN / Cloudflare Tunnel) + local web UI      │
└─────────────────────────────────────────────────────────────────┘
```

- **`addon/`** — the product itself: a strict-TypeScript, ESM Node ≥22 server implementing the Stremio add-on protocol (catalog/meta/stream), a bearer-token management API, local-media range serving, and an mpv-driven local player. Runtime dependencies are exactly two: `stremio-addon-sdk` and `zod`.
- **`supervisor/macos/`** — ~470 lines of AppKit Swift: a menu-bar accessory app (`LSUIElement`) that launches and restarts the Node stack, exposes a Finder file-picker socket, keeps the Mac awake during playback, and offers Start-at-Login.
- **`scripts/native-server.mjs`** — the launch shim that turns `.env` + CLI flags into the exact environment the add-on expects, starts TorrServer, then boots the compiled add-on in-process.
- **`packaging/`** — checksum-pinned fetchers and the `.app` bundle builder that vendors Node and TorrServer binaries.
- **No containers anywhere** ([ADR 0009](decisions/0009-native-only-deployment.md)); `config-schema.ts` even warns loudly if a URL still points at Docker-era hostnames (`addon`, `torrserver`).

The add-on never proxies video bytes and never transcodes: torrent playback is a rewritten `http://<mac>:8090/play/<hash>/<id>` URL handed straight to the player; local playback is either the same kind of direct URL (`/local/…`) served by the add-on with byte ranges, or a raw filesystem path handed to mpv.

---

## 2. Configuration (`config-schema.ts`, `config.ts`)

Everything enters through one Zod schema parsed once from `process.env` at import time (`config.ts` is a 3-line module).

| Variable | Default | Notes |
|---|---|---|
| `ADDON_PORT` | `7000` | coerced int, 1–65535 |
| `TORRSERVER_INTERNAL_URL` | required | http(s) only |
| `PUBLIC_TORRSERVER_URL` / `PUBLIC_ADDON_URL` | required | what other devices should use |
| `ACCESS_TOKEN` | required | min length 20 |
| `LIBRARY_PATH` | `<stateRoot>/library.json` | |
| `MEDIA_ROOT` | `~/Movies` | scanned for local media |
| `UPLOAD_ROOT` | `<stateRoot>/media` | browser-upload copies land here |
| `NATIVE_PICKER_SOCKET` | `<stateRoot>/run/supervisor.sock` | Finder bridge |
| `PLAYER` | `auto` | `mpv` \| `iina` \| `vlc` \| `system` |
| `HOME_SPEED_MBPS` | `10` | used by the bitrate viability check |
| `LAN_REDIRECT` | `auto` | `off` disables tunnel→LAN rewriting |

`stateRoot()` computes the per-user data directory per target platform (`~/Library/Application Support/HoshiStream`, `%LOCALAPPDATA%\HoshiStream`, XDG on Linux) using the correct path flavor for that platform regardless of host.

---

## 3. Domain types (`types.ts`)

All boundaries are Zod-validated. A **library entry** requires exactly one source:

- `magnetUri` (`magnet:?…`) or `torrentFilePath` (`*.torrent`) — torrent-backed,
- `localFilePath` / `localFolderPath` (absolute) — locally hosted,
- plus optional `poster`, `background`, `description`, `preferredFileIndex` (TorrServer 1-based file ID), `fileOverrides` (per-file include/season/episode), `managedMedia` (safe-to-delete-on-unlink flag),
- and server-managed state the API strips from client input: `inspectionCache` (hash + selected files + timestamp, persisted per [ADR 0006](decisions/0006-inspection-cache-on-entries.md)), `directPlay` assessment, `playback` resume position, `createdAt`/`updatedAt`.

Derived schemas: `createEntrySchema` (client POST), `patchEntrySchema` (partial, allows nulling description/poster/background).

---

## 4. Library store (`library.ts`)

An in-memory-consistent, crash-safe JSON store — deliberately not a database.

- **Serialized mutations**: every read/write chains off a promise `queue`, so concurrent PATCH/DELETE never interleave.
- **Atomic writes**: temp file (`mode 0600`) → `rename` over the live file → refresh cache → `copyFile` to `library.json.bak`.
- **mtime+size read cache**: repeated catalog/stream requests don't re-parse; `structuredClone` prevents callers from mutating shared state. External edits are picked up because the stat signature changes.
- **Self-healing**: unreadable/corrupt JSON quarantines the file as `library.json.corrupt-<timestamp>` and restores `.bak`; missing file + missing backup = empty library.
- Mutating identity/source fields (`magnetUri`, `localFilePath`, `preferredFileIndex`, …) drops the cached `inspectionCache` and `directPlay`, forcing re-inspection.

---

## 5. TorrServer adapter (`torrserver-client.ts`)

A small typed client pinned to the Swagger-verified subset of TorrServer MatriX.141 ([ADR 0001](decisions/0001-torrserver-matrix-141-pinning.md)):

- `GET /echo` — health/version string.
- `POST /torrents` with action objects: `add` (magnet, `save_to_db:false`), `get`, `list`, `rem`.
- `POST /torrent/upload` — multipart `.torrent` registration.
- `GET /play/{hash}/{id}` — never called server-side; only converted into the public URL handed to players.

Robustness details: every response is Zod-parsed (`file_stats` etc.), requests carry a 10 s `AbortSignal.timeout`, and failures retry 3× with exponential backoff (500 ms base) but **only** on network errors or 5xx — 4xx fails fast. `waitForFiles(hash)` polls `get` every 500 ms up to 30 s until metadata arrives. All TorrServer stdout/stderr lines are magnet-redacted upstream in `native-server.mjs`.

---

## 6. Inspection & stream-source resolution (`inspection.ts`)

The core pipeline that turns a library entry into `(torrent hash, playable files)`:

1. **Local entries**: delegated to `inspectLocalEntry` (§8).
2. **Torrent entries**: register (magnet or upload) → `waitForFiles` → `selectMediaFiles` → persist result onto the entry as `inspectionCache` (failure to persist is logged, non-fatal).
3. **`resolveStreamSource`** (used by stream/meta/playback paths):
   - local → inspect fresh;
   - cached → probe TorrServer with `get(hash)`; only **re-register on miss** (TorrServer restart or inactive-drop), so the hot path costs one cheap lookup;
   - nothing cached → full `inspectEntry`.
4. **`warmStreamSource`**: the meta handler fires this fire-and-forget for movies *before* the user presses play, so the swarm is already connected when the stream request lands. Deduplicated via a `warming` Set.

## 7. Media file selection (`media-file-selection.ts`)

Pure function turning raw file lists into episode-aware selections:

- Playable extensions: `.mp4 .mkv .webm .avi .mov .m4v`.
- `sample`/`trailer` files filtered out (unless that leaves nothing).
- **Movie**: the largest playable file.
- **Series**: parse `S01E02` / `1x02` from filenames; fall back to season 1 + filename order. Overrides (`fileOverrides`: include/exclude, forced season/episode) win over heuristics.
- `preferredFileIndex`, when set, selects exactly one file and throws `MediaSelectionError` if it isn't playable.

---

## 8. Local media hosting (`local-media.ts`)

- **Path containment**: `validateBrowserLocalPath` `realpath`s the candidate and checks containment inside `MEDIA_ROOT` or `UPLOAD_ROOT` via `containsPath` (`relative()`-based, case-correct on Windows — see `path-safety.ts`). Symlink escapes die here.
- **Directory walking** collects playable files; folder entries become series with relative paths as names.
- **TTL inspection cache** (30 s, max 256 entries, keyed by entry + selection signature + root mtime) exists because players issue many range requests per seek and each would otherwise re-walk the tree.
- **Uploads**: `POST /api/upload` streams the body to `UPLOAD_ROOT/<uuid-batch>/<relpath>` with `flags:"wx"` (never overwrites); batch must be a UUID v4 and the destination must pass containment + extension checks; failed writes unlink the partial file. `.torrent` uploads are buffered (1 MB cap) the same way.
- **Managed-media cleanup**: deleting an entry flagged `managedMedia` removes its whole UUID batch directory — but only if the *first segment below* `UPLOAD_ROOT` is a UUID (`firstSegmentBelow` guard), so a mis-set flag can never delete arbitrary folders. Finder-linked media is never deleted.
- **Range serving** (`serveLocalMedia`): RFC 7233 `bytes=` parsing (suffix and open ranges included), 206/200 responses with `accept-ranges`, `TCP_NODELAY`, and a 4 MiB read buffer tuned for video streaming; 416 with `bytes */<size>` on bad ranges.

---

## 9. Stremio add-on surface

- **`manifest.ts`** — id `com.john.private-torrent-streamer`, resources `catalog|meta|stream`, types `movie|series`, `idPrefixes ["hoshi:"]`, `behaviorHints.p2p:true`, two catalogs (`private-movies`, `private-series`) with `search`/`skip` extras.
- **`addon.ts`** — wires the three handlers into `stremio-addon-sdk`'s builder; the rest of the app uses this interface directly (the management API calls `addon.get("catalog",…)` too).
- **`catalog.ts`** — filters by type, substring search (lowercased), newest-`updatedAt` first, pages of 100, emits meta previews (poster shape).
- **`metadata.ts`** — movies return the preview immediately and prewarm in the background; series run a full inspection and synthesize a `videos` list with `hoshi:<id>:<season>:<episode>` IDs so Nuvio shows real episodes.
- **`streams.ts`** — the heart of playback:
  - Parses `hoshi:id:S:E` episode IDs back to (entry, file).
  - **URL strategy** ([ADR 0004]/[ADR 0005]):
    - torrent → internal `http://127.0.0.1:8090/play/…` rewritten onto the public TorrServer origin;
    - local → `{publicAddonUrl}/local/{token}/{entryId}/{fileId}` (token-in-path, like the manifest).
  - `resolvePublicUrls` swaps the hostname from the request's `Host` header onto the configured fallbacks — so whatever address the client used to reach the add-on is reused for the media URLs.
  - `resolveClientAwareUrls` ([ADR 0007]): behind a Cloudflare Tunnel, `cf-connecting-ip` reveals the client's IP; if it equals *this machine's* public IP (looked up via Cloudflare trace, cached 5 min/30 s-fail in `public-ip.ts`), the client is actually at home, so it gets LAN URLs instead of tunnel URLs.
  - Stream objects carry `filename`, `videoSize`, and a `bingeGroup` so Nuvio treats episodes of one entry as a unit, plus a human description ("Torrent • 1.4 GB • May stutter: dts audio…").

---

## 10. HTTP router (`routes.ts`)

One hand-rolled async handler (no framework). Order of matching:

1. `GET /health` — liveness. `GET /ready` — library readable **and** TorrServer `/echo`.
2. Logo asset, `/manage-assets/*` static files (strict regex whitelist `[a-z0-9-]+(.js|.css)` with optional `views/` prefix — traversal-proof), CSP/no-sniff/referrer headers on all HTML.
3. **Tokenized protocol namespace** `/addon/<token>/…`:
   - `manifest.json`,
   - `/(catalog|meta|stream)/(movie|series)/<id>(/<extra>)?.json` — stream responses additionally compute client-aware URLs; everything protocol-ish is sent `cache-control: no-store` so stale catalogs never stick in proxies.
4. Untokenized `/manifest.json` → 401 (deliberate teaching signal).
5. `GET|HEAD /local/<token>/<entryId>[/<fileId>]` — token-checked local streaming with activity marking.
6. `GET /manage/<token>` — the single-page management shell (HTML string in `management.ts`; behavior lives in static ES modules under `addon/assets/manage/`).
7. **`/api/*` — bearer-token management API** (constant-time digest comparison, §11):

| Route | Purpose |
|---|---|
| `GET /api/library` · `POST /api/library` | list / create (handles `nativePathGrant` redemption, browser-path validation, `managedMedia` detection) |
| `GET/PATCH/DELETE /api/library/:id` | CRUD; DELETE also removes managed copies |
| `POST /api/library/:id/inspect[?probe=true]` | force inspection; with probe, runs ffprobe + stores direct-play verdict |
| `POST /api/library/:id/relink` | Finder-relink a moved local entry |
| `POST /api/native-picker/:kind` | open Finder via supervisor socket, mint a 60 s single-use path grant |
| `GET /api/status` | aggregate status incl. `streamingActive` (recent stream activity OR live torrents) |
| `GET /api/stremio-refresh` | catalog counts + last update, for the UI refresh button |
| `POST /api/player/play` / `control` / `GET /api/player/status` | drive mpv/system playback |
| `GET /api/media-files` | browse MEDIA_ROOT |
| `POST /api/upload`, `/api/torrent-upload` | managed-copy ingestion |

Error mapping: `ZodError`/`SyntaxError`/picker/player errors → 400 (picker unavailable → 503), anything else → 500; every failure is structured-logged without secrets. JSON bodies are capped at 1 MB.

---

## 11. Security model (`security.ts`)

- One secret, `ACCESS_TOKEN`, guards everything.
- **Add-on protocol**: token lives in the URL path (`/addon/<token>/…`) because Stremio/Nuvio can't send headers ([ADR 0004]).
- **Management API + local streaming + manage page**: `Authorization: Bearer` (regex-extracted) compared as SHA-256 digests with `timingSafeEqual` — no early-exit leaks.
- Picker grants are 24-byte base64url, single-use, 60-second TTL.
- Upload endpoints require UUID-v4 batches, `wx` flags, containment checks, and size caps.
- The manage page ships a strict CSP (`default-src 'self'`, no inline scripts), `nosniff`, and `referrer-policy: no-referrer`.
- Logs never include tokens, auth headers, or magnet URIs; TorrServer output passes through a magnet redactor with a startup self-test.

---

## 12. Direct-play intelligence (`direct-play.ts`, `media-probe.ts`)

Optional per-entry viability report, produced by shelling out to system `ffprobe` (`-show_entries format/stream`, 45 s timeout) against either the local path or the TorrServer play URL:

- Summarizes container, codecs, dimensions, duration, average bitrate (falls back to size÷duration when the container omits bitrate), and a recommended bandwidth = 1.5× bitrate.
- `assessDirectPlay` classifies **direct / caution / risky** from codec risk tables (risky: DTS/TrueHD/PCM, VC-1, MPEG-2; caution: FLAC/Opus/Vorbis, AV1/VP9) and from link capacity (`HOME_SPEED_MBPS`).
- Stored on the entry and surfaced in stream descriptions ("May stutter: …") and the management UI's playback tab.

---

## 13. Local playback: mpv over JSON IPC (`playback.ts`, `player.ts`, `player-ipc.ts`)

"Play on this computer" ([ADR 0008]):

- **Binary resolution order**: explicit `PLAYER_PATH` → bundled `vendor/mpv/<platform>-<arch>/mpv` → `mpv` on PATH. If none found, `handOffToSystem` opens the URL/path in IINA (via `iina-cli` for proper playlist behavior), VLC, or the OS handler (`open`/`xdg-open`/`cmd /c start`).
- **`Player`** spawns mpv with `--input-ipc-server=<unique socket> --idle=yes` plus torrent-tuned buffering (`--cache-secs=60`, `--demuxer-max-bytes=400MiB`, 30 s readahead), captures stderr into structured logs, and talks line-delimited JSON over a Unix socket (named pipe on Windows).
- **`PlayerIpc`** implements request/response correlation by `request_id`, 5 s command timeouts, event fan-out, and connect retries (40 × 100 ms) to absorb mpv startup latency.
- Series queue the remaining episodes via `loadfile … append`, so playback auto-advances without touching the server.
- **Resume**: `time-pos` property-change events feed `Playback.rememberPosition`, which persists to the library **at most every 15 s** (otherwise every tick would rewrite the JSON); a stored position only applies to the file it was recorded against, and resume seeks only past 10 s.
- Control API maps pause/resume/seek/stop onto IPC commands; `/api/player/status` reports position/duration/pause for the UI.

---

## 14. Native Finder bridge (`native-picker.ts` ⇄ `PickerSocket.swift`)

Lets the web UI pick files outside the sandbox without granting the browser anything:

1. Browser POSTs `/api/native-picker/file|folder` (bearer-authed).
2. Add-on connects to `<stateRoot>/run/supervisor.sock` and sends `{kind, nonce}\n` (120 s timeout, 8 KB cap, nonce echoed back and verified).
3. The Swift supervisor presents a native `NSOpenPanel` (video UTTypes for files, symlink-resolved paths) and replies `{nonce, path}` or `{nonce, cancelled}`.
4. Add-on re-validates (`realpath`, type check, folder-must-contain-video) and mints a short-lived grant the create request later redeems — the browser never learns a real path until creation succeeds.

Socket hardening: 0700 run dir, socket `chmod`ed to owner-only, `SO_NOSIGPIPE`, serialized accepts on a dedicated queue.

---

## 15. Management web UI (`management.ts`, `addon/assets/manage/`)

A dependency-free SPA: `managementHtml` is just a shell; `app.js` exports shared state, a tiny `fetch` wrapper (bearer header from the URL token), HTML escaping, and a view router. Views:

- **Library** (`views/library.js`): grid, search/filter, JSON export (paths stripped, source classified) and reviewed JSON import (`classify-imports.js` flags conflicts).
- **Add Media** (`views/add.js`): four source cards — magnet, `.torrent`, local file, series folder. With the native app running, "Choose with Finder" links media **in place** (no copy); otherwise browser upload copies into managed storage.
- **Detail** (`views/detail.js`): overview/source/files/playback tabs — inspection with file overrides and preferred file, ffprobe technical panel + direct-play verdict, resume info, "Play on this computer", relink-in-Finder.
- **Status** (`views/status.js`): service pills (add-on online, TorrServer version, library count, home speed, streaming indicator, sleep-assertion hint).

---

## 16. Process supervision

### `scripts/native-server.mjs` — the launch shim

Run inside the app bundle (or headless via `start-native.sh`). Boot sequence:

1. Parse `--flag=value` options and the project `.env`; derive ports, `MEDIA_ROOT` (from `MEDIA_DIR`), `UPLOAD_ROOT = <project>/data/media`, library/state paths, and the vendored TorrServer binary path.
2. **Legacy path migration**: a pre-existing Docker-era `library.json` gets `/media/…`, `/data/media/…`, `/data/…` prefixes rewritten to real host paths, written atomically to the state dir.
3. Seed `torrserver/config/settings.json` from `packaging/torrserver-settings.json` (forcing `TorrentsSavePath`), write a PID file.
4. Spawn TorrServer (`--port 8090 --ip 0.0.0.0 --dontkill`), piping its output through the magnet redactor.
5. Wait for `/echo`, export the fully-derived environment (`PUBLIC_*` URLs built from the detected LAN IP — `en0`-preferring private IPv4 from `lan-ip.mjs`), then dynamically `import("addon/dist/index.js")` and call `startHoshiStream()`; wait for `/ready`.
6. **Lifecycle**: SIGINT/SIGTERM/SIGHUP → close add-on, SIGTERM TorrServer (SIGKILL after 5 s), remove PID file. A 2 s **parent watchdog** detects a dead supervisor (ppid change) and tears everything down, preventing orphaned port-holders. If TorrServer dies, the whole shim exits so the Swift layer can restart it with backoff.

### `supervisor/macos/HoshiStreamApp.swift` — the menu-bar app

- Accessory app (no Dock); status line shows `Starting… / Ready • N titles • X Mbps / Recovering… / Error — see logs`.
- Spawns the bundled `runtime/bin/node scripts/native-server.mjs` with stdout/stderr appended to `~/Library/Logs/HoshiStream/server.log`.
- Health loop every 2 s hits bearer-authed `/api/status`; on success resets the restart counter; on exit schedules retries with exponential backoff (2ⁿ seconds, 30 s cap, 5 attempts).
- Holds an `IOPMAssertion` (prevent idle sleep) exactly while `streamingActive` is reported.
- Menu: Open HoshiStream (tokenized manage URL), Copy Stremio URL (builds and *verifies* the LAN manifest URL before copying), Restart Server, Start at Login (`SMAppService`), Show Logs, Quit (graceful: wait ≤7 s for Node, then SIGKILL).
- Hosts the `PickerSocket` described in §14.

---

## 17. Packaging & vendoring (`packaging/`)

- `fetch-node-runtime.mjs` / `fetch-torrserver.mjs` download the binaries declared in `node-lock.json` (v26.3.1) and `torrserver-lock.json` (MatriX.141.1) per platform, **verifying SHA-256**, keeping only the binary. Both darwin-arm64 and win32-x64 targets are pinned (Windows groundwork).
- `build-macos-app.sh`: `tsc` build → assemble `build/HoshiStream.app` (swiftc compile of the two Swift sources — CLT SDK suffices) → copy dist, assets, `node_modules`, vendored binaries → ad-hoc codesign. `Info.plist` gets `HoshiStreamProjectRoot` baked in; notably the script currently hardcodes `DATA_ROOT=/Users/majorjohn/Library/Application Support/HoshiStream`, so the build script needs a tweak for other machines.
- Shipped TorrServer tuning (`torrserver-settings.json`): 4 GiB disk-backed cache (`UseDisk:true`), 40% preload, 75% readahead, 200 connections, 600 s disconnect timeout, `RemoveCacheOnDrop`, UPnP/Rutor/Torznab search disabled. (The README still quotes older 2 GiB/25-conn/5-min numbers — `packaging/torrserver-settings.json` is what actually ships.)

### Dev/utility scripts (`scripts/`)

- `start-native.sh` / `stop-native.sh` — headless run via PID file in `$HOSHISTREAM_STATE_DIR`.
- `healthcheck.sh` — curl `/health` + TorrServer root.
- `find-lan-ip.sh`, `lan-ip.mjs` — private-IPv4 discovery (en0 preferred) for configuring `PUBLIC_*` URLs.

---

## 18. Tests & quality gates

- **Vitest**, one test file per source module in `addon/tests/` (22 files), including edge cases like path containment, range parsing, episode-ID parsing, library recovery, and log redaction.
- `torrserver.integration.test.ts` is opt-in (`TORRSERVER_TEST_URL=… npm test`) and touches only health/list — no downloads.
- Gates (all must pass per AGENTS.md): `npm run typecheck` (strict TS), `npm test`, `npm run lint` (flat ESLint + typescript-eslint), `npm run format:check` (Prettier).

---

## 19. End-to-end flows

**Install & watch on TV**
```
Nuvio → GET /addon/<token>/manifest.json        → manifest (401 without token)
Nuvio → GET .../catalog/series/private-series.json → metas from library.json
Nuvio → GET .../meta/series/hoshi:<id>.json     → videos list (full inspection, cached)
Nuvio → GET .../stream/series/hoshi:<id>:1:2.json
        ├─ Host header → public URLs (tunnel-aware via cf-connecting-ip)
        ├─ resolveStreamSource: cache hit → get(hash) only; miss → re-register
        └─ { url: "http://<mac>:8090/play/<hash>/<id>" }  ← Nuvio plays directly
```

**Inspect + probe (management UI)**
```
UI → POST /api/library/<id>/inspect?probe=true
      ├─ register + waitForFiles (or local walk)
      ├─ selectMediaFiles → persisted inspectionCache
      ├─ ffprobe on selected file → assessDirectPlay → setDirectPlay
      └─ { files, selectedFiles, technical, directPlay, homeSpeedMbps }
```

**Play on this Mac**
```
UI → POST /api/player/play {entryId}
      ├─ resolveTarget: local path or TorrServer play URL (+ episode queue)
      ├─ ensurePlayer: find mpv → spawn with unique IPC socket
      ├─ loadfile (+ queued episodes) → seek to stored position (>10 s)
      └─ time-pos events → throttled setPlayback (15 s) → resume next time
```

**Finder add**
```
UI → POST /api/native-picker/folder → unix socket → NSOpenPanel
   ← {grant} (single-use, 60 s)
UI → POST /api/library {..., nativePathGrant}
      ├─ redeem grant → localFolderPath (validated)
      └─ library.create → entry linked in place, managedMedia=false
```

---

## 20. Invariants worth remembering

- Direct-play only: no transcoding, no proxying of video bytes, no torrent search, no database, no dashboard backend beyond the manage UI, no containers — by explicit decision records.
- One token protects three channels (path, bearer, local-stream path); comparisons are constant-time.
- Every write to `library.json` is atomic + backed up; every external input is Zod-parsed.
- Deleting media is doubly guarded (`managedMedia` flag **and** UUID-batch containment).
- Structured JSON logs everywhere, secrets/magnets never logged — enforced even for third-party TorrServer output.
