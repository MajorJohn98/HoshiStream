# TorrServer settings UI and Board rows — implementation plan

Date: 2026-09-13
Status: **Done** — see [TorrServer settings UI](../changelog/torrserver-settings-ui.md) and [Board rows and identity](../changelog/board-rows-and-identity.md)
Parent: [Playback, pointer and library expansion plan](2026-09-12-playback-pointer-library-expansion-plan.md) — Phases 10 and 15.

## Why these two

Phase 3 stays parked on evidence, Phase 11 needs signing identities and CI
runners, and Phase 13 has an open Nuvio-thumbnail question. Phases 10 and 15
are self-contained, need nothing outside the repo, and both close visible
gaps: tuning TorrServer means editing JSON today, and the add-on tile on the
Board is blank with a single picker catalog per type.

## Phase 10 — TorrServer settings UI

### TorrServer facts (pinned commit `d266990`)

- `POST /settings {action:"get"}` returns the full `sets.BTSets` struct.
- `POST /settings {action:"set", sets}` calls `sets.SetBTSets`, which
  **replaces the whole struct** (unknown/missing keys reset to zero and then
  to failsafes: `CacheSize 0 → 64 MiB`, `ConnectionsLimit 0 → 25`,
  `TorrentDisconnectTimeout 0 → 30`, `ReaderReadAHead` clamped 5–100,
  `TorrentsSavePath "" → UseDisk=false`). It persists the struct through
  `tdb.Set("Settings","BitTorr",…)`, then drops every torrent, sleeps 1 s,
  disconnects and reconnects the BitTorrent client, sleeps 1 s, and returns
  200 with an empty body.
- With `StoreSettingsInJson: true` (our shipped default) the `Settings`
  xpath routes to `JsonDB`, which writes `<configRoot>/settings.json` (the
  same file `scripts/native-server.mjs` seeds). So TorrServer itself keeps
  `settings.json` in sync; the add-on must **not** write that file too — a
  second writer would race the one TorrServer performs inside `set`.
- `UploadRateLimit` / `DownloadRateLimit` are KiB/s (`× 1024` in
  `torr/btserver.go`), `0` = unlimited. `CacheSize` is bytes.
  `TorrentDisconnectTimeout` is seconds. `ReaderReadAHead` is a percentage.
- `{action:"def"}` applies TorrServer's own defaults, **not** ours — "Reset to
  shipped defaults" therefore reads `packaging/torrserver-settings.json`.

### Design

1. `TorrServerClient.updateSettings(patch)`: fetch the raw struct with a
   passthrough schema (kept inside the method — never returned or logged),
   merge the six edited keys, `POST /settings {action:"set", sets}` once
   (no retry — the call is not idempotent from the viewer's point of view).
   `TorrServerClient.settings()` (Phase 9) remains the redacted read path.
2. `src/torrserver-settings.ts`: the six tunable keys, Zod validation
   (non-negative integers; `ReaderReadAHead` 5–100; `ConnectionsLimit` ≥ 1),
   loading the shipped defaults from `packaging/torrserver-settings.json`
   (`new URL("../../packaging/…", import.meta.url)` resolves in both the dev
   tree and the bundle, which keeps `addon/dist` and `packaging/` side by
   side), and the ~10 % upload suggestion helper.
3. Routes (`src/routes/system-api.ts`):
   - `GET /api/torrserver/settings` → `{ current, shipped, suggestion }`.
     `suggestion` is `{ uploadRateLimit }` only when the current value still
     equals the shipped one and a speed-test measurement exists.
   - `PUT /api/torrserver/settings` — body is any subset of the six keys;
     `409 streaming_active` while `recentStreamActivity()`; `400
     invalid_body` on validation failure; `503 torrserver_unavailable`
     otherwise. Logs `torrserver_settings_updated` with key names only.
   - `POST /api/torrserver/settings/reset` — same guards, applies the six
     shipped values.
4. UI (System → Status): a "TorrServer tuning" section with the six fields,
   a confirm step that states "TorrServer reconnects and drops active
   torrents; anything playing now will stall", a Reset button, and the
   optional upload suggestion as an "Apply suggestion" button that only
   fills the field (the viewer still confirms).
5. Tests: refusal while streaming, full-object write preserves unknown
   fields (e.g. `TorznabUrls`), validation, reset, suggestion logic, asset
   assertions in `management.test.ts`.

Exit criterion (from the parent plan): changing `UploadRateLimit` in the UI
is reflected by `/settings get`; `settings.json` agrees after restart because
TorrServer writes it inside `set`.

## Phase 15 — Board rows and add-on identity

1. `src/manifest.ts` gains `manifestForLibrary(base, items, identity)`,
   replacing `manifestWithGenres`, that builds per type: the existing
   picker catalog, **Recently added** (`hoshistream-recent-<type>`),
   **Unwatched** (`hoshistream-unwatched-<type>`), and one catalog per
   pinned tag (`hoshistream-tag-<key>`, name = tag, capped at 8 pinned
   tags, ordered by pin order).
2. Catalog filtering (`src/catalog.ts`): `recent` sorts by `addedAt` desc,
   `unwatched` drops items whose watch state is `finished` (movies) or
   where every known episode is finished (series), `tag-<key>` matches
   items carrying that tag.
3. Identity: `manifest.logo`, `manifest.background` point at bundled
   assets served from the add-on; `contactEmail` comes from a new
   viewer-set field persisted with the onboarding/preferences store
   (default empty, omitted from the manifest when empty).
4. Series meta embeds `videos[].streams` for episodes whose inspection is
   already cached; uncached episodes keep relying on the `stream` resource.
5. Tests: manifest generation with pinned tags (cap, ordering), catalog
   filtering for the new ids, embedded streams present only when cached.

As built (differences from the sketch above): catalog ids are
`recently-added`, `unwatched` and `tag-<key>` (shared across types, like
`continue-watching`); `manifestWithGenres` is kept and `manifestForLibrary`
wraps it; Recently added orders by `createdAt`; Unwatched lists entries with
no watch state on any file; no `background` field (no artwork exists); the
contact address lives in its own `identity.json` behind `/api/identity`;
pins live in `tags.json` behind `PATCH /api/tags/{name} {pinned}`.

## Verification

From `addon/`: `npm run typecheck && npm test && npm run lint &&
npm run format:check`. Docs: changelog entries, API reference rows,
`torrserver-endpoints-used.md` (`/settings set`), parent plan status.
