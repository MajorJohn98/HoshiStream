# Torrent search and library import

Date: 2026-09-05  
Status: historical. In-app discovery was retired in favor of the
[Chrome companion/manual-import plan](2026-09-06-chrome-companion-plan.md).
Existing libraries and source checks are preserved.

## Approved extension: bundled direct providers

On 2026-09-05 the owner requested built-in YTS, Nyaa.si and 1337x search without
Jackett. The owner approved `parse5` and its required `entities` dependency.
This extension is implemented: direct JSON/HTML provider adapters, a bounded
HTML parser worker, explicit origin allowlists, and registration in the existing
search/import/series flow. Existing optional bridges remain available. YTS and
Nyaa returned valid empty and populated search responses; 1337x remains blocked
by its HTTP 403 response from this connection.

YTS's official API documentation currently names the separate JSON API host;
Nyaa's search page is directly accessible. The 1337x endpoint currently returns
HTTP 403 from this environment, so implementation must report blocked access
honestly rather than bypass challenges or claim an empty result.

No additional index sites, headless browser, CAPTCHA solver, automatic mirror
discovery, torrent client, or transcoding behavior are in scope.

## Direction

Add **Search** to the existing **Add Media** dialog. Search returns candidates;
only an explicit **Add to library** action creates an entry. Keep the sidebar's
library filter and Nuvio/Stremio catalog searches limited to saved entries.

The user selected:

- Support both a curated public-domain/open-license catalog and user-configured
  providers eventually; recommend the shipping order.
- Put the experience inside Add Media, not a separate Discover page or Nuvio.

**Recommendation:** ship a small curated catalog first, then optional local
Prowlarr and Jackett connections behind the same provider interface. This gives
new users a complete search-to-library loop without installing another service.
If curation cannot supply a useful, rights-reviewed set with available torrents,
stop at that release gate and revisit bridge-first rather than broadening the
catalog silently.

The owner approved a narrow change to the "no torrent search" boundary in
`AGENTS.md`, the architecture overview, and the adding-media guide, recorded in
new ADR 0016. No accepted earlier ADR was edited.
Keep local JSON storage, native deployment, private-by-default access, and the
existing playback path. No new transcoding, database, dashboard, containers,
background discovery, automatic downloads, or bundled general-purpose indexers.

## Options and tradeoffs

| Approach | Benefits | Costs and limits | Recommendation |
|---|---|---|---|
| Curated catalog using Internet Archive metadata/torrent delivery | No extra local service or account; controllable scope; JSON APIs | Small catalog; ongoing rights review; torrents or seeds may disappear; items can contain multiple video derivatives | First end-to-end release, subject to the catalog gate |
| User-managed Prowlarr | Broad configured-provider support; JSON search; provider maintenance stays outside HoshiStream | Extra native service, API key, indexer selection, proxy-download handling, upstream version drift | First optional bridge |
| User-managed Jackett | Focused indexer bridge; both JSON search and Torznab interfaces | Extra service and credentials; different result/error shapes; version-specific JSON contract | Second bridge, same UI and import service |
| A generic Torznab adapter | Common protocol supported by both bridges and other services | XML parsing, capability negotiation, vendor extensions, another dependency decision | Later if interoperability justifies it |
| Direct website scraping inside HoshiStream | No separate bridge to install | Site churn, anti-bot behavior, credentials, legal and operational burden | Reject |

Both bridges remain user-installed and user-managed. Do not vendor, launch,
configure trackers in, or update them through HoshiStream. Native installation
is the intended route, not containers. Support documented versions rather than
assuming every release has the same behavior.

### Curated does not mean "everything on Internet Archive"

Use a small versioned allowlist of reviewed item IDs and provenance, not an
unrestricted search of community uploads. For the first release, match title
and creator locally against this catalog; fetch current metadata only on an
explicit search/selection. A later provider can use Archive search with enforced
curation filters if the catalog outgrows local matching.

Each approved item needs a rights/evidence URL, license or public-domain basis,
review date, and any jurisdiction/use restrictions. Collection membership,
uploader-supplied license text, or a checkbox is not proof of authorization.
Exclude uncertain items. Surface the rights source in the review step.

Read `/metadata/{identifier}` and check the actual file list for an available
torrent; do not invent an `_archive.torrent` URL. Persist a validated local
`.torrent` file on import, not an expiring remote URL. Inspect the actual torrent
file list later: Archive item sizes and derivatives are not necessarily the
selected video's size or format. Seed counts and playability may be unknown.

## Experience

**User/job:** a library owner who knows what they want and wants to add authorized
media without finding and copying a magnet elsewhere. This is an Operate
surface: clear decisions, visible state, and easy recovery outrank decoration.

**Loop:** Add Media -> Search -> choose result -> review -> Add to library ->
saved entry -> optional Inspect / choose files -> play through the existing flow.

1. Add a Search source alongside Magnet link, .torrent file, Local file, and
   Series folder. Preserve existing source choices and their defaults.
2. Show a query field, explicit Search button, and source selector. Do not send
   keystrokes upstream. Initially the catalog is the only source; configured
   bridges appear later. Explain which external service receives a request.
3. Show compact result rows: title, provider, size when known, publication date,
   seeders when known, and **Review**. For curated results, show the rights label.
   Treat title-derived resolution/language as hints, not verified properties.
4. Replace the results area with a review step inside the same dialog, not a
   nested modal. Prefill editable name and suggested Movie/Series type; reuse
   `TagPicker`. Keep the source title visible separately from the library name.
5. **Add to library** resolves the selected source, validates it, and saves one
   entry. Disable repeat submission while pending. Success names the saved entry
   and offers **Open entry** or **Search again**, preserving query and results.
6. Inspection is a separate explicit operation using the existing endpoint.
   "Saved; not inspected yet" is not "Ready to play". An inspection failure does
   not erase the entry or cause another Add operation.

Preserve the current dark/ember instrument styling, segmented controls, hairline
rows, and Preact/htm implementation. Do not add a poster-heavy discovery grid or
change the app shell. Stack row metadata on small screens; keep the primary action
reachable. Support keyboard submission, labeled controls, focus containment and
return, and polite result/status announcements. Preserve drafts on recoverable
errors; warn before discarding an edited review.

### States and recovery

| State | Response |
|---|---|
| No bridge configured | Curated search remains usable; optional "Connect a provider" setup |
| Searching | Busy state with Cancel; retain the query; stale responses cannot replace newer results |
| No matches | Name the searched scope; allow changing query/source or using manual import |
| Some providers failed | Keep successful results and identify unavailable providers |
| All providers failed | Explicit unavailable/error state, never an empty-success result |
| Already in library | Open the existing entry; do not silently create another copy |
| Same title, different torrent | Warn, but allow a distinct entry; title is not identity |
| Expired result | Preserve edited metadata; refresh the source selection, do not trust a stale download link |
| Import failed before save | Keep review values; retry safely; clean up only this operation's unreferenced file |
| Save succeeded, response lost | Retry returns the existing imported entry, not a duplicate |
| Saved, inspection failed/no playable files | Open the entry to retry, select another file/source, or remove it explicitly |

## Fit with the current implementation

| Existing surface | Reuse or necessary extension |
|---|---|
| `addon/assets/manage/views/add.js` | Source tabs, metadata form, tags, save feedback. Extract shared form logic only as needed for a search draft |
| `addon/assets/manage/api.js`, `store.js` | Same-origin bearer API and library refresh; keep search state separate from the library filter |
| `addon/src/routes.ts`, `routes/context.ts` | Inject search/import services; add routes under the existing `/api/*` authentication gate |
| `addon/src/routes/library-api.ts` | Preserve CRUD and inspect behavior; extract shared create/tag normalization instead of duplicating it |
| `addon/src/library.ts` | Atomic JSON writes and serialized mutation queue; add a narrow atomic import/dedup operation |
| `addon/src/types.ts` | Existing source fields remain authoritative; add optional server-owned import provenance/identity with backward-compatible parsing |
| `addon/src/local-media.ts` | Reuse managed upload directory/path rules and cleanup; factor a bounded torrent writer usable by uploads and provider retrieval |
| `addon/src/inspection.ts`, `torrserver-client.ts` | Existing registration, metadata polling, file selection, and caching; no new TorrServer endpoints |
| `addon/assets/manage/classify-imports.js` | Existing title/raw-magnet warnings are useful UI precedent, not content-hash deduplication |
| `addon/assets/manage/views/library.js` | Export currently omits local torrent paths; document that JSON alone does not back up managed torrent files |

Important current behavior: Add Media's button says **Inspect and add**, but
`submit()` only calls `POST /api/library`; creation does not inspect. Correct this
label when extending the dialog rather than building a new flow on that promise.

## Architecture and contracts

The browser talks only to HoshiStream. Provider credentials, raw provider
responses, magnets, and download locators stay on the server during search.

```text
Add Media / Search
    -> bearer-authenticated search API
    -> provider adapters -> curated metadata service / local bridge
    <- normalized candidates + opaque expiring result IDs

Review / Add to library
    -> resolve result ID server-side
    -> validate magnet or fetch and validate .torrent
    -> atomic duplicate check + existing library creation
    -> durable library entry

Explicit Inspect
    -> existing inspection service -> pinned TorrServer
```

Keep provider adapters small: `search`, `resolve`, and capability/health reporting.
Search produces metadata only; `resolve` produces a magnet or torrent bytes, never
a command to an external download client.

Proposed modules: `src/search/{types,service,import,source-identity}.ts`,
`src/search/providers/{curated,prowlarr,jackett}.ts`, and
`src/routes/search-api.ts`. A search component under `assets/manage/components/`
owns the dialog's search/review state. Names are proposals, not new files in this
planning change.

### Candidate and durable data

Candidate DTO: opaque `resultId`, provider ID/name, title, optional media type,
size, seeders, published date, rights/provenance, sanitized details link,
`expiresAt`, and optional matching library entry IDs. Unknown values stay absent.
Never return upstream API keys, raw GUIDs containing URLs, or download URLs.

Keep secret source locators in a bounded in-memory cache. Bind each result to
the configured provider and config revision; invalidate it on disconnect/key
change. Restart loses search results, not library entries. No search history or
background refresh.

An imported entry still uses `magnetUri` or `torrentFilePath`. Optional server-owned
import metadata can hold provider ID, a non-secret stable item identity, rights
reference, normalized content hash, and an idempotency key. Reject client writes
to those fields through ordinary create/patch routes. Keep this metadata optional
so older JSON libraries load unchanged; no new database.

### Proposed management API

| Endpoint | Contract |
|---|---|
| `GET /api/search/providers` | Enabled sources, labels, capabilities, and sanitized readiness; never credentials |
| `POST /api/search` | `{ query, providerIds, cursor? }`; normalized results plus per-provider outcome and next cursor |
| `POST /api/search/import` | `{ resultId, name, type, tags?, idempotencyKey }`; `201` new entry or `200` already imported, with explicit outcome |

Use POST for query submission to avoid placing searches in HoshiStream request
URLs. This does not prevent an upstream provider from recording its own queries.
Use `Cache-Control: no-store`; report disabled feature, expired result, invalid
source, rate limit, and provider failures with stable codes and actionable copy.

Proposed initial limits, to confirm in the provider spike: 2-200 query characters,
25 visible results/page, 100 retained results/search, 10-minute result TTL,
at most two concurrent upstream searches and a bounded cache per installation.
Use provider-specific deadlines (initially 15 seconds for metadata, 30 seconds
for bridges), cancellation, response byte limits, and bounded retries respecting
429/Retry-After. Label truncated results rather than claiming an exact total.
Do not retry a library mutation as if it were a read.

### Import correctness

Deduplicate by normalized BitTorrent identity, not the literal magnet or title.
Normalize supported v1 BTIH hex/base32 representations; reject or explain
unsupported v2-only inputs until pinned TorrServer support is verified. Hash a
torrent's exact encoded `info` bytes, not a decode/re-encode transformation.
Check primary and extra sources; legacy file-backed entries without a known hash
need lazy identity derivation or an explicit "duplicate status unknown" warning.

Perform duplicate detection and creation inside `Library`'s serialized mutation,
not as an unlocked `list()` followed by `create()`. Preserve a durable idempotency
record with the entry so a retry after restart does not create a duplicate.
On replay, check idempotency before requiring the result cache to still exist.
Different input under the same key must conflict, not overwrite metadata.

Resolve network data before entering the library write queue. For torrent bytes,
write a unique managed file atomically, then commit the entry. On failure remove
only unreferenced files owned by that import. Sweep abandoned staging files by
age/reference on startup; never delete an existing user's torrent on duplicate.
Match the existing 1 MB torrent upload limit initially and fail with a clear
size message. Use restrictive permissions for managed torrent files.

Structural bencode validation, exact hash extraction, and private-flag handling
need an implementation decision in the spike. Prefer a small reviewed parser
over a bespoke parser; a new runtime dependency requires approval. Do not treat
a `.torrent` suffix or Content-Type as validation, and do not parse XML/bencode
with regexes.

## Privacy, trust, and provider restrictions

- Default the feature off until enabled; never contact a provider on app startup
  or while the user types. Library playback remains independent of search.
- Store bridge credentials only in host-side configuration, never in library
  exports, the browser, add-on manifests, logs, or returned status. Initially use
  explicit host configuration rather than creating a remote credential editor.
- Limit initial bridges to an explicitly configured loopback origin. Validate
  origin, port, path, and scheme; search/import bodies cannot supply a fetch URL.
  Later LAN/remote bridge support needs a separate trust decision.
- Treat provider links as untrusted even when they came from a local bridge.
  Disable automatic redirects; validate each hop, resolve/pin allowed addresses,
  and prevent DNS rebinding, unexpected local-network targets, and credential
  forwarding across origins. Permit only the configured bridge's download routes
  or the curated provider's approved public HTTPS delivery hosts.
- Recognize validated magnet redirects explicitly. Do not let a proxy URL named
  `magnetUrl` pass as a magnet or store it as the entry source.
- Sanitize errors before they reach the shared route logger. Log provider IDs,
  durations, counts, and stable error codes, not queries, response bodies,
  complete magnets, signed URLs, API keys, passkeys, or authorization headers.
- Render provider text as text. Reject active URL schemes and do not automatically
  fetch provider artwork in the browser. External details links need safe schemes,
  `noopener`/`noreferrer`, and no credentials.
- Explain that local-first is not offline or anonymous: providers learn queries
  and the host's IP, and explicit inspection/playback can contact torrent peers,
  trackers, and web seeds. Bridge logging is outside HoshiStream's control.
- Initially allow only explicitly selected authorized public sources. Do not
  search every configured bridge indexer automatically. Private/ratio-enforcing
  tracker imports are deferred: temporary TorrServer streaming is not a promise
  of sustained seeding or compliance with tracker client rules. A private torrent
  must not be "converted" to a stripped magnet to bypass those requirements.

## Delivery plan

| Phase | Deliverable | Exit condition |
|---|---|---|
| 0. Scope and provider spike | Approve search exception; new ADR; choose reviewed catalog items; capture source/API fixtures; settle torrent parser and credential/config contracts | Rights provenance and usable torrent metadata exist for a useful starter set; adapter and redirect behavior are demonstrated; no unapproved dependency |
| 1. Curated vertical slice | Feature gate, provider DTOs/cache, curated search, bounded torrent resolution, idempotent library import, Add Media search/review, docs | User can search, save once, restart, open/inspect the entry, and retain existing manual-add/playback behavior |
| 2. Optional local Prowlarr | Host-side URL/key/indexer configuration; JSON adapter; safe proxy-link resolution; partial failure UX | Authorized selected torrent sources work without invoking Prowlarr's download-client actions |
| 3. Optional local Jackett | JSON adapter against tested versions; per-indexer outcomes and field normalization | Same UI/import contract works without leaking API keys or requiring Torznab XML |
| 4. Series and interoperability | Explicit "Add source to existing series", season hint, collision review; generic Torznab only if needed | Existing extra-source semantics preserved; no implicit episode replacement |

Phases are independently approved/shipped. The owner approved phases 0-1,
including `bencode` and its transitive dependency, then approved the remaining
phases 2-4; see [ADR 0016](../decisions/0016-opt-in-curated-torrent-search.md)
and [ADR 0017](../decisions/0017-local-search-bridges-and-series-import.md).
The first release can create Movie or Series entries, but does not attach a
search result to an existing series. That later flow must explain that the most
recent source wins overlapping episodes, append atomically without lost updates,
invalidate inspection cache, and account for managed extra-source file cleanup.

Do not let export imply that a `.torrent` file is embedded in JSON. Document the
managed-file backup requirement and surface omitted/non-portable sources in export
feedback as part of phase 1. Full portable archive packaging is a separate scope.

### Acceptance coverage

Use the existing Vitest setup, fake HTTP servers, and synthetic authorized
fixtures; normal tests must not query real indexers or download media.

- Provider contracts: missing fields, empty results, partial/all failures,
  malformed bodies, expired results, cancellation, limits, and rate limiting.
- Import: supported magnets and torrent bytes, invalid bencode, oversized files,
  hash equivalence, existing primary/extra-source duplicates, concurrent Adds,
  lost-response/restart retries, and staged-file cleanup after interrupted writes.
- Boundaries: missing bearer token, arbitrary URLs, redirect/DNS cases, injected
  markup, secret-bearing errors, provider disconnect, and no unsolicited network
  requests or TorrServer registrations during search.
- Persistence/regression: legacy libraries, tag normalization, JSON reload,
  export warnings, torrent upload, manual magnets, local files, and playback.
- UI: keyboard-only flow, small viewport, Back preserves review/search state,
  double-click protection, honest saved/uninspected state, recoverable failure.

Run the repository's typecheck, tests, lint, format check, and build for each
implementation phase. Use `tests/management.test.ts` for current asset contracts,
but do not mistake string assertions for interaction coverage; add testable pure
state helpers and perform a manual browser pass with the existing tooling.

## Source notes and outstanding decisions

Implementation notes for phases 0-1: the catalog gate passed for Big Buck Bunny,
Sintel, and Elephants Dream. Torrent SHA-256 pins, v1 hashes, exact film paths and
sizes are recorded in code; [catalog evidence](../changelog/curated-torrent-search.md)
records primary rights sources. Reviewed-file selection is necessary because
the largest video in the Sintel bundle is a documentary. The first transport is
public IPv4/HTTPS only, uses no automatic retries, and isolates `bencode` in a
bounded worker. These choices preserve the no-new-TorrServer-endpoints boundary.

Primary sources inspected on 2026-09-05; upstream branch links are mutable and
must be pinned to a release/commit during phase 0.

- [Prowlarr SearchController](https://github.com/Prowlarr/Prowlarr/blob/develop/src/Prowlarr.Api.V1/Search/SearchController.cs):
  GET performs JSON search; POST grabs through a configured download client.
  Do not use that POST for HoshiStream imports. Both download and magnet fields
  can be rewritten into proxy links.
- [Prowlarr SearchResource](https://github.com/Prowlarr/Prowlarr/blob/develop/src/Prowlarr.Api.V1/Search/SearchResource.cs)
  and [ReleaseResource](https://github.com/Prowlarr/Prowlarr/blob/develop/src/Prowlarr.Api.V1/Search/ReleaseResource.cs):
  query/indexer/category parameters and nullable torrent fields. Exclude Usenet
  results. Per-indexer failure visibility must be established in the spike;
  the search controller can return an empty list after some exception paths.
- [Jackett ResultsController](https://github.com/Jackett/Jackett/blob/master/src/Jackett.Server/Controllers/ResultsController.cs):
  `GET /api/v2.0/indexers/{indexerId}/results` is a JSON manual-search endpoint
  with query/filter parameters and per-indexer outcomes; Torznab is separate.
  The JSON API exists in source, but compatibility still needs versioned fixtures.
  This controller accepts the API key through query parameters.
- [Jackett API reference](https://github.com/Jackett/Jackett/wiki/Jackett-API)
  and [installation instructions](https://github.com/Jackett/Jackett#installation);
  [Prowlarr installation](https://wiki.servarr.com/prowlarr/installation).
- [Internet Archive metadata read API](https://archive.org/developers/md-read.html):
  JSON metadata and file lists; missing/error responses require explicit handling.
- [Internet Archive item model](https://archive.org/developers/items.html):
  permanent download URLs can redirect to storage hosts; community collections
  accept uploads and are not rights-verification boundaries.
- [Existing TorrServer contract](../api/torrserver-endpoints-used.md):
  reuse current client methods. This plan adds no TorrServer API calls; any new
  endpoint or claim about unsupported torrent formats requires source/Swagger
  verification against the pinned build.

The original brainstorming task changed documentation only. Approval now covers
all four implementation phases and the original parser dependency. Generic
Torznab remains conditional: both supported bridges expose JSON interfaces, so
there is no current reason to add XML parsing or another dependency.
