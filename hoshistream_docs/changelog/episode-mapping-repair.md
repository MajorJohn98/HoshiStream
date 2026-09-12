# Episode mapping repair

Implements Phase 7 of the
[playback, pointer and library expansion plan](../plans/2026-09-12-playback-pointer-library-expansion-plan.md):
mis-numbered or mis-ordered episodes are fixed in place, without re-adding the
series, and the fix survives re-inspection and later sources.

## What changed

- **`episodeOverrides`** on `LibraryEntry` (`src/types.ts`):
  `[{ id, season, episode }]` keyed by the entry-wide (composite) file id.
  Zod rejects a file listed twice or two files on one season/episode; season 0
  (specials) is allowed. `PATCH /api/library/:id` accepts it; `[]` clears.
- **Precedence** (`src/media-file-selection.ts`): `mergeSelectedFiles` now
  takes the overrides. Repaired files claim their slot first; automatic files
  that would land on a claimed slot are dropped with
  `episode_override_shadowed` (mirroring `duplicate_episode_dropped`), and
  the usual later-source-wins rule only applies among automatic files. Local
  folders, which never merge, go through `applyEpisodeOverrides` with the same
  rules. The order is therefore: filename pattern / `fileOverrides` season and
  episode → source merge → `episodeOverrides`.
- **Targeted inspection** (`inspectEntry` with `fileId`) treats a repaired
  file as pinned: the "later source replaces this episode" guard no longer
  fires for it.
- **`Library.patch`**: changing `episodeOverrides` drops `inspectionCache`
  (the cached slots are stale) but is *not* a source-definition change, so
  source checks, probes and `mediaFacts` stay put.
- **Management UI — Files tab** (`views/detail.js`, `views/episode-mapping.js`):
  the mapping table is now a controlled editor. Season/episode edits highlight
  duplicates live (red rows; **Save mapping** is disabled while any exist) and
  list gaps per season below the toolbar ("Season 1 skips episodes 3, 4").
  **Shift up / Shift down** renumbers every included row in the current
  season tab (or all rows when there is one season) by N and refuses shifts
  that would go below episode 1. Saving stores every included row as an
  `episodeOverride`; include/exclude changes still go to each source's own
  `fileOverrides` — now routed by source with raw ids, which also fixes the
  previous table silently ignoring include toggles on extra sources.
  **Restore automatic mapping** clears both.

## Tests

- `tests/episode-overrides.test.ts` — `applyEpisodeOverrides` (move, drop
  shadowed, ignore unknown ids, specials), schema validation, `Library.patch`
  cache/probe behaviour, and end-to-end inspection: a repaired off-by-one pack
  keeps its files even when an extra source claims one of the automatic
  slots, and the repaired order is what `resolveStreamSource` serves from
  cache.
- `tests/episode-mapping-ui.test.ts` — `mappingRows`, `shiftEpisodes`,
  `mappingIssues`/`describeGaps`, and `mappingPatch` (composite-id overrides,
  per-source include routing, server-owned fields stripped).

## Docs

- `api/management-api-reference.md` — `episodeOverrides` field.
- `api/addon-protocol.md` — resolution order.
- `guides/adding-media.md` — how to repair a mapping in the UI.
