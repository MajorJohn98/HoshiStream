# TorrServer settings UI

Date: 2026-09-13
Phase 10 of the
[expansion plan](../plans/2026-09-12-playback-pointer-library-expansion-plan.md);
implementation notes in
[2026-09-13-torrserver-settings-and-board-rows-plan.md](../plans/2026-09-13-torrserver-settings-and-board-rows-plan.md).

## What changed

- **System → Status → TorrServer tuning.** A form for the six knobs that
  matter for direct play: `UploadRateLimit`, `DownloadRateLimit` (KiB/s,
  `0` = unlimited), `ConnectionsLimit`, `CacheSize` (edited in MiB), `ReaderReadAHead` (%)
  and `TorrentDisconnectTimeout` (s). Values are read live from TorrServer; the
  shipped default is shown under each field.
- **Confirm before apply.** Applying triggers TorrServer's `settings set`,
  which drops every torrent and reconnects its BitTorrent client. The section
  says so up front and the button asks again before sending. The server refuses
  with `409 streaming_active` while any stream was active in the last five
  minutes, so nobody's playback is cut mid-episode.
- **Reset to shipped defaults** re-applies the six values from
  `packaging/torrserver-settings.json` — HoshiStream's defaults, not
  TorrServer's own `def` set.
- **Upload-cap suggestion.** After a speed test, while `UploadRateLimit` still
  equals the shipped `128`, the page offers roughly 10 % of the measured
  download line (never below 64 KiB/s) with a **Use suggestion** button that only
  fills the field. Nothing is applied silently.

## API

- `GET /api/torrserver/settings` → `{ current, shipped, suggestion }`.
- `PUT /api/torrserver/settings` with any non-empty subset of the six keys.
- `POST /api/torrserver/settings/reset`.

All three are bearer-token routes with `no-store`. Details in the
[management API reference](../api/management-api-reference.md).

## How the write works

`TorrServerClient.updateSettings(patch)` re-reads the **full** settings struct
with a passthrough schema (kept inside the method — the Phase 9 `settings()`
read still strips Torznab keys, the TMDB key, TLS paths and the save path),
merges the edits, and posts `{action:"set", sets}` once. TorrServer's
`sets.SetBTSets` replaces the whole struct, so sending only the six keys would
zero everything else. Verified at the pinned commit `d266990`
(`web/api/settings.go`, `server/settings/btsets.go`, `server/torr/apihelper.go`).

The plan originally called for the add-on to also write `settings.json`. It does
not: with `StoreSettingsInJson: true` (our shipped default) TorrServer persists
the struct through its `JsonDB`, which writes exactly that file inside the `set`
call. A second writer would only race it. The supervisor keeps rewriting
`BitTorr.TorrentsSavePath` at start and leaves every other key alone, so the
values survive a restart.

## Logging

`torrserver_settings_updated` carries the edited key names and a `reset` flag —
never the values or anything else from the struct.

## Tests

`tests/torrserver-settings.test.ts` (validation, shipped-file loading,
suggestion maths, and the routes against a fake TorrServer: token, full-struct
write that preserves `TorznabUrls`/`TMDBSettings`, streaming refusal, invalid
bodies, reset, 503 mapping), `updateSettings` cases in
`tests/torrserver-client.test.ts`, and asset assertions in
`tests/management.test.ts`.
