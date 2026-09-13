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
- Catalogs: `private-movies`, `private-series` — both support optional `search`, `genre`, and `skip` extras (pagination). The `genre` extra's `options` are the current tag registry, filled in when the manifest is served (and when it is pushed to the pointer server), so Stremio's genre picker tracks the Tags page.

## Routes

```text
GET /addon/{token}/manifest.json
GET /addon/{token}/catalog/{movie|series}/{catalogId}[/{extra}].json
GET /addon/{token}/meta/{movie|series}/{id}.json
GET /addon/{token}/stream/{movie|series}/{id}.json
```

`{extra}` is a URL-encoded query string (e.g. `search=title`, `genre=Comedy`, or `skip=100`). `genre` matches entry tags case-insensitively; catalog and meta previews carry the entry's tags as `genres`. Both previews also carry whatever presentation metadata the entry has (`releaseInfo`, `runtime`, `imdbRating`, `cast`, `director`, `writer`, `country`, `language`, `logo`, `awards`, `trailers`), the entry's `posterShape` (default `poster`), `links[]` for every tag (`Genres`) and cast member (`Cast`) as `stremio:///search?search=<name>`, and — for movies — `behaviorHints.defaultVideoId` set to the entry id so the detail page opens straight into the stream picker. A movie without a typed `runtime` gets one derived from its current source's probe (`"1h 52m"`). When Cinemeta enrichment ([ADR 0026](../decisions/0026-opt-in-cinemeta-metadata-enrichment.md)) has cached a poster, background, or logo, catalog and meta previews on the tokenized path replace that URL with `{base}/artwork/{token}/{entryId}/{kind}` on the origin the client reached; entries without a cached copy keep their stored URL. Manifest, catalog, meta, and stream responses are served with `cache-control: no-store` so library changes appear immediately; all responses send `access-control-allow-origin: *`.

## IDs

- Movies and series: `hoshi:<uuid>`
- Series episode streams: `hoshi:<uuid>:<season>:<episode>`

## Stream objects

For torrent entries, the stream `url` is TorrServer's `/play/{hash}/{id}` with its origin derived from the request `Host` header (hostname of the request plus the configured TorrServer port), falling back to `PUBLIC_TORRSERVER_URL` when the header is missing or has no hostname — playback bypasses the add-on. When the request arrives through a Cloudflare Tunnel and its `CF-Connecting-IP` matches the server's own public IP (`LAN_REDIRECT=auto`, the default), the configured LAN fallback URLs are returned instead so at-home clients stream directly over the local network (ADR 0007). Successful inspections are cached on the entry (ADR 0006), so repeat stream requests answer without re-polling torrent metadata. For local entries, the `url` points at the add-on's range-capable `/local/{token}/{entryId}/{fileId}` route, with the same Host-derived origin. Torrent entries with an enabled disk copy instead get the add-on's stable `/media/{token}/{entryId}/{sourceKey}` route, which serves each range from the disk copy when its drive is online and proxies TorrServer otherwise — the client keeps one URL while sources come and go. All include:

```json
{
  "name": "HoshiStream",
  "description": "Torrent · 1080p · H.264 · E-AC3 · 1.4 GB\n6.2 Mbps average\nfits your line",
  "behaviorHints": {
    "filename": "path/inside/torrent.mkv",
    "videoSize": 1400000000,
    "bingeGroup": "hoshistream-hoshi:<uuid>"
  }
}
```

The `description` is plain text, up to four lines, built from the cached probe: source label (`Torrent`, `Disk`, `Disk (syncing)`, `Local`), resolution class, video and audio codec, and size on the first line; the average bitrate when known; any `Check player:` caveat; and the line-fit verdict (`fits your line` / `above your line · needs N Mbps, line ~M Mbps`) when both the bitrate and a home speed test exist. Fields the probe did not fill are omitted rather than shown as unknown. Two optional hints appear on the direct stream only:

- `notWebReady: true` when the probe found a format browsers cannot decode natively — HEVC/H.265, MPEG-4 ASP, VC-1, MPEG-2 video, DTS/DTS-HD/TrueHD/Blu-ray PCM audio, or an AVI container — so Stremio Web offers its external-player path. Repaired (`Compatible • …`) streams never carry it.
- `videoHash`: the OpenSubtitles hash (file size plus the sum of the first and last 64 KiB as 64-bit little-endian words, 16 hex digits) for Stremio's built-in subtitle matching. Computed only from files already on local disk — local entries and complete disk copies whose drive is online — never over TorrServer's `/play`, and cached by path, size and mtime.

Series episodes are resolved from filename patterns (`S01E02`, `1x02`) or `fileOverrides`, then any `episodeOverrides` (manual repairs) are applied on top and win over both filename parsing and later-source replacement; files under bonus-content folders (featurettes, deleted scenes, extras) are excluded when real episodes exist. A missing match returns `{"streams":[]}`.

## Repaired streams (ADR 0010)

When `TRANSCODE_ENABLED=true`, the stream list can contain additional entries beside the direct one:

- **`Compatible • …`** — offered when the probe verdict predicts a playback failure (MKV/AVI container, DTS/TrueHD-class audio, or an undecodable video codec) or when the entry sets `forceTranscode`. The `url` points at the add-on's `/hls/{token}/{entryId}/{fileId}/auto/index.m3u8`; the repair tier (copy-only remux, AC3 audio fix, or hardware video re-encode) is chosen server-side from the verdict.
- **`Lower bitrate • N Mbps`** — offered to remote clients (a `CF-Connecting-IP` that does not match the server's public IP) when the original bitrate exceeds `TRANSCODE_VIDEO_BITRATE_MBPS`. Uses the `/video/` variant, a hardware re-encode at the configured bitrate.

Repaired playlists are EVENT-type HLS and show no total duration until the session finishes encoding the whole file.
