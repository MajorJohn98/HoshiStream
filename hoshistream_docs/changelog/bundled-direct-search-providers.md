# Bundled direct search providers

The owner-approved shortlist is available directly in Add Media: **YTS**,
**Nyaa**, and **1337x**. No Jackett/Prowlarr URL, key, installation or account is
required for these adapters. Existing optional bridges remain available.

YTS uses its documented JSON API, Nyaa searches anime category `1_0`, and 1337x
uses search/detail HTML. Results reuse the existing new-entry and series-preview
flows. Only explicit Add/preview actions resolve a source; search never registers
a torrent with TorrServer.

HTML is parsed by `parse5` in a memory/time-bounded worker without executing page
scripts. Requests use source-specific origin allowlists, public address pinning,
body limits, cancellation and request spacing. Challenge pages and HTTP denials
are visible failures, not empty results or a trigger for browser automation.

## Availability and provenance

- [YTS API documentation](https://yts.gg/api) names
  `https://movies-api.accel.li/api/v2/` and states that no API key is required.
  The host returned a valid JSON empty response for an open-film metadata query.
- Nyaa's public search page was reachable and advertises its RSS representation.
  The adapter uses the HTML result table, not an unofficial API service.
- 1337x returned HTTP 403 from this connection. The adapter is included and its
  page parsing is covered by synthetic fixtures, but live searching remains
  subject to the site's access policy. No mirror or challenge bypass was used.

Only approved metadata endpoints were probed; no media was downloaded.
Provider definitions need maintenance if hosts, schemas, or page structure change.
See [ADR 0018](../decisions/0018-bundled-direct-search-providers.md).
