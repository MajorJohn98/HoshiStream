# Episode metadata and thumbnails (Phase 13)

Date: 2026-09-13
Status: **Done** — see the [changelog](../changelog/episode-metadata-and-thumbnails.md).
Parent: [expansion plan](2026-09-12-playback-pointer-library-expansion-plan.md), Phase 13.

Goal: series episodes in Stremio read as episodes, not file paths — a
readable title, an optional overview and air date, a frame thumbnail for
episodes that already live on disk, and an "Ongoing" flag so Stremio keeps
the show on the Board.

## Data model (additive, Zod-validated)

- `LibraryEntry.episodes?: Record<"S:E", {title?, overview?, released?}>`
  — viewer overrides keyed by `season:episode`. Title ≤ 200 chars, overview
  ≤ 2000, `released` an ISO datetime; ≤ 500 keys. PATCH replaces the whole
  map; `null` clears it.
- `LibraryEntry.ongoing?: boolean` — series still airing. Emitted as
  `behaviorHints.hasScheduledVideos: true`.

## Title cleaning (`src/episode-titles.ts`)

`cleanEpisodeTitle(path, season?, episode?)`: basename without extension;
when an `SxxEyy` token exists, keep the text after it up to the first
release-noise token (resolution, source, codec, audio, HDR tags, bracketed
groups, `-GROUP` suffix); replace `.`/`_` with spaces; collapse whitespace.
Empty → `Episode N`. `episodeTitle(entry, file)` = override ?? cleaned.

## Thumbnails (`src/thumbnail-service.ts`)

- Storage: `THUMBNAILS_DIR` (default `<state>/thumbnails`) /
  `<base64url(entryId)>/<S>/<E>.jpg`. Never grabbed from `/play`: only
  files with an on-disk path qualify — local-folder series and torrent
  series whose disk copy for that file is `complete` on an online volume.
- Grab: duration from `ffprobe` (`FFPROBE_PATH`, same binary the probe
  uses), then `ffmpeg -ss <20 % of duration> -i <file> -frames:v 1
  -vf scale=480:-2 -q:v 4` to a temp file renamed into place. One ffmpeg at
  a time, 60 s budget per frame, failures recorded per entry.
- Triggers: **Generate thumbnails** button (Episodes tab) and automatically
  when the archiver finishes copying a file (`onEntryArchived` hook).
- Served at `GET /thumbnails/<token>/<entryId>/<S>/<E>.jpg` (open route,
  token in path) with `cache-control: max-age=604800` and an ETag from
  size + mtime; `304` on `If-None-Match`; `404` when missing. Season and
  episode are digits-only in the route, so no path can escape the folder.
- Removed with the entry.

## Meta

`videos[]` gains `title` (override or cleaned), `overview`, `released`
(override or `createdAt`) and `thumbnail` when the JPEG exists.
`behaviorHints.hasScheduledVideos` for ongoing series.

## Management API

- `GET /api/library/:id/episodes` → `{episodes: [{season, episode, fileId,
  path, defaultTitle, title?, overview?, released?, onDisk, thumbnail}],
  eligible, thumbnails: {running, generated, failed, lastError}}`.
- `POST /api/library/:id/thumbnails` → `202 {queued}`; `409` when a run is
  already in progress; body `{force?: true}` regenerates existing frames.
- `PATCH /api/library/:id` with `{episodes}` / `{ongoing}`.

## UI (entry sheet → **Episodes** tab, series only)

Ongoing toggle; thumbnails status + Generate button (disabled when nothing
is on disk, with the "never from a live torrent" note); per-season table
with title / overview / air-date fields, default title as placeholder,
thumbnail preview when present; one Save.

## Tests

`tests/episode-titles.test.ts` (cleaning matrix), `tests/thumbnails.test.ts`
(service with spawn mocked: argument shape, skip-when-present, force,
failure accounting, eligibility; route ETag/304/404/containment),
`tests/board-rows.test.ts`/`tests/inspection.test.ts` additions for meta
fields, `tests/episodes-api.test.ts` for the endpoints, UI asset assertions.

## Verification

From `addon/`: `npm run typecheck && npm test && npm run lint && npm run
format:check`. Docs: changelog, API reference, backup guide (new
`thumbnails/` dir), parent plan ✅.
