# 0027 - Advertise only the private picker catalogs

Status: accepted (2026-09-30). Supersedes the "Continue Watching is a Stremio
catalog per type" point of
[0025](0025-watched-state-from-observed-reads.md); the rest of 0025 stands.

## Context

The served manifest advertised, per type, the picker catalog, Continue
Watching, Recently added, Unwatched and up to eight pinned-tag rows. In Nuvio
this became a long stack of HoshiStream rows, and Nuvio already shows its own
unified Continue Watching row at the top of the home screen, so the add-on's
per-type Continue Watching rows duplicated it.

## Decision

The manifest advertises only two catalogs: **Private Movies**
(`private-movies`) and **Private Series** (`private-series`), both with
`search`, `genre` and `skip` extras.

The `continue-watching`, `recently-added`, `unwatched` and `tag-<key>` catalog
handlers stay in place so a client that cached an older manifest still gets a
valid response. Tag pinning (`PATCH /api/tags/{name}` with `{pinned}`) is kept
but no longer adds a row.

Watched state itself is unchanged: it is still derived from observed reads,
drives the Watched column and the TorrServer `/viewed` mirror, and
`defaultVideoId` resume hints are still produced by the (now unadvertised)
Continue Watching handler.

## Consequences

- Clients must refresh the manifest (reinstall the add-on) and the pointer
  must be pushed again before the rows disappear.
- Restoring a row is a manifest-only change; the handlers and their tests
  remain.
- The Tags page still offers "Pin to Board", which currently has no visible
  effect in clients.
