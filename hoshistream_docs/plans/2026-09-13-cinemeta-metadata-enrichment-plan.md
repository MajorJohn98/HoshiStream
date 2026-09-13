# Cinemeta metadata enrichment (opt-in)

Date: 2026-09-13
Status: **Approved, not started.**
Decision: [ADR 0026](../decisions/0026-opt-in-cinemeta-metadata-enrichment.md).

Goal: when the viewer opts in, a freshly added movie or series gets its
description, artwork, year, runtime, rating, people, trailers, genres, ongoing
flag and per-episode titles/overviews/air dates from Stremio's Cinemeta
add-on — automatically when the match is unambiguous, with a pick list when it
is not — while hand-typed values always win and artwork is cached locally.

## Verified Cinemeta contract (probed 2026-09-13)

Base `https://v3-cinemeta.strem.io`, public, no auth, `Cache-Control:
public, max-age=10800`.

- `GET /catalog/{movie|series}/top/search={query}.json` →
  `{metas: [{id: "tt…", imdb_id, type, name, poster, background?,
releaseInfo: "2022-" | "2019", …}]}`. Query is URL-encoded free text.
- `GET /meta/{movie|series}/{ttId}.json` → `{meta: {…}}` with `name`,
  `description`, `poster`, `background`, `logo` (all `images.metahub.space`),
  `releaseInfo` (`"2022–"`, en-dash), `year`, `runtime` (`"49 min"`),
  `imdbRating` (`"8.6"`), `cast[]`, `director[]`, `writer[]`, `country`,
  `awards`, `genres[]` (also `genre[]`), `trailers: [{source: <ytId>,
type: "Trailer"}]`, `status: "Continuing" | "Ended" | …` (series),
  `videos: [{id: "tt…:S:E", season, episode (also number), name (also
title), overview (also description), released, firstAired, thumbnail}]`.
  Season 0 holds specials.

Zod schemas are permissive (`passthrough`, every field optional, alternates
tolerated) so a shape drift degrades to "fewer fields" rather than a failure.

## Non-goals

No other providers, API keys, scraping or request-time proxying. Entry ids stay
`hoshi:`. No transcoding/database/dashboard/containers. The Chrome companion
does not talk to Cinemeta; enrichment runs in the add-on after commit.

## Data model (additive, Zod-validated)

```ts
// LibraryEntry.metadata
{
  provider: "cinemeta";
  imdbId?: string;                 // /^tt\d{7,8}$/ — set once matched
  status: "matched" | "needs-review" | "unavailable" | "unmatched";
  fetchedAt?: string;              // ISO datetime of the last successful apply
  query?: { title: string; year?: number }; // what was sent, for the sheet
  candidates?: Array<{ imdbId; name; releaseInfo?; poster? }>; // ≤ 5
  owned: string[];                 // top-level fields enrichment wrote
  ownedEpisodes: string[];         // "S:E" keys enrichment wrote
  artwork?: { poster?: ArtworkRef; background?: ArtworkRef; logo?: ArtworkRef };
  lastError?: string;              // sanitized, ≤ 200 chars
}
// ArtworkRef: { file: string /* relative to ARTWORK_DIR */, bytes, etag, fetchedAt }
```

`metadata-settings.json` (new, `METADATA_SETTINGS_PATH`):
`{ enabled: boolean, autoOnAdd: boolean }` — defaults `false`, `true`.
`ARTWORK_DIR` (default `<state>/artwork`). `CINEMETA_URL` env override
(default the public origin; tests point it at a local server; loopback `http`
allowed, otherwise `https` only, validated like `pointerUrlSchema`).

## Ownership rule

For each top-level field in `titleMetadataSchema` plus `description`,
`poster`, `background`, `tags`, `ongoing`, and each `episodes["S:E"]`:

- **fill** (automatic runs): write only if the entry has no value.
- **replace** (explicit _Apply this match_ / _Refresh_): write if empty **or**
  the field is in `owned` / `ownedEpisodes`.
- A management `PATCH` that sets a field removes it from `owned`
  (`ownedEpisodes` for episode keys) — the viewer now owns it.
- **Unlink** deletes owned values, cached artwork and the `metadata` block;
  viewer-owned values stay.

Tags: Cinemeta genres map to registry names case-insensitively via
`Tags.ensure`; enrichment owns the _union_ it added, so Unlink removes only
those names from the entry (never from the registry).

## Phases

### Phase 0 — Settings and disclosure

- `src/metadata-settings.ts`: atomic JSON store, Zod schema, defaults.
- `GET/PUT /api/metadata/settings` (bearer). `PUT` is strict.
- System page card **Title details from Cinemeta** with the toggle,
  _Fetch automatically after adding_ sub-toggle, and disclosure text:
  "Sends the title and year of each entry to strem.io. Artwork is downloaded
  once and served from this computer." Off → the card also says no requests
  are made.
- Privacy guide table gains a row; backup guide lists `artwork/` and
  `metadata-settings.json`.

### Phase 1 — Cinemeta client

`src/cinemeta.ts`:

- `search(type, query): Promise<Candidate[]>` and `meta(type, imdbId):
Promise<CinemetaMeta>` over `fetch` with `AbortSignal.timeout(10_000)`,
  2 MB body cap (read via stream, abort on overflow), `accept:
application/json`, and a fixed `user-agent: HoshiStream/<version>`.
- Errors as a small union: `unavailable` (network/5xx/timeout), `not-found`
  (404 / empty), `invalid` (schema).
- In-memory response cache keyed by URL, TTL 3 h, plus single-flight per key.
- Concurrency semaphore of 2 across all callers.
- Logs `cinemeta.request {route, status, durationMs, bytes}` — never the
  query text or entry id at `info`; `debug` may add `imdbId`.

### Phase 2 — Title query

`src/title-query.ts`: `titleQuery(name, hints?): {title, year?}`.
Strip release noise (reuse `NOISE` from `episode-titles.ts`), season markers
(`S01`, `Season 1`, `Complete`, `Part 2`), bracketed groups, trailing group
tags; pull a `(19|20)\d\d` year when it is not part of the title; `.`/`_` →
spaces; collapse whitespace; ≤ 120 chars. Input is the entry `name`
(already `suggestedName`-derived on import). Matrix test with ~30 cases
including anime `[Group] Show - 01`, `Show.2019.S01.1080p`, `Movie (2021)`,
`Movie.Title.2021.2160p.UHD`, unicode titles.

### Phase 3 — Mapping and apply

`src/metadata-enrichment.ts`:

- `mapCinemetaMeta(meta, entry, tagsRegistry)` → `{patch, episodes, tags,
ongoing}` after validation against our own limits: names ≤ 200 chars and
  ≤ 50 per list (drop blanks), `awards` truncated to 300, `imdbRating` only
  when it matches our regex and is not `"0"`, `releaseInfo` with the en-dash
  normalised to `-`, `runtime` kept verbatim (≤ 40), trailers filtered by
  `YOUTUBE_ID`, `country`/`language` ≤ 200, `poster`/`background`/`logo`
  must be `https:` URLs.
- Episodes: for each video with `season ≥ 1` and an integer episode, write
  `{title, overview, released}` (title = `name ?? title`, overview =
  `overview ?? description`, released = `released ?? firstAired`). Prefer
  seasons present in the inspection cache; cap at 500 keys total (existing
  schema limit). Specials (season 0) are skipped unless the entry already
  maps files to season 0.
- `ongoing` = `status === "Continuing"` (series only, fill/replace rule).
- `applyEnrichment(library, tags, entryId, meta, mode)` performs the
  ownership merge above in one `library.update`, writes `metadata`, and
  returns the list of fields written.

### Phase 4 — Artwork cache and serving

`src/artwork-cache.ts`:

- Path `ARTWORK_DIR/<base64url(entryId)>/<kind>.<ext>`, kind ∈
  `poster | background | logo`; ext from the response content-type
  (`image/jpeg|png|webp` only; anything else rejected). 15 s timeout, 5 MB
  cap, download to a temp file then rename. Re-download only when the remote
  URL changed. Removed with the entry (hook beside thumbnails) and on Unlink.
- `GET /artwork/<token>/<entryId>/<kind>` (open route, token in path, kind
  from a fixed allowlist so no path escapes the folder). `cache-control:
max-age=604800`, ETag from size+mtime, `304` on `If-None-Match`, `404`
  when missing.
- Emission: `toMetaPreview(entry, {artworkUrl?})` substitutes the local URL
  for `poster`/`background`/`logo` when a cached file exists and the request
  origin is known; otherwise the remote URL. To know the origin, `catalog`
  and movie `meta` move from the SDK router into `routes/protocol.ts`
  (which already resolves the public add-on URL for series meta, streams and
  subtitles). The SDK still serves the manifest fallbacks and unknown paths.
- Episode thumbnails from Cinemeta are **optional in this phase**: when no
  local frame exists for an episode present in the entry's file list, cache
  `videos[].thumbnail` to `<dir>/episodes/<S>/<E>.jpg` (same limits, ≤ 2
  concurrent, ≤ 200 per run) and let `thumbnailUrl` fall back to it. Local
  frames grabbed later win.

### Phase 5 — Triggers and management API

- **Automatic** (when `enabled && autoOnAdd`): after `POST /api/library`,
  `POST /api/imports/commit` and `series-commit` return, queue
  `enrich(entryId, {mode: "fill", auto: true})`. The add response never
  waits on the network. Auto-accept when exactly one candidate, or the top
  candidate's name equals the query title (case-, diacritic- and
  punctuation-insensitive) and the year matches when both are known;
  otherwise store ≤ 5 candidates and set `status: "needs-review"`. No
  candidates → `unmatched`; network failure → `unavailable` + `lastError`.
- **Manual** (bearer):
  - `GET /api/library/:id/metadata/search?q=` → `{query, candidates}`.
  - `POST /api/library/:id/metadata/apply {imdbId}` → fetch + apply in
    `replace` mode → `200 {metadata, written: string[]}`.
  - `POST /api/library/:id/metadata/refresh` → re-fetch by stored `imdbId`
    (`409` when none), `replace` mode.
  - `DELETE /api/library/:id/metadata` → Unlink.
  - `POST /api/metadata/backfill` → `202 {queued}` for every entry without
    `metadata.imdbId`; one entry at a time, ≥ 500 ms apart; `409` while a run
    is active; `GET /api/metadata/backfill` → progress
    `{running, done, total, needsReview, failed}`.
- All endpoints return `409 metadata-disabled` when the toggle is off.
- `GET /api/library/:id` and the library list include `metadata` (candidates
  included; artwork refs omitted from the list for size).

### Phase 6 — UI (`assets/manage`)

- **System**: the settings card from Phase 0 plus **Fetch details for
  existing titles** (backfill) with a progress line.
- **Entry sheet → Details**: a _Match_ card above the metadata form:
  - `matched`: "IMDb tt… · fetched <date>" with _Refresh_, _Change match_,
    _Unlink_; owned fields show a small "from Cinemeta" hint and revert to
    viewer-owned when edited.
  - `needs-review`: candidate cards (poster, name, year) with _Use this_,
    plus a search field for a corrected title.
  - `unmatched` / `unavailable`: the reason and _Search again_.
  - Off: one line pointing to the System toggle.
- **Add flow**: after a successful add the sheet opens with "Fetching
  details…" and settles into one of the states above (poll `GET
/api/library/:id` for `metadata.status`).

### Phase 7 — Tests (`addon/tests`)

- `cinemeta.test.ts`: schema tolerance (alternate field names, missing
  fields), timeout, body cap, 404 → `not-found`, cache hit within TTL,
  single-flight, semaphore, no query text in logs.
- `title-query.test.ts`: the matrix.
- `metadata-enrichment.test.ts`: fill vs replace, ownership after PATCH,
  Unlink leaves viewer values, limits (50 names, 300-char awards, bad rating
  dropped, en-dash), genres → tags via `ensure`, episodes cap and season-0
  rule, `ongoing`.
- `artwork-cache.test.ts`: content-type/size rejection, atomic write,
  re-download on URL change, route ETag/304/404/containment, removal with
  entry.
- `metadata-api.test.ts`: every endpoint, `409` when disabled, auto-accept
  rule, backfill serialization, **disabled → `fetch` never called**.
- `catalog.test.ts` / `inspection.test.ts` additions: artwork URL
  substitution with and without origin.

### Phase 8 — Docs

Changelog `changelog/cinemeta-metadata-enrichment.md`; management API
reference (new endpoints, `metadata` block); `api/addon-protocol.md`
(artwork URLs, catalog/meta now on the protocol route); privacy guide row;
backup guide (`artwork/`, `metadata-settings.json`); adding-media and
getting-started guides (what the toggle does); architecture overview module
table (`cinemeta.ts`, `metadata-enrichment.ts`, `artwork-cache.ts`,
`metadata-settings.ts`); `index.md`.

## Verification

From `addon/`: `npm run typecheck && npm test && npm run lint && npm run
format:check`. Manual: toggle off → add a magnet → confirm no outbound
request in logs; toggle on → add "Severance" → matched automatically, detail
page in Stremio shows poster/background/logo from `/artwork/…`, episodes
carry Cinemeta titles; add an ambiguous title → _needs review_ card → pick →
applied; edit the description → refresh → description untouched; Unlink →
only Cinemeta values disappear; disconnect the network → posters still load
from the cache and the sheet reports `unavailable` on refresh.
