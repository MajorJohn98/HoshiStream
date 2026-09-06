# 0017 - Local search bridges and reviewed series imports

Status: accepted (2026-09-05).

## Context

After the curated release, the owner approved the remaining phases of the
[torrent-search plan](../plans/2026-09-05-torrent-search-plan.md): local Prowlarr,
local Jackett, and adding search results to an existing series.

This extends the scope recorded in ADR 0016 without changing that accepted record.
The legal-media, private-by-default, native-deployment and JSON-library boundaries
remain in force.

## Decision

Use the bridges' JSON search APIs through small server-side adapters. Prowlarr
and Jackett are optional, separately installed and managed services; HoshiStream
does not install them, configure their indexers, manage their databases, or send
jobs to their download clients. Generic Torznab is unnecessary for these adapters
and remains deferred. No additional runtime dependency is authorized or needed.

Connection URLs, API keys and explicit indexer ID lists live in host configuration.
Permit only configured loopback service origins, including an optional base path.
Never implicitly search all configured upstream indexers. Only indexers verified
as public are eligible; unknown, semi-private and private sources are excluded.
This is not a guarantee of rights in every search result: the owner remains
responsible for authorization.

All external response shapes are validated. Search returns normalized display
metadata and opaque result IDs; raw source locators and credentials stay on the
server. Source retrieval validates redirect destinations and does not forward
credentials to external origins. Public HTTPS download destinations use validated
and pinned public addresses. Resource limits and partial-provider errors remain
visible. Provider failure must not become an empty-success result.

Adding to a series is a separate review-and-confirm operation. The owner chooses
the target and optional season hint, explicitly requests metadata inspection,
then reviews added and overlapping episodes. Replacements require confirmation.
The serialized library mutation rechecks source revision, duplicate identity and
idempotency so a stale preview cannot overwrite intervening source changes.
The most recently appended source retains the existing overlap precedence.

Managed extra-source files retain server-owned provenance and ownership through
edits and reorderings. Removing a source or entry cleans up only managed files
that are no longer referenced; external/user-owned files are never deleted.
Uncommitted preview files are bounded, expire, and are reclaimed on cancellation
or shutdown.

## Consequences

- One Add Media workflow serves curated and configured provider searches.
- Bridge setup and authentication remain local administrative work, not a new
  management dashboard or credential editor.
- Metadata preview can contact peers through the existing TorrServer client;
  ordinary search does not register torrents.
- An uninspected target may need inspection before an accurate overlap review.
- Provider versions and JSON fixtures must be kept aligned with upstream source.
- Disabling search or disconnecting a bridge does not invalidate already saved
  magnets/torrent files or replace the existing playback implementation.
