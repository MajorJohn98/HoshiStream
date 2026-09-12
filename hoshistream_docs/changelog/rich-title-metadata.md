# Rich title metadata

Implements Phase 12 of the
[playback, pointer and library expansion plan](../plans/2026-09-12-playback-pointer-library-expansion-plan.md):
a title page in Nuvio/Stremio can show more than a name and a poster, using
values the owner types in — nothing is fetched from a metadata provider.

## What changed

- **`LibraryEntry`** (`src/types.ts`, `titleMetadataSchema`, all optional):
  `releaseInfo` (year or range), `runtime` (free text ≤ 40), `imdbRating`
  (string `0`–`10`, one decimal), `cast`/`director`/`writer` (≤ 50 short
  names), `country`, `language`, `logo` (URL), `awards`, `trailers`
  (`[{ source: <11-char YouTube id>, type: "Trailer" }]`, ≤ 10) and
  `posterShape` (`poster` | `landscape` | `square`). `PATCH /api/library/:id`
  accepts each field and `null` clears it; `Library.patch` deletes cleared
  fields and does not touch inspection caches, probes or source checks.
- **`toMetaPreview`** (`src/catalog.ts`) — used for both catalog and meta:
  emits every field above, `posterShape` from the entry (default `poster`),
  `links[]` for tags (`Genres`) and cast (`Cast`) as
  `stremio:///search?search=<name>`, and `behaviorHints.defaultVideoId` for
  movies so the detail page opens straight into the stream picker. Movies
  without a typed `runtime` get `derivedRuntime()` — "1h 52m" from the
  probe of the entry's current source definition (stale facts from a replaced
  source are ignored; series are left alone because runtimes vary).
- **Management UI — Metadata tab** (`views/detail.js`,
  `views/title-metadata.js`): a form between Details and Source with year,
  runtime, rating, poster shape, comma-separated people, country, language,
  logo URL, awards, and one trailer per line. Trailers accept a bare id or
  any watch / shorts / embed / `youtu.be` URL and are reduced to the id;
  invalid lines are refused with a readable message. Blank fields clear the
  stored value.

## Tests

- `tests/title-metadata.test.ts` — schema acceptance/rejection, PATCH
  nullability, `toMetaPreview` output (rich fields, `links`,
  `defaultVideoId`, bare-entry shape unchanged, series without
  `defaultVideoId`), `derivedRuntime`, and a `Library.patch` round-trip.
- `tests/title-metadata-ui.test.ts` — `parseNameList`, `youtubeId`,
  `parseTrailers`, `metadataPatch`.

## Docs

- `api/addon-protocol.md` — preview fields, `links`, `defaultVideoId`.
- `api/management-api-reference.md` — new entry fields.
