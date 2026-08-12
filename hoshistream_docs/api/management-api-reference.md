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

### Entry fields (create)

Exactly one source is required: `magnetUri` (must start `magnet:?`), `torrentFilePath` (must end `.torrent`), `localFilePath`, or `localFolderPath` (absolute paths).

| Field | Type | Notes |
|---|---|---|
| `type` | `"movie" \| "series"` | required |
| `name` | string | required |
| `description` | string | optional; nullable on PATCH |
| `poster`, `background` | URL | optional; nullable on PATCH |
| `preferredFileIndex` | int ≥ 0 | force a TorrServer file ID |
| `fileOverrides` | `[{id, included, season?, episode?}]` | per-file include/episode mapping |
| `nativePathGrant` | string | POST only; redeems a native-picker grant into a local path |

`managedMedia` is server-controlled and stripped from client input. Browser-supplied local paths are validated server-side; `id`, `createdAt`, `updatedAt` are server-generated.

### Inspection response

Returns the TorrServer registration (`hash`, `files`, `selectedFiles`) plus `homeSpeedMbps`. Add `?probe=true` to include `technical` (resolution, codecs, duration, average bitrate, recommended speed with 50% headroom); probe failures return `technical: {"error": ...}`. Inspection may take up to 30 s; file IDs are TorrServer's one-based IDs.

## Status and utilities

| Method & path | Description |
|---|---|
| `GET /api/status` | Add-on status, TorrServer `{online, version}`, `libraryCount`, `homeSpeedMbps`, `uptimeSeconds` |
| `POST /api/stremio-refresh` | Recount catalogs → `{movies, series, total, updatedAt}` (no-store) |
| `GET /api/media-files` | List files available under the read-only media mount |
| `POST /api/upload?batch=&path=` | Browser upload of a video into managed storage → `204` |
| `POST /api/torrent-upload?batch=&name=` | Upload a `.torrent` → `201 {"path": ...}` |
| `POST /api/native-picker/{file\|folder}` | Open a native Finder picker; returns a grant (native app only) |

## Non-API token-gated routes

| Method & path | Description |
|---|---|
| `GET /manage/{token}` | Embedded management page (HTML, CSP-restricted) |
| `GET\|HEAD /local/{token}/{entryId}[/{fileId}]` | Range-capable local media streaming |
| `GET /assets/hoshistream-logo.png` | Logo (public, cached 1 day) |
