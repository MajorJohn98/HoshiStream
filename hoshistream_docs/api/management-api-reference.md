# Management API Reference

Verified against `addon/src/routes.ts` and `addon/src/types.ts`.

## Authentication

Every `/api/*` route requires `Authorization: Bearer <ACCESS_TOKEN>`; anything else returns `401 {"error":"Unauthorized"}`. Tokens are compared in constant time. The management page and local streaming use the token in the URL path instead.

JSON request bodies are limited to 1 MB. Validation errors return `400` with a message; picker unavailability returns `503`.

## Health

| Method & path | Auth | Response |
|---|---|---|
| `GET /health` | none | `200 {"status":"ok"}` — process alive |
| `GET /ready` | none | `200 {"status":"ready"}` — library readable and TorrServer `/echo` OK |

## Library

Entry IDs use the `hoshi:` prefix and must be URL-encoded in paths (`hoshi%3A...`).

| Method & path | Description |
|---|---|
| `GET /api/library` | List all entries |
| `POST /api/library` | Create entry → `201` with the entry |
| `GET /api/library/{id}` | Fetch one entry (404 if missing) |
| `PATCH /api/library/{id}` | Partial update → `200` with the entry |
| `DELETE /api/library/{id}` | Remove entry (also deletes managed-upload media) → `204` |
| `POST /api/library/{id}/inspect` | Register with TorrServer, poll metadata, return files and selection |
| `POST /api/library/{id}/relink` | Native Finder re-pick for a local entry (native app only) |
| `POST /api/player/play` | Start host playback of an entry → `{mode, title, resumedAt?}` |
| `POST /api/player/control` | `pause`, `resume`, `seek` (with `value` in seconds), or `stop` |
| `GET /api/player/status` | Current player state plus `available` |
| `GET /api/clients` | Recent clients (in-memory): `{ip, device, hostname?, name?, firstSeen, lastSeen, requests, lastResource}` |
| `POST /api/clients/name` | Assign a device name: `{ip, name}`; empty name clears it |
| `GET /api/playback` | Live TorrServer sessions: speeds, peers/seeders, progress |
| `GET /api/pointer/status` | Local pointer state: manifest URL, last push, staleness |
| `GET /api/pointer/remote` | Server-side pointer record health (reachable, registered, expiry) |
| `POST /api/pointer/push` | Push the current LAN base URL + manifest to the pointer server |
| `POST /api/pointer/remove` | Delete the pointer record on the pointer server |

### Entry fields (create)

Exactly one source is required: `magnetUri` (must start `magnet:?`), `torrentFilePath` (must end `.torrent`), `localFilePath`, or `localFolderPath` (absolute paths).

| Field | Type | Notes |
|---|---|---|
| `type` | `"movie" \| "series"` | required |
| `name` | string | required |
| `description` | string | optional; nullable on PATCH |
| `poster`, `background` | URL | optional; nullable on PATCH |
| `preferredFileIndex` | int ≥ 0 | force a TorrServer file ID |
| `fileOverrides` | `[{id, included, season?, episode?}]` | per-file include/episode mapping (primary source's own IDs) |
| `extraSources` | `[{magnetUri?\|torrentFilePath?, seasonHint?, fileOverrides?}]` | additional torrents merged into a torrent-backed **series**; rejected on movies and local entries |
| `nativePathGrant` | string | POST only; redeems a native-picker grant into a local path |

`managedMedia` is server-controlled and stripped from client input. Browser-supplied local paths are validated server-side; `id`, `createdAt`, `updatedAt` are server-generated.

### Inspection response

Returns the TorrServer registration (`hash`, `files`, `selectedFiles`) plus `homeSpeedMbps`. Add `?probe=true` to include `technical` (resolution, codecs, duration, average bitrate, recommended speed with 50% headroom); probe failures return `technical: {"error": ...}`. Inspection may take up to 30 s; file IDs are TorrServer's one-based IDs.

Multi-torrent series: every source is inspected and the episode lists merge. File IDs become composite — `sourceIndex × 100000 + torrServerFileId` (the primary source keeps raw IDs) — and files from extra sources carry their own `hash`. A file's name parsing wins over the source's `seasonHint`; on duplicate (season, episode) claims the later source wins. Changing `extraSources` clears the inspection cache.

A successful probe also returns `directPlay` and persists it on the library entry:

```json
{
  "container": "matroska",
  "videoCodec": "h264",
  "audioCodec": "dts",
  "width": 1920,
  "height": 1080,
  "bitrateMbps": 14.7,
  "compatibility": "risky",
  "warnings": ["dts audio is often software-decoded and is the most common cause of stutter"],
  "probedAt": "2026-08-14T17:33:33.965Z"
}
```

`compatibility` is `direct`, `caution`, or `risky`. It reflects codec support on typical TV players plus a link-capacity check against `HOME_SPEED_MBPS`, and is cleared whenever the source or file selection changes. Non-`direct` verdicts are appended to the Stremio stream description so they are visible at selection time. Direct play is never re-encoded; when stream repair is enabled (ADR 0010), non-direct verdicts additionally trigger a "Compatible" stream (see the add-on protocol reference). Entries also accept a `forceTranscode` boolean via `PATCH`, which always offers the Compatible stream.

## Stream repair sessions

Available only when `TRANSCODE_ENABLED=true`; the UI's "Stream Repair" view is built on these.

| Method & path | Description |
|---|---|
| `GET /api/transcode/sessions` | Active repair sessions: `{entryId, fileId, variant, tier, startedAt, lastAccess, state}` with `state` of `running`, `finished` (encode done, still serving), or `failed` |
| `DELETE /api/transcode/sessions/{entryId}/{fileId}` | Stop every session variant for that file and delete its segments → `204` (`404` when none) |

## Status and utilities

| Method & path | Description |
|---|---|
| `GET /api/status` | Add-on status, TorrServer `{online, version}`, `libraryCount`, `homeSpeedMbps` (measured link speed when available, else the configured fallback), `speed {mbps, source, measuredAt}`, `nativePicker` (supervisor socket present, so Finder pickers work), `streamingActive` (recent stream activity or active TorrServer torrents), `uptimeSeconds`, `transcode {enabled, activeSessions, videoEncoder}` |
| `POST /api/speedtest` | Measure download speed against Cloudflare's open speed-test endpoint (~8 s) → `{mbps, measuredAt, source}`; also runs once at startup. The result replaces `HOME_SPEED_MBPS` in all direct-play guidance until the next run |
| `GET /api/resources` | Resource usage: per-group process stats (`addon`, `torrServer`, `ffmpeg` repair sessions — CPU %, RSS bytes, process count; `available:false` where `ps` is missing) plus disk usage of the torrent cache, stream-repair sessions, and managed uploads (15 s cache) |
| `POST /api/stremio-refresh` | Recount catalogs → `{movies, series, total, updatedAt}` (no-store) |
| `GET /api/media-files` | List files available under the read-only media mount |
| `POST /api/upload?batch=&path=` | Browser upload of a video into managed storage → `204` |
| `POST /api/torrent-upload?batch=&name=` | Upload a `.torrent` → `201 {"path": ...}` |
| `POST /api/native-picker/{file\|folder}` | Open a native Finder picker; returns a grant (native app only) |

## Non-API token-gated routes

| Method & path | Description |
|---|---|
| `GET /manage/{token}` | Management page shell (HTML, CSP `script-src 'self'; style-src 'self'`) |
| `GET /manage-assets/{file}` | Static UI modules and stylesheet from `addon/assets/manage/` (public, whitelisted names only, cached 5 min) |
| `GET\|HEAD /local/{token}/{entryId}[/{fileId}]` | Range-capable local media streaming |
| `GET\|HEAD /hls/{token}/{entryId}/{fileId}/{auto\|video}/{asset}` | Stream-repair HLS session assets (`index.m3u8`, `init.mp4`, `seg-N.m4s`); the first playlist request starts the ffmpeg session lazily, and sessions are reaped 60 s after requests stop |
| `GET /assets/hoshistream-logo.png` | Logo (public, cached 1 day) |


## Host playback

These endpoints play a library entry on the machine running HoshiStream, so no add-on
client is needed to watch locally. See [ADR 0008](../decisions/0008-bundled-mpv-player-over-json-ipc.md).

`POST /api/player/play` takes `{"entryId": "hoshi:…", "fileId": 3}`; `fileId` is optional
and defaults to the first selected file. It returns:

```json
{ "mode": "mpv", "title": "S01E01.mkv", "resumedAt": 63.5 }
```

`mode` is `mpv` when HoshiStream controls playback, or `system` when no mpv binary could
be resolved and the target was handed to the OS default handler — in that case the control
and status endpoints cannot report anything. `resumedAt` is present when playback resumed
from a stored position.

The binary is resolved from `PLAYER_PATH`, then a bundled
`vendor/mpv/<platform>-<arch>/mpv`, then `mpv` on `PATH`. `GET /api/player/status` reports
`available: false` when none is found.

Local entries are passed to the player as a filesystem path, so host playback never goes
through HTTP. Torrent entries use the TorrServer `/play` URL with a larger demuxer buffer.

Playback position is observed and written back to the entry as `playback.positionSeconds`,
throttled to at most one write every 15 seconds, and used to resume on the next play.

Errors return `400` with the reason, for example `{"error": "Unknown library entry"}` or
`{"error": "Player is not running"}`.
