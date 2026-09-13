# 0006 — Persist torrent inspection results on library entries

## Status

Accepted (2026-08-12)

## Context

TorrServer closes inactive non-persisted torrents after five minutes, so every
stream or series-metadata request re-registered the torrent and polled for
metadata with a 30-second deadline. Slow or flaky metadata fetches made stream
starts slow and occasionally returned empty stream lists.

## Decision

A successful inspection stores `{hash, selectedFiles, inspectedAt}` on the
library entry (`inspectionCache`). Stream and series-metadata resolution
re-adds the torrent (a single fast, idempotent call) and answers from the
cache without polling. The cache is invalidated when `type`, `magnetUri`,
`torrentFilePath`, `localFilePath`, `localFolderPath`, `preferredFileIndex`,
or `fileOverrides` change. The management inspect action always performs a
full inspection and refreshes the cache. The cache is not settable through the
management API.

## Consequences

- Stream resolution for known entries is near-instant and immune to
  metadata-fetch flakiness.
- The JSON library remains the only store; no database is introduced.
- A torrent whose file list changes under the same info hash would serve stale
  selections until re-inspected — acceptable because info hashes pin content.
- Follow-up (2026-09-13): a source edit through the management API now starts
  the refill inspection in the background, one inspection is shared between
  concurrent callers, and cached series `meta` answers from the cache without
  waiting on the re-add (which moves to the background, as for movies). Before
  this, adding a second season's torrent and opening the show in Stremio ran
  the full multi-source inspection inside the meta request and timed out.
