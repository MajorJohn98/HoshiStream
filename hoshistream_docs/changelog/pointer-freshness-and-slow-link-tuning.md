# Pointer freshness and slow-link TorrServer tuning

Fixes two field reports: the pointer server kept redirecting to an old LAN
address after a successful push, and playback on the TV buffered heavily on a
~9 Mbps line.

## Pointer server (`pointer/`)

- **Immutable Blob versions** ([ADR 0024](../decisions/0024-immutable-pointer-blob-versions.md)).
  `lib/store.ts` no longer overwrites a record in place. Each push writes a new
  blob under `hoshistream-pointer-v3/<tokenHash[:32]>/<epoch-ms>-<nonce>.json`;
  reads `list` the prefix and open the greatest pathname, which the CDN has
  never cached. Superseded versions and the tenant's old `v2` blob are deleted
  best-effort after a push. Deletion removes every version plus the `v2` blob.
- **Why.** Vercel's Blob CDN served an overwritten record for four days despite
  `Cache-Control: max-age=60` and cache-busting query strings. `get(...,
{ useCache: false })` does not bypass the CDN on a public store.
- **Compatibility.** Tenants without a `v3` version fall back to their `v2`
  record until their next manual push; the Redis backend is untouched.
- `@vercel/blob` 2.0.0 → 2.8.0 (for `get`, `list` cursors and `abortSignal`).
- `lib/relay.ts` gains `recordBlobPrefix` and `recordBlobVersionPathname`.
- Tests: `tests/store.test.ts` covers versioned writes, cleanup failure
  tolerance, newest-wins ordering across pages, `v2` fallback, and deletion.

**Operator action:** redeploy the pointer server, then push once from the app
(Pointer → Update Remote Pointer) so the record moves onto `v3`.

## TorrServer tuning (`packaging/torrserver-settings.json`)

There is no application-side buffer: the add-on hands TorrServer's `/play`
URL straight to the player, so TorrServer's piece scheduling and the network
are the only levers. Two shipped defaults changed:

| Setting            | Before | After | Reason                                                                                                                                                                                                                                                                           |
| ------------------ | ------ | ----- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `UploadRateLimit`  | `0`    | `128` | `0` is unlimited. On an asymmetric ~9 Mbps line an unthrottled uplink saturates, ACKs queue behind uploads, and download throughput collapses right when the reader needs it. 128 KB/s (~1 Mbps) keeps reciprocity without swamping an unknown uplink; raise it on fatter lines. |
| `ConnectionsLimit` | `200`  | `100` | MatriX.141's `setLoadPriority` requests up to `ConnectionsLimit / readers` pieces at once, so 200 spreads a slow link across far-ahead pieces instead of finishing the pieces the playhead needs next. 100 still saturates a 9 Mbps line many times over.                        |

Cache size, read-ahead (75 %), preload (40 %), `ResponsiveMode` and the
disk-backed cache are unchanged.

**Existing installs:** `settings.json` is seeded from the shipped file only
when missing, so update `<state dir>/torrserver/config/settings.json` by hand
(app stopped) or delete it to re-seed. See
[setup-native-macos.md](../guides/setup-native-macos.md#torrserver-tuning).
