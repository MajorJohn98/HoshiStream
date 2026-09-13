# Cinemeta metadata enrichment (opt-in)

Implements the
[Cinemeta metadata enrichment plan](../plans/2026-09-13-cinemeta-metadata-enrichment-plan.md)
under [ADR 0026](../decisions/0026-opt-in-cinemeta-metadata-enrichment.md):
when the owner turns it on, a newly added movie or series gets its details
from Stremio's public Cinemeta add-on. Off by default; nothing leaves the
computer until the toggle is switched.

## What changed

- **Settings** (`src/metadata-settings.ts`, `<state dir>/metadata-settings.json`):
  `{enabled: false, autoOnAdd: true}`, edited through
  `GET|PUT /api/metadata/settings`.
- **Cinemeta client** (`src/cinemeta.ts`): `search(type, query)` against
  `/catalog/{type}/top/search={q}.json` and `meta(type, imdbId)` against
  `/meta/{type}/{tt}.json` on `CINEMETA_URL` (default
  `https://v3-cinemeta.strem.io`; https or loopback only). 3 h in-memory
  cache, single-flight, at most two concurrent requests, 10 s timeout, 2 MB
  response cap, `User-Agent: HoshiStream/<version>`. Responses are
  Zod-parsed; unknown fields are ignored. Logs `cinemeta_request` with route
  class, status, bytes, and duration — never the query text.
- **Title query** (`src/title-query.ts`): turns an entry name such as
  `The.Bear.S02.1080p.WEB-DL` into `{title: "The Bear"}` (+ `year` when the
  name carries one), reusing the release-noise list from
  `episode-titles.ts`.
- **Provenance** (`src/types.ts`, `LibraryEntry.metadata`): `provider`,
  `imdbId`, `status` (`matched` | `needs-review` | `unavailable` |
  `unmatched`), `fetchedAt`, `query`, up to five `candidates`, and the
  ownership lists `owned`, `ownedEpisodes`, `ownedTags` plus `artwork` refs.
  Clients cannot write `metadata`; `POST`/`PATCH /api/library` reject it.
- **Ownership** (`src/library.ts` `transferOwnership`, `mutate`): a viewer
  `PATCH` that changes an enrichment-owned value drops it from the owned
  lists, so later refreshes leave it alone. Fill mode (auto on add) writes
  only empty fields; replace mode (explicit apply/refresh) rewrites owned
  fields and removes owned fields Cinemeta no longer has. Tags: fill only
  when the entry has none; replace keeps viewer tags and swaps the genres.
  `ongoing` follows Cinemeta's `status === "Continuing"` on series.
  Episodes are merged per key for seasons ≥ 1 (season 0 only if the entry
  maps files to it), capped at 500.
- **Matching** (`src/metadata-enrichment.ts` `pickCandidate`): auto-accept
  a single candidate, or a top candidate whose normalised title equals the
  query and whose year agrees when both are known; otherwise `needs-review`
  with the candidates stored for the sheet; no candidates → `unmatched`;
  network failure → `unavailable` with `lastError` (an existing `imdbId`
  and its details are kept).
- **Artwork cache** (`src/artwork-cache.ts`, `<state dir>/artwork/<id>/`):
  poster, background, and logo are downloaded once (https only,
  JPEG/PNG/WebP, 5 MB, 15 s) and served from
  `GET|HEAD /artwork/{token}/{entryId}/{kind}` with `ETag`/`304` and
  `max-age=604800`. Catalog and meta responses on the tokenized path point at
  the local copy; the original URL stays in `metadata.artwork[kind].sourceUrl`
  and is used again when the cached file is missing. Deleting an entry
  removes its folder.
- **Triggers**: `POST /api/library`, import `commit`, and `series-commit`
  queue a fill-mode fetch when `enabled && autoOnAdd`; fetches run one at a
  time and never block the add. `POST /api/metadata/backfill` walks every
  entry without a match with a 500 ms gap; `GET` reports progress.
- **Per-entry API** (`src/routes/metadata-api.ts`):
  `GET /api/library/{id}/metadata/search?q=`, `POST …/apply {imdbId}`,
  `POST …/refresh`, `DELETE …/metadata` (unlink — removes only what
  enrichment still owns).
- **Management UI**: System → Status gains **Title details from Cinemeta**
  (on/off, "fetch automatically when a title is added", the disclosure text,
  and **Fetch details for existing titles** with live progress). The entry
  sheet's Details tab gains a **Match** card: IMDb id and fetch time with
  Refresh / Change match / Unlink when matched; a pick list when several
  titles matched; a search box otherwise; "Fetching details…" right after an
  add. Fields written by enrichment carry a "from Cinemeta" hint that
  disappears once the viewer edits them.

## Tests

- `tests/title-query.test.ts` — name cleaning, years, editions, length cap.
- `tests/cinemeta.test.ts` — URL shape, header, cache and single-flight,
  concurrency cap, timeout, size cap, 404 vs 5xx vs invalid JSON, poster
  https filter.
- `tests/metadata-enrichment.test.ts` — mapping (episodes, aliases, invalid
  dates, season 0, cap), fill vs replace merge, tag handling,
  `pickCandidate`, the service end to end against a local stub (auto-accept,
  needs-review → apply, unmatched, unavailable, viewer edits win, unlink,
  backfill, disabled), and the routes (settings, add → fetch, artwork
  serving with `ETag`, client-written `metadata` rejected, delete cleanup).

## Docs

- `api/management-api-reference.md` — settings, backfill, per-entry routes,
  `/artwork/` route, `metadata` field.
- `api/addon-protocol.md` — artwork URLs on catalog/meta.
- `guides/privacy-and-network.md` — Cinemeta row.
- `guides/backup-restore-updates.md` — `metadata-settings.json`, `artwork/`.
- `guides/adding-media.md`, `guides/getting-started.md` — how to turn it on.
- `architecture/architecture-overview.md` — new modules and state files.
