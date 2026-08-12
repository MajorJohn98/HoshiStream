# Stremio Add-on Protocol

Verified against `addon/src/routes.ts`, `manifest.ts`, and `streams.ts`.

## Tokenized base path

All protocol resources live under `/addon/{ACCESS_TOKEN}/`. The untokenized `/manifest.json` returns `401 {"error":"Use the tokenized add-on URL"}` by design. URL-encode the token if it contains reserved punctuation.

```text
http://<MAC_LAN_IP>:7000/addon/<ACCESS_TOKEN>/manifest.json
```

## Manifest

- id `com.john.private-torrent-streamer`, name **HoshiStream**, version 0.2.0
- resources: `catalog`, `meta`, `stream`; types: `movie`, `series`
- id prefix `hoshi:`; `behaviorHints.p2p: true`
- Catalogs: `private-movies`, `private-series` — both support optional `search` and `skip` extras (pagination)

## Routes

```text
GET /addon/{token}/manifest.json
GET /addon/{token}/catalog/{movie|series}/{catalogId}[/{extra}].json
GET /addon/{token}/meta/{movie|series}/{id}.json
GET /addon/{token}/stream/{movie|series}/{id}.json
```

`{extra}` is a URL-encoded query string (e.g. `search=title` or `skip=100`). Manifest, catalog, meta, and stream responses are served with `cache-control: no-store` so library changes appear immediately; all responses send `access-control-allow-origin: *`.

## IDs

- Movies and series: `hoshi:<uuid>`
- Series episode streams: `hoshi:<uuid>:<season>:<episode>`

## Stream objects

For torrent entries, the stream `url` is TorrServer's `/play/{hash}/{id}` rewritten to `PUBLIC_TORRSERVER_URL` — playback bypasses the add-on. For local entries, the `url` points at the add-on's range-capable `/local/{token}/{entryId}/{fileId}` route. Both include:

```json
{
  "name": "HoshiStream",
  "description": "Torrent • 1.4 GB",
  "behaviorHints": {
    "filename": "path/inside/torrent.mkv",
    "videoSize": 1400000000,
    "bingeGroup": "hoshistream-hoshi:<uuid>"
  }
}
```

Series episodes are resolved from filename patterns (`S01E02`, `1x02`) or `fileOverrides`; a missing match returns `{"streams":[]}`.
