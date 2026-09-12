# 2026-09-12 — Stale pointer reads and slow-link TorrServer tuning

## Findings

### Pointer server serves a stale record

- The installed Mac pushed `http://192.168.1.4:7001` on 2026-09-11 and the
  service answered `200 {ok:true}`; the Blob object under the tenant's token
  hash holds that record.
- `GET /api/pointer/status` and the `/addon/<token>/…` relay on the same
  deployment still answer with `http://192.168.1.2:7001` from 2026-09-08 — a
  version that no longer exists in storage.
- Cause: `pointer/lib/store.ts` reads records through the **public blob CDN
  URL** (`head()` then `fetch(blob.url?ts=…)`). Vercel's CDN ignores the query
  string and, despite the documented 60 s propagation window, kept serving the
  overwritten object for days in the function's region. Writes were never
  lost; reads were stale.
- The addon's local state is correct and honest ("registered"), which is why
  the dashboard showed no problem while TVs were redirected to a dead IP.

### Streams buffer on the TV (Nuvio, LAN)

- HoshiStream hands TorrServer's `/play/{hash}/{id}` URL to the player; there
  is no add-on-side buffer. Buffering is governed by the swarm, TorrServer's
  reader/cache settings, and the player.
- The last measured downlink is **9.3 Mbps**.
- Verified against MatriX.141 source
  (`server/torr/storage/torrstor/cache.go`, `reader.go`, `torrent.go`,
  `btserver.go`):
  - The reader read-ahead is a fixed 16 MiB (`updateRA`).
  - `setLoadPriority` requests up to `ConnectionsLimit / readers` pieces at
    once beyond that window; with the shipped `200` that fans a slow downlink
    across hundreds of megabytes of far-ahead pieces at `Normal` priority.
  - `UploadRateLimit: 0` is unlimited upload (`btserver.go`). On an
    asymmetric ~10 Mbps link an unthrottled uplink delays ACKs and collapses
    download throughput — the classic cause of rebuffering with upload on.
- `scripts/native-server.mjs` seeds `settings.json` only when missing, so
  existing installs never receive updated tuning automatically.

## Plan

1. **Pointer** — stop overwriting Blob records in place. The SDK's
   `get(pathname, { useCache: false })` turned out to be a no-op on a public
   store (only private stores get the `?cache=0` origin read, and this store
   is public), so instead every push writes a new immutable blob under
   `hoshistream-pointer-v3/<tokenHash[:32]>/`, reads `list` the prefix and
   open the greatest pathname (never CDN-cached), and superseded versions are
   deleted best-effort. Verified live: three successive writes each read back
   fresh; `list` was immediately consistent. Requires `@vercel/blob` 2.0.0 →
   2.8.0 (pointer package only; the addon's runtime dependencies are
   unchanged). Recorded as [ADR 0024](../decisions/0024-immutable-pointer-blob-versions.md).
   Deploy manually to production (ADR 0012: manual pushes only), then push once
   from the app so the record moves onto `v3`.
2. **TorrServer tuning** — in `packaging/torrserver-settings.json` set
   `UploadRateLimit: 128` (KB/s; the uplink is unmeasured, so start
   conservatively) and `ConnectionsLimit: 100`; keep the 4 GiB cache and 75 %
   read-ahead. Document how to apply the change to an existing install,
   because the launcher does not overwrite a seeded file.
3. Validate: `npm run typecheck && npm test && npm run lint &&
   npm run format:check` in `addon/`; `npm run typecheck && npm test` in
   `pointer/`.

Outcome: [changelog/pointer-freshness-and-slow-link-tuning.md](../changelog/pointer-freshness-and-slow-link-tuning.md).

## Out of scope

- Runtime reconfiguration of TorrServer through `/settings` (not in the
  verified endpoint subset).
- Any client-side buffer control for Nuvio/Stremio.
