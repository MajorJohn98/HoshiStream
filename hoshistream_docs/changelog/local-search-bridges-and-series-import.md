# Local search bridges and series import

Date: 2026-09-05

Phases 2-4 of the torrent-search plan extend Add Media without changing the
playback engine or adding dependencies.

## Optional provider connections

Configure local Prowlarr and/or Jackett with a loopback URL, API key, and explicit
public indexer IDs. The adapters use JSON APIs; there is no generic Torznab/XML
adapter, service installer, indexer-management UI, or external download-client
handoff.

Search source selection defaults to the curated catalog. Choosing a configured
bridge, or all configured sources, is explicit. Missing provider metadata is
not invented, bridge results do not claim reviewed licensing, and unavailable
providers are reported separately. Results and pagination are bounded, expiring
server-side snapshots.

Source URLs and API keys stay server-side. Connection/redirect policies,
public-indexer checks, torrent-only normalization, bounded bodies/deadlines, and
credential stripping protect source retrieval. Existing magnets and local
torrent files remain usable after a bridge is disconnected.

See [adding media](../guides/adding-media.md#connect-local-prowlarr-or-jackett)
for configuration and [the management API](../api/management-api-reference.md#search-and-reviewed-series-imports)
for the request contracts.

## Provider compatibility references

The JSON contracts were checked against these upstream releases and commits:

| Provider | Reference | Notes |
|---|---|---|
| Prowlarr | [v2.5.2.5491 / c0f8c2c](https://github.com/Prowlarr/Prowlarr/tree/c0f8c2c5bc0d7906e8d97e30a9bb7616f37d7090) | Read-only GET search, `X-Api-Key`, public torrent-indexer metadata, and download proxy routes |
| Jackett | [v0.24.2538 / b248952d](https://github.com/Jackett/Jackett/tree/b248952dc5a6b9efd52b6f3db8de76e0e79307d7) | JSON manual-search results, PascalCase fields, numeric per-indexer status, query-key authentication, and `/dl/{id}/` proxies |

Jackett uses the API-key-authorized `type:public` filtered JSON endpoint with
exactly one configured `Tracker[]` per request. The server filters configured
public indexers before performing a query. This avoids its cookie-only indexer
metadata endpoint without adding browser cookies or disabling authentication.
The source is checked again during resolution. See the pinned
[filter implementation](https://github.com/Jackett/Jackett/blob/b248952dc5a6b9efd52b6f3db8de76e0e79307d7/src/Jackett.Common/Utils/FilterFuncs/FilterFuncComponent.cs),
[meta-indexer filtering](https://github.com/Jackett/Jackett/blob/b248952dc5a6b9efd52b6f3db8de76e0e79307d7/src/Jackett.Common/Indexers/Meta/BaseMetaIndexer.cs),
and [results controller](https://github.com/Jackett/Jackett/blob/b248952dc5a6b9efd52b6f3db8de76e0e79307d7/src/Jackett.Server/Controllers/ResultsController.cs).

Prowlarr can internally turn some upstream errors into empty search results.
The UI discloses that API limitation as information, not a fabricated outage.
Observed failures remain explicit errors. Compatibility fixtures do not configure
or exercise the owner's real indexers.

## Reviewed additions to series

The review step now offers **Create new entry** or **Add to existing series**.
Series import requires an inspected torrent-backed target. An explicit metadata
preview compares new episodes with the current selection; overlapping episodes
require confirmation before saving.

The library commits source append, merged episode cache, and retry receipt
together. Source/selection changes invalidate old previews; unrelated title,
tags, or playback changes do not overwrite the user's work. Newest-source
precedence remains unchanged. Duplicate sources are not appended twice.

Preview cancellation, expiry, and shutdown reclaim uncommitted torrent files.
Periodic orphan reconciliation also catches crash-abandoned files that were too
recent for the startup sweep, while protecting active imports and previews.
Managed additional sources retain ownership through ordinary edits/reordering.
Deletion checks references from other primary sources, extras, and local folders
before removing owned files.

Ordinary UI source updates and JSON import/export omit server-owned metadata.
Import review explicitly flags additional sources that lack restorable locators;
it does not silently drop them. Full portable archive packaging remains out of
scope: back up `library.json` and managed media together.

## Scope boundaries

Prowlarr/Jackett must be installed and configured separately. No private,
semi-private, or ratio-enforcing tracker support is added. Public indexer status
does not establish rights to every result. HoshiStream's library remains atomic
JSON; the externally managed services retain their own internal storage.

See [ADR 0017](../decisions/0017-local-search-bridges-and-series-import.md).
