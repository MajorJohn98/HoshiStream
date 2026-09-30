# 2026-09-28 — Season and episode hints for multi-torrent series

Status: implemented.

## Problem

A series can merge several torrents (`extraSources`, see
[2026-09-01-multi-torrent-series-plan.md](2026-09-01-multi-torrent-series-plan.md)),
but each torrent can only say which **season** its unnumbered files belong
to. Episodes are always numbered positionally from 1, so:

- a single-episode torrent whose file is named `Show.720p.mkv` always lands
  on E1 and collides with the real first episode;
- a continuation pack (episodes 13–24 named `01.mkv`…`12.mkv`) overwrites
  episodes 1–12;
- the primary torrent has no hint at all, so an unlabeled season-2 pack added
  as the main source becomes season 1;
- the filename parser only knows `S01E02` and `1x02`, so common styles
  (`S01 E02`, `Episode 5`, `[Group] Show - 05`, `Season 2/05.mkv`) fall back
  to positional numbering;
- a torrent's hint cannot be edited after adding — only removed and re-added.

## Design

### Hints (`types.ts`)

- `seriesSourceSchema` gains `episodeHint` (positive integer).
- Entries gain top-level `seasonHint` and `episodeHint` for the primary
  source (torrent or local folder). Both are nullable on `PATCH` to clear.
  Ignored for movies.
- Both are source-definition fields: changing them clears the inspection
  cache and is part of the source revision (absent hints keep existing
  revisions stable, because `JSON.stringify` drops `undefined`).

### Numbering rules (`media-file-selection.ts`)

`parseEpisodeNumbers(path)` returns `{ season?, episode?, explicit }`:

- **Explicit** (season and episode together): `S01E02`, `S01 E02`,
  `S01.E02`, `1x02`, `Season 1 Episode 2`. Used verbatim; hints never
  override it (unchanged behavior).
- **Loose** episode: `Episode 5`, `Ep05`, `E05`, anime-style `Show - 05`,
  and a leading number (`05 - Title.mkv`, `05.mkv`).
- **Loose** season from the path: `Season 2`/`Series 2` in any folder or the
  name, or a standalone `S02` token (`Show.S02.1080p/…`).

Per file, after per-file `fileOverrides`:

1. Explicit numbering wins.
2. Otherwise season = `seasonHint` → loose season → 1.
3. Otherwise episode = `episodeHint + n` (n = the file's position in this
   source's path-sorted selection, as the old positional fallback used) →
   loose episode → `n + 1`. Loose episode numbers are only trusted when they
   are unique within the source, so show names starting with a number
   ("12 Monkeys Pilot.mkv") fall back to positions instead of colliding.

A `Sample/` folder now counts as a sample, so a single-episode torrent's
sample never takes an episode slot.

So a hint beats a guess but never an explicit `SxxEyy`, and a single-episode
torrent with `episodeHint: 7` becomes exactly E7. Existing inspection caches
are untouched until the next inspection; manual `episodeOverrides` still win
over everything.

### API

- `POST/PATCH /api/library`: `seasonHint`, `episodeHint`, and
  `extraSources[].episodeHint`.
- `POST /api/imports/series-preview` and the Chrome companion's
  `previewSeries` command accept `episodeHint`.

### UI

- **Add Media** (series): Season / Episode fields for the main torrent or
  folder, and an Episode field next to Season on each additional torrent.
- **Source tab**: a "Torrents" list with the main torrent and every extra,
  each with editable Season / Episode and a Save button, plus remove/add.
- **Chrome companion**: an "Episode hint" field next to "Season hint" when
  adding to an existing series.
- TorrServer session labels read "Season 2 · Episode 5" etc.

## Out of scope

Absolute-episode (anime) remapping across seasons, multi-episode files
(`S01E01-E02` keeps its first episode), and automatic quality arbitration.

## Validation

`npm run typecheck && npm test && npm run lint && npm run format:check` in
`addon/`, with new unit tests for the parser, hint precedence, schema, patch
invalidation, preview input, and UI payload helpers.
