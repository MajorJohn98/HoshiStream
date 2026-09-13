# Diagnostics bundle

Date: 2026-09-13 · Phase 9 of the
[expansion plan](../plans/2026-09-12-playback-pointer-library-expansion-plan.md)
· design in
[disk-copy policies and diagnostics](../plans/2026-09-13-disk-copy-policies-and-diagnostics-plan.md).

One button now produces everything a support conversation needs, with the
secrets already gone.

## What changed

- **`GET /api/diagnostics`** (token-guarded, `no-store`) assembles one JSON
  document: release identity (`version`, `revision`, `buildId`), Node/OS/arch,
  uptime; TorrServer version and effective tuning settings; the last speed
  tests and current line speed; playback telemetry samples; pointer status
  with any drift observation; storage volumes, archive jobs and the download
  window; library **counts** (entries, movies, series, local media,
  multi-source, disk copies, policies, watch states — no titles or sources);
  and the last 300 server log lines.
- **In-memory log ring**: `installConsoleTap()` mirrors `console.*` output
  into a 300-line ring at start-up, so the bundle never reads log files or
  depends on the supervisor's paths. The tap is removed on shutdown.
- **Redaction** (`redactDiagnostics`) walks every string and key: the access
  token and `POINTER_PUSH_SECRET` by value, `Authorization`/`Bearer` values,
  complete `magnet:` URIs (hashes stay), `token=`/`secret=`/`key=` query
  values, `ACCESS_TOKEN=`/`POINTER_PUSH_SECRET=` assignments, and the home
  directory (→ `~`, including JSON-escaped Windows paths).
- **TorrServer `settings()`**: `POST /settings {action:"get"}`, verified at
  the pinned MatriX commit (`web/api/settings.go` → `settings.BTSets`). The
  Zod schema keeps tuning fields only; `TorznabUrls[].Key`,
  `TMDBSettings.APIKey`, `SslKey`/`SslCert` and `TorrentsSavePath` never enter
  the process model. Read-only; `set`/`def` are unused (Phase 10 territory).
- **UI**: *Copy diagnostics* on System → Status (Checks header) copies the
  bundle to the clipboard, or saves it as `hoshistream-diagnostics-<time>.json`
  when the clipboard is unavailable. Menu-bar **Reveal logs** stays.
- **Docs**: troubleshooting "Ask for help with a diagnostics bundle"; the
  closed-beta report template gains a bundle line; API references updated.
- **Log**: `diagnostics_exported {logLines}`.

## Code

- `addon/src/diagnostics.ts` — `LogRing`, `installConsoleTap`, `redactText`,
  `redactDiagnostics`, `buildDiagnostics`.
- `addon/src/torrserver-client.ts` — `settings()` + `settingsSchema`.
- `addon/src/routes/system-api.ts` — `handleDiagnostics`;
  `routes/context.ts` — `DiagnosticsOptions`; `index.ts` — tap + wiring.
- `addon/assets/manage/views/status.js` — button and download fallback.
- Tests: `tests/diagnostics.test.ts` (redaction fixtures for each secret
  class, ring/tap, end-to-end route with a fake TorrServer),
  `tests/torrserver-client.test.ts` (`settings`).

## Exit criterion

`tests/diagnostics.test.ts` fetches the bundle from a running handler whose
logs and pointer contain the token, push secret, an `Authorization` header
and a magnet URI, and asserts none survive.
