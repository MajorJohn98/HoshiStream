# Library Management & UI Improvement Plan

## Problem
The management UI is a single ~30 KB inline HTML/JS string in `addon/src/management.ts` — hard to maintain, requires `script-src 'unsafe-inline'`, and lags behind the server's capabilities: it never uses the native Finder pickers or the relink API (browser adds always copy files into managed storage), ignores the new inspection cache (re-inspects on every detail open), and the status page is stale (no `streamingActive`, hardcoded "keep Mac awake" warning, fake Settings nav item).

## Approach

### Restructure (no behavior change on its own)
Move the UI out of the template string into static ES modules served from `addon/assets/manage/`:

```
addon/assets/manage/
├── styles.css
├── app.js            # entry: state, router, shared helpers (api, esc, fmt, toast)
├── classify-imports.js  # moved from management.ts (single source of truth)
└── views/
    ├── library.js    # grid, search/filter, import/export, Stremio refresh
    ├── add.js        # source cards, uploads, Finder picker flow
    ├── detail.js     # modal: overview/source/files/playback tabs
    └── status.js     # system status
```

- `management.ts` shrinks to the HTML shell linking `/manage-assets/styles.css` and `/manage-assets/app.js` (module script). `classifyLibraryImports` is deleted from it; tests import the `.js` asset directly (Vitest handles plain ESM).
- `routes.ts`: new `GET /manage-assets/{file}` static route — whitelisted directory, path-traversal guard, correct content types, short cache. Assets contain no secrets so the route is untokenized, like the logo.
- CSP tightens to `script-src 'self'; style-src 'self'` (drops both `unsafe-inline`s).
- No packaging changes needed: Dockerfile and `build-macos-app.sh` already copy `addon/assets/` wholesale.

### Functional fixes
1. **Picker availability in `/api/status`** — report `nativePicker: true/false` (probe the supervisor socket with a cheap `access()`), plus keep `streamingActive`.
2. **Finder integration in Add Media** — when `nativePicker` is true, the Local file / Series folder cards offer "Choose with Finder" (POST `/api/native-picker/{kind}` → `nativePathGrant` on create), so native adds link media in place instead of copying. Browser upload stays as the fallback and the only path in Docker mode.
3. **Relink in the detail view** — Source tab gets "Relink in Finder" for local entries (POST `/api/library/{id}/relink`), shown only when the picker is available. Currently this API is reachable only from the menu-bar app docs.
4. **Cache-aware detail view** — entries now carry `inspectionCache`; the detail modal shows cached hash, selected-file count, and "inspected N min ago" immediately instead of demanding a fresh 30 s inspection. Files/playback editing still triggers a full inspect (management inspect always refreshes the cache by design).
5. **Status page refresh** — show `streamingActive` ("Streaming now" pill), native app vs Docker mode (from `nativePicker`), sleep note becomes accurate (automatic in native mode; caffeinate hint only otherwise), and the fake Settings nav button is removed.

## Todos
1. `ui-extract-assets` — Create `assets/manage/` modules + shell; move classify-imports; keep behavior identical.
2. `ui-static-route-csp` — Serve `/manage-assets/*` with traversal guard and tighten CSP; tests for the route and guard.
3. `status-picker-flag` — Add `nativePicker` to `/api/status`; test.
4. `ui-finder-add-relink` — Finder picker flow in Add Media + Relink button in detail Source tab, gated on `nativePicker`.
5. `ui-cache-aware-detail` — Use `inspectionCache` for instant detail summaries; label cache age; explicit refresh.
6. `ui-status-view` — streamingActive pill, mode indicator, accurate sleep note, remove fake Settings.
7. `ui-validate-docs` — Full validation (typecheck/tests/lint/format, compose config, app rebuild + reinstall), update management API docs, changelog entry, docs index.

## Dependencies
- 1 → 2 (shell links the route) → everything UI-facing (4, 5, 6).
- 3 is independent; 4 and 6 read its flag.
- 7 last.

## Notes
- Update `management.test.ts` expectations: many assert against the old inline string; rewrite to test the shell + asset files' content and keep the classify tests against the moved module.
- Scope guardrails: no dashboard beyond the existing management page, no new runtime dependencies, no framework — plain ES modules.
- The exported/imported JSON format and all API shapes stay backward compatible (only `/api/status` gains a field).
