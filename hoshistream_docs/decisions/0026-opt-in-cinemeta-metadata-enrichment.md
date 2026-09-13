# 0026 - Opt-in Cinemeta metadata enrichment

Status: accepted (2026-09-13). Implementation: see
[plans/2026-09-13-cinemeta-metadata-enrichment-plan.md](../plans/2026-09-13-cinemeta-metadata-enrichment-plan.md).

## Context

Every presentation field on a library entry — description, poster, background,
year, runtime, rating, people, trailers, genres, per-episode titles and
overviews — is typed by hand or derived from release filenames
(`episode-titles.ts`). The Stremio detail page therefore looks bare compared
with titles served by public add-ons, and adding a series means either a long
form or an episode list that reads as cleaned filenames.

Stremio's own metadata comes from **Cinemeta** (`https://v3-cinemeta.strem.io`),
a public, unauthenticated add-on over Stremio's IMDb-derived catalogue. Two
routes cover the need: `catalog/{type}/top/search={title}.json` returns
candidates (`tt…` id, name, year, poster) and `meta/{type}/{ttId}.json` returns
the complete meta object, including `videos[]` per episode. Its response shape
is the shape our `titleMetadataSchema` was written against, so ingest is a
validated field copy. There is no local equivalent to clone: the value is the
database, which is not published.

The project's stance (privacy guide; ADRs 0010, 0012, 0020) is that automatic
contact with third-party infrastructure is opt-in and disclosed. Title searches
reveal what is in the library to strem.io. Entry ids are `hoshi:…` on purpose:
switching to `tt…` ids would let Stremio's own Cinemeta answer our meta
requests and drop thumbnails, embedded episode streams and watched-state
resume.

## Decision

Add **opt-in** metadata enrichment from Cinemeta, off by default, for movies
and series alike.

- **Pull and store, not proxy.** Enrichment runs after an entry is added (and
  on demand) and writes the fields onto the library entry. Stremio requests are
  answered from `library.json` as today; nothing is fetched at request time.
- **Only title and year leave the machine.** Searches send a cleaned title and
  optional year. Filenames, infohashes, magnets, paths and tokens never appear
  in a request. Cinemeta is the only provider; no API keys, no TMDB/TVDB/Trakt.
- **Ownership.** Enrichment writes a field only when it is empty or when
  enrichment wrote it last time (recorded per field in `entry.metadata`).
  Anything the viewer types wins and is never overwritten by a refresh.
  "Unlink" removes only enrichment-owned values.
- **Match review.** A single confident candidate (exact name, matching year)
  is applied automatically; otherwise the entry is marked _needs review_ with
  up to five candidates for the viewer to pick from. Wrong matches are fixed
  by choosing another candidate or searching again.
- **Artwork is cached locally.** Poster, background and logo are downloaded
  once into `ARTWORK_DIR` and served from `/artwork/<token>/<entryId>/<kind>`;
  the remote URL stays on the entry as the source of truth and the fallback
  when no cached file exists. Playback devices therefore do not depend on
  `images.metahub.space` being reachable, and the library survives a Cinemeta
  outage unchanged.
- **Ids stay `hoshi:`.** The IMDb id is stored as provenance and exposed as an
  IMDb link; it is not the entry id.
- **Bounded and polite.** One search plus one meta call per entry, at most two
  concurrent requests, serialized backfill, 3-hour response cache (matching
  Cinemeta's own `Cache-Control`), 10 s timeouts and 2 MB body caps.

## Consequences

Viewers who turn the toggle on get complete detail pages and real episode
titles after adding a magnet, at the cost of disclosing their library titles
to strem.io; the privacy guide gains a row describing exactly that. Viewers who
leave it off see no change and no network calls.

`library.json` gains an additive `metadata` block per entry and the state
folder gains `artwork/` and `metadata-settings.json`; backups must include
them. `catalog` and movie `meta` responses move from the SDK router to the
custom protocol route so cached-artwork URLs can carry the request origin, as
stream and thumbnail URLs already do.

Cinemeta is a free service with no SLA. Failures leave entries exactly as they
were, surface as an honest status in the entry sheet, and are retried only on
explicit user action or the next add. If Cinemeta changed shape or went away,
enrichment would stop, but nothing already stored would break.
