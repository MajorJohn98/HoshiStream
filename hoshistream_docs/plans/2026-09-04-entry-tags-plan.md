# Plan: entry tags with a dynamic tag registry (2026-09-04)

## Goal

Let a user label library entries with genre-style tags (Action, Romance,
Animation, …), filter the Library by them, and manage the tag list from a
dedicated **Tags** page so new tags can be added, renamed, or removed.

## Default tag set

Seeded once into `tags.json` on first run, from the union of the TMDB and IMDb
genre lists (TMDB movie + TV genres, IMDb title genres), de-duplicated and
merged where the two vocabularies overlap (`Sci-Fi`/`Science Fiction` →
`Sci-Fi`, `Reality-TV` → `Reality`, `Talk-Show` → `Talk Show`, `Game-Show` →
`Game Show`); `Adult`, `TV Movie`, and `Short` are omitted as content-type
labels rather than genres, and `Anime` is added since it is the most common
user tag missing from both lists:

Action, Adventure, Animation, Anime, Biography, Comedy, Crime, Documentary,
Drama, Family, Fantasy, Film-Noir, Game Show, History, Horror, Kids, Music,
Musical, Mystery, News, Reality, Romance, Sci-Fi, Soap, Sport, Talk Show,
Thriller, War, Western.

Sources: themoviedb.org genre list & TV bible; help.imdb.com "Genres".

## Design

- **Entry field**: `tags?: string[]` on `libraryEntrySchema` — display names,
  trimmed, ≤ 40 chars, unique case-insensitively, max 32 per entry. Stored by
  name (not id) so the library stays readable and portable; renames cascade.
- **Registry**: `src/tags.ts` `Tags` class over `TAGS_PATH` (default
  `<state>/tags.json`), atomic writes like `DeviceNames`. `list()`, `add()`,
  `rename()`, `remove()`, `ensure(names)` (auto-registers tags that arrive on
  an entry so the entry sheet can create tags inline).
- **Library**: `retag(from, to?)` bulk-updates entries on rename/delete.
- **API** (`src/routes/tags-api.ts`):
  - `GET /api/tags` → `{ tags: [{ name, count }] }`
  - `POST /api/tags` `{ name }` → 201
  - `PATCH /api/tags/:name` `{ name }` → rename + cascade
  - `DELETE /api/tags/:name` → remove + strip from entries
  - `POST/PATCH /api/library[...]` accept `tags`, normalize against the
    registry, and register unknown names.
- **Stremio**: catalogs gain a `genre` extra whose `options` are the current
  tag names; `getCatalog` filters on `extra.genre`; `toMetaPreview` emits
  `genres`. The served manifest (and the pointer push) is
  `manifestWithGenres(addon.manifest, tags)` so the list stays live.
- **UI**:
  - Library: tag chip row under the type filters; multi-select, AND
    semantics; cards show up to two tags.
  - Entry sheet Overview + Add Media modal: `TagPicker` (toggle chips + inline
    "new tag" input).
  - New **Tags** page (`#/tags`, sidebar glyph `⌗`): list with usage counts,
    add, inline rename, delete (confirm when in use).

## Todos

1. tags-model — `src/tags.ts`, schema changes in `types.ts`, `Library.retag`,
   `TAGS_PATH`.
2. tags-api — routes, context, library-api integration, `index.ts` wiring.
3. tags-stremio — manifest genre options, catalog filter, `genres` in meta.
4. tags-ui — store, TagPicker, Library filter + cards, detail + add, Tags
   page, nav/route.
5. tags-tests — `tags.test.ts`, catalog genre test, routes test, management
   asset assertions.
6. tags-docs — API reference, adding-media guide, changelog 0.13.0, index,
   version bump.
7. tags-verify — checks + live click-through against the running server.
