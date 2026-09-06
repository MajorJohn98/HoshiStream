# 0016 - Opt-in curated torrent search

Status: accepted (2026-09-05).

## Context

The owner approved phase 0 and the first curated-catalog release of the
[torrent-search plan](../plans/2026-09-05-torrent-search-plan.md), and explicitly
approved the `bencode` runtime dependency with its `uint8-util` dependency.
Prowlarr, Jackett, generic Torznab, and adding sources to existing series remain
unapproved later phases.

## Decision

Make a narrow exception to the original no-search boundary: an opt-in Search
source inside Add Media, backed only by a small reviewed catalog of open films.
Use locally matched title/creator metadata and explicit Internet Archive metadata
requests. Do not search unrestricted Archive uploads or ship general-purpose
indexer lists.

Catalog entries include creator rights evidence, license, review date, exact
Archive item/torrent filename, and a pinned SHA-256 of reviewed torrent metadata.
A changed torrent fails closed until a maintainer reviews and updates the pin.
This is source provenance, not a blanket legal guarantee for every use or region.
Catalog maintenance belongs to the repository maintainers.

The browser receives display metadata and opaque, expiring result IDs. Only
**Add to library** resolves torrent bytes and saves an entry. Search and import
do not register anything with TorrServer; inspection remains explicit. Existing
manual imports, library filters, Nuvio/Stremio catalogs, and playback stay intact.
No new TorrServer endpoints are introduced.

Keep `TORRENT_SEARCH_ENABLED=false` by default. There are no search-related
network requests on startup or while typing. Metadata retrieval permits only
Archive HTTPS origins, pins validated public IPv4 addresses for connections,
validates redirects, and caps bytes/time. IPv6-only Archive access is not
supported by this first transport.

Use `bencode@4.0.1` in a memory/time-bounded worker, reject noncanonical or
unsupported/private metadata, and require an exact decode/re-encode match
before hashing the info dictionary. The parser cannot block the main playback
event loop. No new XML parser or external torrent client is needed.

Persist ordinary managed `.torrent` files and JSON library entries. Perform
hash deduplication and idempotency receipt writes inside the existing serialized
library mutation. Receipts survive restart while their entry exists. Imported
provenance and retry metadata are server-owned; no database or search-history
store is added. Staging cleanup touches only marked import-owned directories,
protecting referenced sources.

## Consequences

- New users can complete search/review/save without another service.
- Catalog breadth is deliberately small; missing or changed sources are errors,
  not a reason to search unreviewed content.
- Rights evidence and torrent pins need maintenance. Search does not prove
  seed availability or playback compatibility.
- Uninspected legacy file-backed sources without a known hash may not be
  recognized as duplicates; inspect them first when duplicate detection matters.
- Browser JSON export is not a full backup of file-backed entries. Back up
  `library.json` and the managed media directory together.
- Local-first does not mean anonymous. Archive receives explicit item lookups;
  subsequent explicit inspection/playback can contact peers, trackers, and
  web seeds through TorrServer.
