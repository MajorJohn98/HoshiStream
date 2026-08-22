# Frontend redesign + transcoding integration plan

Date: 2026-08-23
Status: draft
Related: [ADR 0010](../decisions/0010-opt-in-realtime-transcoding.md),
[2026-08-23-realtime-transcoding-plan.md](2026-08-23-realtime-transcoding-plan.md)

## Goal

Redesign the browser management UI on Preact + htm (no build step) and surface the new
transcoding capability in it, while keeping the addon's static-file serving model and the
two-runtime-dependency rule intact.

## Dev mode (no Docker, no app packaging)

Verified working on Node 26:

```bash
cd addon
cp .env.example .env       # once; set ACCESS_TOKEN, MEDIA_DIR, TorrServer URLs
npm run dev:tsc            # terminal 1: tsc --watch (recompiles on save)
npm run dev                # terminal 2: node --watch --env-file=.env dist/index.js
```

- `node --watch` restarts the server automatically when `dist/` changes; `--env-file`
  loads `.env` natively (no dotenv dependency).
- Frontend assets (`addon/assets/manage/`) are served **from disk**, so UI edits need
  only a browser refresh — no compile, no restart.
- TorrServer for dev: run the vendored binary directly
  (`packaging/`-fetched binary with `-p 8090`), or point
  `TORRSERVER_INTERNAL_URL` at an already-running native-app instance. The addon starts
  and serves the UI fine without TorrServer; only torrent inspection/streaming needs it.
- Direct `node src/index.ts` does not work: source imports use `.js` specifiers, which
  Node's type stripping does not remap. The tsc-watch pair is the zero-new-deps loop.

## Frontend architecture

**Stack**: Preact + htm, vendored as static ESM files in
`addon/assets/manage/vendor/` (`preact.module.js`, `hooks.module.js`, `htm.module.js`,
~15 KB total). No bundler, no npm dependency, no JSX. Pin exact versions; record them in
a `vendor/VERSIONS` file.

```
addon/assets/manage/
├── vendor/            # preact, hooks, htm (pinned ESM builds)
├── app.js             # root <App/>: routing (hash-based), auth token handling
├── api.js             # fetch wrapper: bearer auth, JSON, error normalization
├── store.js           # app state: library entries, status, active sessions (signals or useReducer)
├── components/        # shared: Card, Modal, Toast, ProgressBar, VerdictBadge
└── views/
    ├── library.js     # grid/list of entries, filter, verdict badges
    ├── detail.js      # entry detail: files, overrides, probe results, transcode controls
    ├── add.js         # magnet / .torrent / local-file add flows
    ├── status.js      # server + TorrServer health, cache usage
    └── sessions.js    # NEW: active transcode sessions (tier, progress, kill)
```

Design notes:

- Hash routing (`#/library`, `#/entry/{id}`) — keeps the single `/manage/{token}` HTML
  shell and token-in-path model untouched (ADR 0004).
- `api.js` is the only module that talks HTTP; views stay pure render + handlers.
- Keep `styles.css` as plain CSS (extend, don't adopt Tailwind — no build step).
- Migrate view-by-view; old and new views can coexist during migration since the shell
  just imports modules.

## Transcoding surface in the UI

| View | Addition |
|---|---|
| Library | Per-entry compatibility badge from probe verdict (Direct ✓ / Repair R/A / Transcode V) |
| Detail | Verdict per file; `forceTranscode` override toggle; bitrate preset picker for tier V |
| Sessions (new) | Live sessions: entry, tier, encode speed, segment count, disk used, kill button |
| Status | ffmpeg presence/version, VideoToolbox availability, transcode toggle state |

Backend endpoints needed (management API, bearer-gated):

- `GET /api/transcode/sessions` — session list (id, entryId, tier, stats)
- `DELETE /api/transcode/sessions/{id}` — kill + clean a session
- `PATCH` on entries already exists — extend schema with `forceTranscode`, `bitratePreset`

## Work order

Backend and frontend interleave so each phase is demoable in dev mode:

### Phase F1 — Foundation (frontend only) — DONE 2026-08-23
1. ~~Vendor preact/htm~~ — done via `vendor/preact-htm.js` (htm 3.1.1
   `preact/standalone.module.js`, a single 13 KB ESM bundling preact + hooks + htm;
   simpler than three files + an import map). Version recorded in `vendor/VERSIONS`;
   vendor dir excluded from ESLint and Prettier.
2. ~~`api.js`, `store.js`, hash router in `app.js`~~ — done. `app.js` keeps legacy
   re-exports (`state`, `api`, `esc`, `fmt`, `notify`, `token`, `headers`, `load`)
   for the unmigrated detail modal.
3. ~~Migrate `status.js`~~ — done.
4. ~~Migrate `library.js` and `add.js`~~ — done. The import-review and Stremio
   modals stay as body-level DOM (outside the preact root), same pattern as the
   detail modal, so they carry over unchanged.

### Phase F2 — Detail view migration — DONE 2026-08-23
1. ~~Rebuild `detail.js`~~ — done. Now a `DetailModal` component rendered by App
   whenever `state.selected` is set (state-driven; the imperative `detailView()`
   entry point is gone). Tabs are components: OverviewTab, SourceTab, FilesTab
   (cached table + mapping table + inspect prompt), PlaybackTab. Shared busy-state
   hooks (`useInspect`, `usePlayHere`) replace manual button-label juggling.
2. ~~Dead code~~ — legacy re-exports removed from `app.js`; `classify-imports.js`
   retained (pure logic, still used by the import-review flow).

### Phase B1 — Transcoding backend (= transcoding plan Phase 1) — DONE 2026-08-23
Tier R/A shipped: vendored ffmpeg, lazy sessions, HLS routes, "Compatible"
stream entries. Details in
[2026-08-23-realtime-transcoding-plan.md](2026-08-23-realtime-transcoding-plan.md).

### Phase FB2 — Transcoding UI
1. Sessions view + management API endpoints (list/kill).
2. Verdict badges in Library/Detail; `forceTranscode` toggle.
3. Status view: ffmpeg/VideoToolbox indicators.

### Phase B2 — Tier V + polish (= transcoding plan Phases 2–3)
Video transcode, bitrate presets in Detail, seek-restart, on-TV validation.

Each phase ends with: `npm run typecheck && npm test && npm run lint &&
npm run format:check`, a changelog note when shipped, and index.md updates.

## Constraints honored

- No new npm runtime dependencies (preact/htm are vendored browser assets, not
  `package.json` deps; ffmpeg is a vendored binary like TorrServer).
- No build step for the frontend; assets remain static files served from disk.
- Token/auth model, structured logging rules, and direct-play-first behavior unchanged.

## In-browser video player (appended 2026-08-23)

Goal: watch library entries directly in the management UI — no handoff to mpv/VLC for
browser-side playback. Architecture impact is minimal: the player consumes URLs the
server already produces (TorrServer `/play`, `/local/{token}/…`, and — once B1 lands —
`/hls/{token}/…`). No new server routes are strictly required.

**Choice: Video.js v10** (Apache 2.0). In 2026 the ecosystem consolidated — Plyr,
Vidstack, and media-chrome merged into Video.js v10, making it the maintained
open-source player. Modular builds run ~25 kB gzipped (≈38 kB with HLS), usable from
static files with no build step, which fits the vendoring model.

- Vendor the pinned player build into `assets/manage/vendor/videojs/` next to
  preact/htm; record the version in `vendor/VERSIONS`. If v10 is not yet GA-stable when
  this phase starts, fall back to **media-chrome + hls.js** (both stable, tiny,
  web-component-based, and on the v10 migration path).
- Extend `manageAssetPath` to serve the vendored player files.

**Player view** (`views/player.js`, route `#/play/{entryId}/{fileId}`):

1. Ask the server for the stream URL (same resolution path Stremio clients use).
2. Source selection mirrors the TV logic:
   - MP4/H.264 local or torrent file → native `<video>` source (direct play).
   - HLS repair/transcode session → HLS source (Safari native; other browsers via the
     player's HLS module).
   - MKV/DTS originals do not play in any browser — the UI shows the verdict badge and
     offers the "Compatible" (tier R/A/V) stream instead. Browser playback is therefore
     a natural consumer of the transcoding pipeline, not a new requirement on it.
3. Resume position kept in `localStorage` (browser-side only; no server state).

**Relation to ADR 0008 (bundled mpv):** unchanged. mpv remains the host-playback path
launched from the app; the browser player covers preview/watch-in-UI. If browser
playback proves sufficient day-to-day, retiring mpv would be a future ADR, not part of
this plan.

**Scheduling:** implement after Phase FB2 (needs the HLS routes from B1 for full
usefulness), before or alongside B2. Direct-play-only preview (MP4 sources) could ship
as early as F2 if wanted.



1. Preact signals vs `useReducer` for the store — signals are nicer for the live
   sessions view (polling updates), but one more vendored file. Proposal: signals.
2. Poll interval for sessions view (proposal: 2 s while visible, stop when hidden via
   `visibilitychange`).
3. Should the redesign also restyle (new visual design) or re-platform first and
   restyle after? Proposal: re-platform first, restyle in F2.
