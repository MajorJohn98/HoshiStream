# Pointer drift detection and one-click push

Implements Phase 4 of the
[playback, pointer and library expansion plan](../plans/2026-09-12-playback-pointer-library-expansion-plan.md):
a stale remote pointer record is no longer silent. Pushes stay strictly manual
([ADR 0012](../decisions/0012-vercel-pointer-server.md)).

## What changed

- **`PointerClient.observeDrift(trigger)`** (`src/pointer.ts`) runs the same
  read as **Check service** with a 5 s timeout, then compares the remote
  `baseUrl` with this computer's current LAN base URL and keeps the result in
  memory as `DriftObservation`: `outcome` (`match`, `remote-mismatch`,
  `expired`, `remote-without-local-push`, `unreachable`), `trigger` (`start`
  or `lan-change`), `checkedAt`, `remoteBaseUrl`, `localBaseUrl`, and the
  sanitized `state`/`message`. It never pushes and contacts nothing when the
  pointer is not configured. The persisted evidence rules are unchanged: the
  read may invalidate old success (network failure → `unreachable`) but never
  creates or extends it.
- The observation rides along on `PointerStatus.drift`, so `/api/status` and
  `/api/pointer/status` carry it without new routes. A manual push, check or
  removal drops it; it does not survive a restart.
- **`PointerDriftMonitor`** (`src/pointer-drift.ts`, started from `index.ts`)
  re-reads the LAN address every 30 s (interface enumeration, no network) and
  schedules one check at start-up — or when the first address appears — and
  one per address change. No retry loop. Logs `pointer_drift_observed`
  (`trigger`, `outcome`; no addresses) or `pointer_drift_check_failed`.
- **Management UI** — Pointer card (Devices): a hairline row with a status dot,
  "Remote points at 192.168.1.2; this computer is 192.168.1.4", when it was
  checked, and an **Update now** button that runs the existing push.
  `driftSummary()` is exported for tests.
- **macOS menu bar**: one `UNUserNotificationCenter` banner per
  `remote-mismatch` observation with an **Update Remote Pointer** action
  (clicking the banner also pushes). Authorization is requested lazily, only
  when a drift is first seen, and skipped outside a bundle.
- **Windows tray**: one balloon per `remote-mismatch` observation; clicking it
  runs the same push as the menu item.
- The "Registered" message now says the service is read once at start-up and
  after a LAN change, never on a schedule.

## Docs

- [pointer-server-vercel.md](../guides/pointer-server-vercel.md) "When your IP
  changes" and "States and recovery".
- [troubleshooting.md](../guides/troubleshooting.md) "Pointer redirects to an
  old LAN address".
- [management-api-reference.md](../api/management-api-reference.md) `drift`
  field.

## Tests

- `tests/pointer.test.ts` — drift outcomes, no automatic push, short timeout,
  hint superseded by manual actions, memory-only across restart.
- `tests/pointer-drift.test.ts` — one check at start, one per LAN change, no
  check without an address, failure logging.
- `tests/pointer-drift-ui.test.ts` — card row text and when **Update now**
  is offered.
