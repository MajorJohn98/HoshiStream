# 0018 - Bundled direct search providers

Status: accepted (2026-09-05).

## Context

The owner requested YTS, Nyaa.si and 1337x search bundled inside HoshiStream,
without a separately configured Jackett service. The owner explicitly approved
`parse5` and its required `entities` dependency.

This extends the search boundary in ADRs 0016-0017. Those accepted records remain
unchanged; their optional bridge integrations remain available.

## Decision

Ship three direct provider adapters with the Node add-on. When search is enabled,
they appear alongside the curated catalog without service URLs or API keys.
Keep search explicit, authorization the owner's responsibility, and ordinary
search separate from torrent registration or media transfer.

- YTS uses the JSON endpoint documented by its own API page. That page currently
  names `movies-api.accel.li` as the API host; the website is `yts.gg`. This is an
  upstream-hosted API, not a bundled service or a Jackett relay.
- Nyaa uses its HTML search in anime-video category `1_0`.
- 1337x uses HTML search and retrieves a detail page only during explicit source
  resolution. HTTP denial or an interactive challenge is a blocked-source error.

This authorizes HTML parsing only for the named providers. Do not add arbitrary
scrapers, automatic mirror discovery, cookies, CAPTCHA bypass, browser runtimes,
or challenge-solving services.

Parse HTML with `parse5` in a bounded worker, never with a browser or executable
page scripts. HTML is limited to 1 MB, JSON to 2 MB, and torrent metadata to 1 MB.
Workers have memory/time limits and do not inherit Node watch-mode loader
notifications. Reuse the existing validated import, deduplication, receipt,
series-preview, and file-ownership pipeline.

Direct requests use approved HTTPS origins, validated/pinned public addresses,
bounded redirects and deadlines, and per-site request spacing. No credentials,
query history, page bodies, or complete magnets are logged. Unexpected hosts or
page formats fail explicitly; no arbitrary fallback source is selected.

## Consequences

No external search service is needed for these three sources. HoshiStream now
owns maintenance of their page/API adapters and origin lists. Site availability
and automated-access policy are outside the app's control; 1337x returned HTTP
403 from the implementation environment and no bypass was attempted.

The only additional packages are `parse5` and `entities`; no native runtime or
container is added. Public index results are not a rights-reviewed catalog.
