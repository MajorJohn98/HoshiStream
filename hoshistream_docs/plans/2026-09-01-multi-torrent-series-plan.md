# 2026-09-01 — Multi-torrent series entries

## Problem

A series entry holds exactly one source (`magnetUri` | `torrentFilePath` |
local path); episodes are the files inside it. Real series often arrive as
several torrents — one pack per season, or single-episode releases. Today
that forces one library entry per torrent, splitting a show into fragments
in the catalog.

## Goal

One series entry backed by **several torrents** (mix of season packs and
single-episode torrents), presented as a single show with a merged episode
list. Movies and local-media entries are unchanged.

## Design

### Data model (`types.ts`)

New optional field on series entries, additive and backwards-compatible:

```ts
seriesSourceSchema = z.object({
  magnetUri: z.string().startsWith("magnet:?").optional(),
  torrentFilePath: z.string().endsWith(".torrent").optional(),
  // All files in this source default to this season when their names don't
  // parse (e.g. an unlabeled season pack).
  seasonHint: z.number().int().nonnegative().optional(),
  fileOverrides: z.array(fileOverrideSchema).optional(),
}).refine(magnetUri or torrentFilePath)

libraryEntrySchema += { extraSources: z.array(seriesSourceSchema).optional() }
```

- The existing top-level source stays the *primary* (source index 0);
  `extraSources[k]` is source index `k + 1`. Existing libraries load
  unchanged.
- `extraSources` is rejected on movies and on local-media entries
  (validated in create/patch handling).

### Composite file IDs

TorrServer file ids are per-torrent indexes, so they collide across sources.
Every selected file gets a synthetic id:

```
compositeId = sourceIndex * 100_000 + torrServerFileId
```

- Source 0 keeps raw ids (`0 * 100_000 + id`), so **existing entries,
  inspection caches, playback state, and HLS URLs stay valid**.
- Everything downstream (playback, transcode sessions, `/hls/`, `/local/`,
  player resume) already treats the id as an opaque number and keeps
  working; only the two places that talk to TorrServer decode it.
- `SelectedFile` gains optional `hash` (the owning torrent's hash) so stream
  URL generation knows which torrent to address. `cachedFileSchema` gains
  the same optional field; `inspectionCache.hash` remains the primary's.

### Inspection (`inspection.ts`, `media-file-selection.ts`)

- `inspectEntry` registers and inspects the primary plus every extra source
  (sequentially — TorrServer likes that better, and adds are rare).
- Per source: `selectMediaFiles` runs with that source's overrides, then
  `seasonHint` fills season for files whose names didn't parse into
  season/episode (parsed numbering wins over the hint; per-file overrides
  win over both). Episode fallback stays positional within the source.
- Merge: concatenate all sources' selections, remap ids to composite ids,
  attach per-source hash, sort by season/episode. If two sources claim the
  same (season, episode), the **later source wins** and the loser is
  dropped with a `duplicate_episode_dropped` warn log — this makes
  "replace season 2 with a better pack" possible by adding it after.
- `resolveStreamSource`'s cache re-registration check verifies every hash
  referenced by cached files, not only the primary.

### Streams (`streams.ts`, `routes.ts`)

- `getStreams`/HLS resolve the file by composite id, then call
  `torrServer.streamUrl(file.hash ?? source.hash, rawId(file))`.
- A tiny `sourceFileId(compositeId)` / `SOURCE_STRIDE` helper pair lives in
  `media-file-selection.ts` next to the types.

### Management API (`routes.ts`, `types.ts`)

- `createEntrySchema` / `patchEntrySchema` accept `extraSources` (series +
  torrent-backed only; a patch replacing sources clears
  `inspectionCache`).
- No new endpoints: sources are edited through the existing entry
  create/patch routes, matching how `fileOverrides` works today.

### Management UI (`assets/manage/views/add.js`, `detail.js`)

- **Add view**: when type = series and source = magnet/torrent, an
  "Additional torrents" list with per-row magnet input + optional season
  number, and an "add another" button.
- **Detail view**: show the source list (primary + extras with season
  hints), allow adding/removing extras, trigger re-inspect after changes.

## Out of scope

- Mixing local files and torrents in one entry.
- Multiple sources for movies.
- Automatic quality/dedup arbitration beyond "later source wins".

## Phases

1. **Model + merge logic**: schema, composite-id helpers, `seasonHint`
   selection changes, multi-source `inspectEntry`/`resolveStreamSource`,
   unit tests (selection merge, id encoding, schema).
2. **Delivery paths**: streams + HLS decode, cache validation, playback
   sanity check, tests.
3. **API + UI**: create/patch acceptance + validation, add/detail views.
4. **Docs**: API reference + adding-media guide updates, changelog entry.

## Validation

`npm run typecheck && npm test && npm run lint && npm run format:check` in
`addon/`; manual: create a series from two magnets (a pack + a single
episode), confirm merged episode list and per-episode playback from the
correct torrent.
