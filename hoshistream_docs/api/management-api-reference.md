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
| `POST /api/library` | Create entry → `201` with the entry; optional `idempotencyKey` UUID enables same-request replay → `200` |
| `GET /api/library/{id}` | Fetch one entry (404 if missing) |
| `PATCH /api/library/{id}` | Partial update → `200` with the entry |
| `DELETE /api/library/{id}` | Remove entry (also deletes managed-upload media) → `204` |
| `PUT /api/library/{id}/playback` | Record the resume point from the in-browser player: `{positionSeconds, fileId?}` → `200` playback state, stamped `source: "browser"`. Host mpv playback writes the same field with `source: "host"`; external Stremio clients never write it (they only touch `lastStreamedAt`) |
| `DELETE /api/library/{id}/playback` | Clear the resume point (a finished movie) → `204` |
| `POST /api/library/{id}/inspect` | Register with TorrServer, poll metadata, return files and selection |
| `POST /api/library/{id}/relink` | Native Finder re-pick for a local entry (native app only) |
| `POST /api/player/play` | Start host playback of an entry → `{mode, title, resumedAt?}` |
| `POST /api/player/control` | `pause`, `resume`, `seek` (with `value` in seconds), or `stop` |
| `GET /api/player/status` | Current player state plus `available` |
| `GET /api/clients` | Recent clients (in-memory): `{ip, device, hostname?, name?, firstSeen, lastSeen, requests, lastResource}` |
| `POST /api/clients/name` | Assign a device name: `{ip, name}`; empty name clears it |
| `GET /api/playback` | Live TorrServer sessions: speeds, peers/seeders, progress, plus `entryId` (when the hash maps to a library entry) and `activity` — `streaming` (a client requested this entry's stream in the last 5 min), `downloading` (the archiver is copying it), `inspecting` (metadata read in the last 2 min), or `idle`. A "working" torrent is not necessarily being watched |
| `GET /api/pointer/status` | Local pointer state: manifest URL, last push, staleness |
| `GET /api/pointer/remote` | Server-side pointer record health (reachable, registered, expiry) |
| `POST /api/pointer/push` | Push the current LAN base URL + manifest to the pointer server |
| `POST /api/pointer/remove` | Delete the pointer record on the pointer server |

### Onboarding

`GET /api/onboarding` returns `{state,hasMedia,addonUrl,loopbackOnly,observedClient}`.
`state` is `{version:1,status,client,clientConfirmed,welcomePending}`. Status is
`active`, `dismissed`, or `complete`; client is `nuvio` or `stremio`.

`POST /api/onboarding` accepts one action:
`select-client` with `client`, `confirm-client` with the expected `client`,
`welcome-shown`, `dismiss`, `resume`, or `finish`. Finishing requires actual
library content plus explicit client confirmation. Changing player clears that
confirmation. Neither endpoint creates media or configures an external client.

Both endpoints require the management bearer token and return no-store responses.
The add-on URL contains the access token and must not be logged or sent to third
parties. `observedClient` reports only a recognized recent player name; it is not
used as proof of successful installation or playback.

### Manual import drafts and series imports

These endpoints share the bearer-token gate and return `Cache-Control: no-store`.
They accept manually supplied sources and perform no indexer or website searches.

| Method & path | Contract |
|---|---|
| `GET /api/imports/capabilities` | `{version:1,maxTorrentBytes:1000000}` |
| `GET /api/imports/series` | Eligible targets as `{entries:[{id,name,inspected,sourceCount}]}` |
| `POST /api/imports/magnet-links` | `{magnetUri}` -> opaque `{id,expiresAt}` for native Add Media handoff |
| `GET /api/imports/magnet-links/{id}` | `{id,expiresAt,magnetUri,suggestedName?}`; `410` if expired/missing |
| `POST /api/imports/prepare` | `{magnetUri}` -> draft |
| `POST /api/imports/prepare-torrent` | Raw torrent bytes, at most 1 MB -> draft |
| `DELETE /api/imports/drafts/{draftId}` | Discard an unused draft -> `204` |
| `POST /api/imports/commit` | `{draftId,name,type,tags?,idempotencyKey}` -> `{entry,outcome:"created"|"existing"}` |
| `POST /api/imports/series-preview` | `{draftId,entryId,seasonHint?}` -> `{previewId,expiresAt,entryId,entryName,addedEpisodes,replacements}` |
| `POST /api/imports/series-commit` | `{previewId,idempotencyKey,allowReplace}` -> `{entry,outcome:"appended"|"existing"}` |
| `DELETE /api/imports/previews/{previewId}` | Discard an unused preview -> `204` |

A draft is `{draftId,expiresAt,hash,suggestedName?,existingEntries:[{id,name,type}]}`.
It contains no client-visible local path. Preparation validates supplied data
without scraping sites or fetching an arbitrary source URL. Drafts and previews
are bounded/expiring; cancellation only reclaims uncommitted owned metadata.

Native magnet-link tickets are separate from import drafts: at most 32 are kept
in memory for ten minutes and cleared on shutdown. Repeated identical links
reuse the live ticket. Issuing/reading a ticket performs no torrent resolution or
library mutation. The browser receives the magnet only through an authenticated,
no-store API read; the management fragment contains only `#/add/magnet/{id}`.

Retry confirmation with the **same body and idempotency key**. Durable receipts
are checked before requiring the in-memory draft, allowing recovery after a lost
response or restart. Different input under the same key conflicts. Content-hash
deduplication prevents duplicate sources.

Added episodes contain `{season,episode,path}`; replacements contain
`{season,episode,previousPath,incomingPath}`. Preview can contact TorrServer/peers
to inspect metadata; preparation and ordinary save do not start playback.

Legacy `searchImport` and `searchReceipts` remain readable for existing entries;
the removed `/api/search/*` endpoints are no longer available. Source identity
and ownership are server-controlled, not browser-supplied paths or flags.

Series confirmation rechecks the target's source revision inside the serialized
library mutation. Stale previews, missing required inspection and unconfirmed
overlaps are explicit errors, not silent updates. Durable append receipts are
checked before requiring an in-memory preview, so successful retries survive a
restart. A different confirmation body under the same key conflicts.

### Source checks

Manual create retries must reuse the same body and `idempotencyKey`. Receipt
lookup happens before consuming a native-picker grant or revalidating uploaded
paths. Reusing a key with different input returns `409`. Interactive clients keep
completed upload paths and per-file progress across save retries.

Source checks use the same bearer-token gate and return `Cache-Control: no-store`.
They are separate from create/import: clients may save without checking. The
interactive UI opts into a check after new saves by default.

| Method & path | Contract |
|---|---|
| `POST /api/library/{id}/check` | `{probe?: boolean, fileId?: number, mode?: "basic" \| "extended"}`; defaults to a basic bounded probe; returns `202` with a check report |
| `GET /api/library/{id}/check` | Current report, or `phase: "unchecked"` for the current source |
| `DELETE /api/library/{id}/check` | Cancel the active check without removing the entry; returns the report |

Reports include `entryId`, `phase`, `message` and, where applicable, `jobId`,
`revision`, `probe`, `mode`, `stage`, `outcome`, `updatedAt`, `code`, `fileId`,
`sourceHash`, `filePath`, `fileLength`, `checkedFiles`, `totalFiles`, `technical`
and `browserSupport` (`likely`, `limited`, `unknown`). Active phases
are `queued`, `inspecting`, `probing`; terminal phases are `complete`, `failed`,
`cancelled`, `interrupted`.

One check runs at a time, with up to 32 active/queued entries. Identical concurrent
requests coalesce; conflicting options, including different modes, return `409`.
Basic checks have a 60-second overall deadline and a 20-second probe budget.
An explicitly requested extended check has a 180-second total deadline. No
automatic escalation occurs. Cancellation drains the active operation before
another probe can take its slot.

Job completion is not a universal success verdict. `outcome` distinguishes
`observed`, `inconclusive`, `invalid`, and `unavailable`; a completed attempt can
be inconclusive because metadata or a sample did not arrive within its budget.
`stage` identifies metadata versus sample work. A readable sample requires
`technical.decodedVideoFrames > 0`, not merely a codec name. `probe: false`
establishes metadata only. Older reports without this evidence remain historical.

Technical data can include `containerAliases`, `videoProfile`, `videoLevel`,
`pixelFormat`, `videoTag`, `audioCodecs`, and `audioTracks`, alongside duration,
resolution and bitrate. Demuxer aliases are not proof of browser container
support. No result guarantees all files, future availability, or a browser's
ability to reach or decode its returned stream URL.

`sourceCheck` and `mediaFacts` are server-owned. `mediaFacts` retains successful
file-scoped observations with source revision, job ID, identity, technical data
and `observedAt`. A transient failed/inconclusive retry keeps old technical facts,
but the latest attempt still reports its own outcome. Source/selection changes
invalidate evidence; stale jobs
cannot overwrite new source state. Unfinished checks are marked interrupted on
restart rather than automatically resumed.

### Tags

Genre-style labels kept in a registry (`tags.json`, seeded with the TMDB/IMDb genre set on first run). Entries store tag **names**; renames and deletions cascade to every entry. Names are trimmed, ≤ 40 characters, and unique case-insensitively.

| Method & path | Description |
|---|---|
| `GET /api/tags` | `{tags: [{name, count}]}` — every registered tag with how many entries carry it |
| `POST /api/tags` | `{name}` → `201 {name}`; `400` if a tag with that name (any case) exists |
| `PATCH /api/tags/{name}` | `{name}` → rename; returns `{name, entries}` with the number of entries updated |
| `DELETE /api/tags/{name}` | Remove the tag and strip it from entries → `{name, entries}` |

### Entry fields (create)

Exactly one source is required: `magnetUri` (must start `magnet:?`), `torrentFilePath` (must end `.torrent`), `localFilePath`, or `localFolderPath` (absolute paths).

| Field | Type | Notes |
|---|---|---|
| `type` | `"movie" \| "series"` | required |
| `name` | string | required |
| `description` | string | optional; nullable on PATCH |
| `poster`, `background` | URL | optional; nullable on PATCH |
| `tags` | `string[]` | optional, ≤ 32; stored with the registry's spelling and unknown names are registered on the fly; `null` on PATCH clears all tags |
| `preferredFileIndex` | int ≥ 0 | force a TorrServer file ID |
| `fileOverrides` | `[{id, included, season?, episode?}]` | per-file include/episode mapping (primary source's own IDs) |
| `extraSources` | `[{magnetUri?\|torrentFilePath?, seasonHint?, fileOverrides?}]` | additional torrents merged into a torrent-backed **series**; rejected on movies and local entries |
| `nativePathGrant` | string | POST only; redeems a native-picker grant into a local path |

`managedMedia` is server-controlled and stripped from client input. Browser-supplied local paths are validated server-side; `id`, `createdAt`, `updatedAt` are server-generated.

### Inspection response

Returns the TorrServer registration (`hash`, `files`, `selectedFiles`) plus
`homeSpeedMbps`. Add `?probe=true` for bounded technical analysis through the same
coordinator as source checks; the legacy response keeps `technical` and its error
shape. Plain metadata inspection allows up to 30 seconds per source. File IDs
are TorrServer's returned one-based IDs.

Multi-torrent series: every source is inspected and the episode lists merge. File IDs become composite — `sourceIndex × 100000 + torrServerFileId` (the primary source keeps raw IDs) — and files from extra sources carry their own `hash`. A file's name parsing wins over the source's `seasonHint`; on duplicate (season, episode) claims the later source wins. Changing `extraSources` clears the inspection cache.

A successful sampled probe also returns representative `directPlay` advice.
File-specific stream consumers use matching `mediaFacts`, not an unscoped verdict
from a different episode:

```json
{
  "container": "matroska",
  "videoCodec": "h264",
  "audioCodec": "dts",
  "width": 1920,
  "height": 1080,
  "bitrateMbps": 14.7,
  "compatibility": "risky",
  "warnings": ["dts audio support depends on the player; this does not measure torrent availability"],
  "probedAt": "2026-08-14T17:33:33.965Z"
}
```

`compatibility` is `direct`, `caution`, `risky`, or `unknown`. It is support advice,
not proof of torrent availability, and incomplete metadata is never `direct`.
The browser hint separately accounts for available container/profile/pixel-format
information. `HOME_SPEED_MBPS` and the host speed test do not affect the grade.

Scoped support warnings can appear in Stremio stream descriptions. Direct play
is never re-encoded. Existing stream repair, only when enabled, uses matching
file codec facts and its existing repair policy; it is not enabled merely by an
inconclusive check. Entries also accept `forceTranscode` via `PATCH`, preserving
the explicit Compatible-stream override.

## Stream repair sessions

Available only when `TRANSCODE_ENABLED=true`; the UI's "Stream Repair" view is built on these.

| Method & path | Description |
|---|---|
| `GET /api/transcode/sessions` | Active repair sessions: `{entryId, fileId, variant, tier, startedAt, lastAccess, state}` with `state` of `running`, `finished` (encode done, still serving), or `failed` |
| `DELETE /api/transcode/sessions/{entryId}/{fileId}` | Stop every session variant for that file and delete its segments → `204` (`404` when none) |

## Status and utilities

| Method & path | Description |
|---|---|
| `GET /api/status` | Add-on status, TorrServer `{online, version}`, `libraryCount`, `homeSpeedMbps` (measured link speed when available, else the configured fallback), `speed {mbps, source, measuredAt}`, `nativePicker` (supervisor socket present, so Finder pickers work), `streamingActive` (a client requested a stream in the last 5 min; archiver and inspection traffic do not count), `uptimeSeconds`, `transcode {enabled, activeSessions, videoEncoder}` |
| `POST /api/speedtest` | Measure host Internet download speed against Cloudflare's open endpoint (~8 s) → `{mbps, measuredAt, source}`; also runs at startup. Advisory only: not swarm speed, client Wi-Fi, remote upload capacity, or a viability verdict |
| `GET\|POST\|DELETE /api/analysis` | Library-wide bounded analysis through the shared check coordinator. `POST {force?}` checks entries without a current-revision check attempt (`force` explicitly rechecks all, including failed/inconclusive attempts; `409` while active/draining); `DELETE` cancels active work as well as scheduling; `GET` reports `{running, total, done, current, failed[], startedAt, finishedAt, cancelled}` |
| `GET /api/resources` | Resource usage: per-group process stats (`addon`, `torrServer`, `ffmpeg` repair sessions — CPU %, RSS bytes, process count; `available:false` where `ps` is missing) plus disk usage of the torrent cache, stream-repair sessions, and managed uploads (15 s cache) |
| `POST /api/stremio-refresh` | Recount catalogs → `{movies, series, total, updatedAt}` (no-store) |
| `GET /api/media-files` | List files available under the read-only media mount |
| `POST /api/upload?batch=&path=` | Browser upload of a video into managed storage → `201 {"path": ..., "folderRoot": ...}`; identical same-path retries are accepted, conflicting content returns `409` |
| `POST /api/torrent-upload?batch=&name=` | Upload a `.torrent` → `201 {"path": ...}` |
| `POST /api/native-picker/{file\|folder}` | Open a native Finder picker; returns a grant (native app only) |

## Storage volumes

Registered storage locations for the disk library (see the disk library
plan). A volume is identified by a `.hoshistream-volume.json` marker written
at its root — never by mount path or drive name — so an external drive is
recognized even when it remounts under a new name, and a look-alike drive is
never trusted.

| Method & path | Description |
|---|---|
| `GET /api/volumes` | `{volumes: [...]}` — each with `id`, `label`, `state` (`online\|offline\|ambiguous\|permission-denied`), `createdAt`, and, when online, `root`, `freeBytes`, `totalBytes`. Also sweeps deferred disk-copy deletions for volumes that just came back online |
| `POST /api/volumes` | Open the native folder picker and register the chosen folder (writes the marker, verifies it, persists the registry) → `201` volume status. Idempotent: an already-registered folder returns the existing volume; a valid foreign marker is adopted under its original id. Overlapping an existing volume root is a `400` |
| `DELETE /api/volumes/{id}` | Forget a volume → `204`. The marker and any media on the drive are left untouched |

## Disk copies

Per-entry "keep on disk" intent (torrent-backed entries only). The entry's
`diskCopy` records desired placement and a durable per-file manifest keyed by
`"<torrent-hash>:<raw-file-id>"`; transfer progress is runtime-only. Deleting
a library entry also removes its disk copy directory, deferred via a
tombstone when the drive is offline.

| Method & path | Description |
|---|---|
| `PUT /api/library/{id}/disk-copy` | Set intent: `{enabled, volumeId?, scope?, includedSourceKeys?, deleteFiles?}`. Enabling inspects the torrent if needed, builds the manifest (`scope: "all"` archives every selected file and tracks changes; `"selected"` freezes intent to `includedSourceKeys`), and adopts files already on the drive. Disabling drops `diskCopy`; with `deleteFiles` the entry directory is removed now (drive online) or tombstoned for the next sweep. → `200` updated entry |
| `POST /api/library/{id}/disk-copy/retry` | Rebuild the manifest and reconcile against the drive with retry semantics: sticky `invalid` files are approved for replacement. Requeues the archiver. → `200` updated entry, `409` when disk copy is not enabled |
| `POST /api/library/{id}/disk-copy/pause` · `/resume` | Pause or resume this entry's download. Pause aborts the in-flight transfer (bytes stay resumable in the `.partial` file), persists `diskCopy.paused`, and keeps the entry out of the queue across restarts, wake ticks, and drive reconnects until resumed. → `200` updated entry, `409` when disk copy is not enabled |
| `GET /api/disk-jobs` | Runtime archive queue: `{jobs: [{entryId, status, reason?, file?, progress}]}`. `status` is `copying`, `queued`, `waiting` (with `reason`, e.g. `Drive disconnected`, `Out of space`, `Scheduled …`), or `paused`. `progress` is `{doneBytes, totalBytes, doneFiles, totalFiles}` across the entry's included files, counting completed files, the active transfer, and bytes already in `.partial` files. A disconnected drive aborts the transfer within ~5 s and parks the entry; `GET /api/volumes` (polled by the UI) requeues drive-waiters as soon as a volume is online again |
| `GET\|PUT /api/disk-schedule` | Global download window. `PUT {enabled, start?, end?}` (`HH:MM`; overnight wrap supported) → `{window: {start, end, label}\|null, active}`. Outside the window new archive work waits with reason `Scheduled HH:MM–HH:MM`; a file already copying finishes. Playback is never scheduled |

## Non-API token-gated routes

| Method & path | Description |
|---|---|
| `GET /manage/{token}` | Management page shell (HTML, CSP `script-src 'self'; style-src 'self'`) |
| `GET /manage-assets/{file}` | Static UI modules and stylesheet from `addon/assets/manage/` (public, whitelisted names only, cached 5 min) |
| `GET\|HEAD /local/{token}/{entryId}[/{fileId}]` | Range-capable local media streaming |
| `GET\|HEAD /media/{token}/{entryId}/{sourceKey}` | Stable playback URL for disk-copy entries. Every range request independently resolves the source: a valid complete disk file on an online volume serves local bytes; anything else proxies the same range from TorrServer. Plugging or unplugging a drive switches sources on the client's next request — never mid-response |
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
