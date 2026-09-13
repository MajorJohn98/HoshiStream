# Episode metadata and thumbnails

Phase 13 of the [expansion plan](../plans/2026-09-12-playback-pointer-library-expansion-plan.md);
detailed in the [episode metadata plan](../plans/2026-09-13-episode-metadata-and-thumbnails-plan.md).
Series episodes in Stremio now read as episodes — a title, an optional
overview and air date, and a frame — instead of raw file paths.

## What changed

- **Cleaned titles by default.** `meta.videos[].title` is derived from the
  filename: the extension, bracketed groups and everything from the first
  resolution / source / codec / audio / HDR tag onward are dropped, the text
  after the `SxxEyy` (or `NxM`) token is kept, and a trailing `-GROUP` is
  removed. `Show.S01E01.Winter.Is.Coming.1080p.x264-GRP.mkv` → *Winter Is
  Coming*; a file with nothing but noise becomes *Episode 1*
  (`src/episode-titles.ts`).
- **Per-episode overrides.** `LibraryEntry.episodes` is a map keyed `"S:E"`
  with optional `title` (≤ 200), `overview` (≤ 2000) and `released` (ISO
  datetime). Overrides win over the cleaned title; `released` falls back to
  the entry's `createdAt` as before. PATCH replaces the map; `null` clears it.
- **Ongoing flag.** `LibraryEntry.ongoing: true` emits
  `behaviorHints.hasScheduledVideos: true` on the series meta so Stremio
  keeps the show on the Board and expects new episodes.
- **Thumbnails.** `ThumbnailService` grabs one 480 px JPEG per episode with
  the vendored `ffmpeg` (`-ss` at 20 % of the `ffprobe` duration, 60 s when
  unknown, `-frames:v 1 -vf scale=480:-2 -q:v 4`) into
  `<state>/thumbnails/<base64url entryId>/<S>/<E>.jpg`, written through a
  `.partial` and renamed. Only files already on disk qualify: every mapped
  file of a local-folder series, or the **complete** disk copies of a torrent
  series whose volume is online. Nothing is ever pulled from a live torrent.
  Runs are serialised globally; one run per entry at a time.
- **Automatic after archiving.** The archiver now fires `onEntryArchived`
  once per pass that landed at least one complete copy, and the server queues
  a thumbnail run for that entry.
- **Serving.** `GET|HEAD /thumbnails/{token}/{entryId}/{S}/{E}.jpg` returns
  the frame with an `ETag` (size + mtime), `cache-control: max-age=604800`
  and `304` on `If-None-Match`; `404` otherwise. Series meta carries
  `videos[].thumbnail` for episodes that have a frame when the request went
  through the token-gated protocol path. Deleting an entry removes its frames.
- **Management API.** `GET /api/library/{id}/episodes` lists rows with the
  cleaned default title, overrides, on-disk state and frame URL;
  `GET|POST /api/library/{id}/thumbnails` reports status and queues a run
  (`202`, `409 thumbnails_running`, `{force: true}` to regrab).
- **Episodes tab.** A series-only tab on the detail sheet: an *Ongoing series*
  checkbox, a thumbnail summary with **Generate thumbnails** (and
  **Regenerate all** once frames exist), season tabs, and per-episode rows
  showing the frame, a title input placeholdered with the cleaned default,
  an overview and an air-date picker. Saving submits the shown season and
  keeps other seasons' overrides. The tab polls while a run is in flight.
- **Config.** `THUMBNAILS_DIR` (default `<state root>/thumbnails`);
  `ffprobe` is resolved from `FFPROBE_PATH` like the supervisor already sets.

## Deviations from the plan

- Local-folder series are eligible too — their files are on disk by
  definition, so the "never from a live torrent" rule is satisfied.
- Duration comes from `ffprobe` rather than parsing ffmpeg's banner.
- The tab reads `/episodes` instead of the inspection response so torrent and
  local series render identically.

## Files

`src/episode-titles.ts`, `src/thumbnail-service.ts`,
`src/routes/episodes-api.ts`, `src/routes/media.ts` (`handleThumbnail`),
`src/metadata.ts`, `src/types.ts`, `src/library.ts`, `src/archiver.ts`,
`src/config-schema.ts`, `src/index.ts`, `assets/manage/views/episodes.js`,
`assets/manage/views/detail.js` (`EpisodesTab`), `assets/manage/styles.css`.
Tests: `tests/episode-titles.test.ts`, `tests/thumbnails.test.ts`,
`tests/episodes-ui.test.ts`, plus additions to `archiver`, `config` and
`management` tests.
