# Board rows, pinned tags and add-on identity

Phase 15 of the [expansion plan](../plans/2026-09-12-playback-pointer-library-expansion-plan.md);
detailed in the [settings and Board rows plan](../plans/2026-09-13-torrserver-settings-and-board-rows-plan.md).
Surfaces the library on Stremio's Board instead of hiding it behind the two
picker catalogs, and gives the add-on tile a logo and a contact address.

## What changed

- **Board catalogs.** Every served manifest now carries, per type, the picker
  catalog, Continue Watching, **Recently added** (`recently-added`, newest
  `createdAt` first — edits do not bump an entry) and **Unwatched**
  (`unwatched`, entries with no watch history at all, so it is disjoint from
  Continue Watching). Both accept only `skip`.
- **Pinned tags.** Any registered tag can be pinned to the Board from the Tags
  page (`Pin to Board` / `Unpin`, capped at **8**). Each pinned tag adds a
  `tag-<key>` catalog per type named after the tag, listing entries that carry
  it. Pins persist in `tags.json` as `pinned: string[]` (registry spelling,
  pin order); renames follow, deletions drop the pin, and unknown pins are
  discarded on load. `GET /api/tags` reports `pinned` per tag plus the global
  `pinned` list and `pinnedLimit`; `PATCH /api/tags/{name}` takes
  `{pinned: boolean}`.
- **Add-on identity.** The manifest adds `logo` (the public add-on origin
  `/assets/hoshistream-logo.png`, derived from the request host so LAN and
  pointer clients each get a reachable URL) and `contactEmail` when the viewer
  sets one under Tags → "Contact address". Stored in a new `identity.json`
  (`{contactEmail}`, owner-only); `GET/PUT /api/identity`. The pointer push
  publishes the same manifest.
- **Embedded episode streams.** Series meta for torrent-backed entries whose
  inspection is already cached now includes `videos[].streams`, built by the
  same code path as the `stream` resource (`torrentStreamsForFile`), so
  Stremio can switch episodes without a second round-trip. Uncached entries,
  local folders and non-series metas are unchanged, and the stream handler
  remains the fallback. The meta response is `no-store` so LAN redirect
  decisions stay per request.

## Deviations from the plan

- No `background` field: the repo ships only the logo artwork, and inventing a
  backdrop was out of scope.
- "Unwatched" means *no watch state on any file*; a partly watched series
  belongs to Continue Watching only.
- Video hashes are not embedded in series meta (they need volume lookups that
  the meta path does not perform); the `stream` resource still returns them.

## Files

- `src/manifest.ts` — `manifestForLibrary`, catalog id constants.
- `src/catalog.ts` — Board catalog branches.
- `src/tags.ts`, `src/routes/tags-api.ts` — pinning.
- `src/identity.ts`, `src/routes/system-api.ts` (`handleIdentity`).
- `src/streams.ts` (`torrentStreamsForFile`), `src/metadata.ts`,
  `src/routes/protocol.ts`.
- `assets/manage/views/tags.js`, `assets/manage/store.js`.
- Tests: `tests/board-rows.test.ts`, plus updates in `tests/tags.test.ts`
  and `tests/management.test.ts`.
