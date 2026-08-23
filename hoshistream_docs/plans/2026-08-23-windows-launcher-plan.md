# Windows Launcher Plan

Status: W1 + W2 shipped (zip builds from macOS: `HoshiStream-0.8.2-win-x64.zip`, 192 MB); W3 needs a Windows machine
Date: 2026-08-23
Implements: Phase B of [2026-08-14-native-only-plan.md](2026-08-14-native-only-plan.md), per [ADR 0009](../decisions/0009-native-only-deployment.md)

> **Note (W1):** upstream deleted the `MatriX.141.1` GitHub release, breaking every
> fetch. `torrserver-lock.json` is repinned to `MatriX.141` (darwin + win32 checksums
> reverified); the darwin binary was refetched and the opt-in integration test passes
> against it.

## Goal

Ship HoshiStream on Windows as a portable zip with a minimal launcher — no tray app,
no installer, no supervisor rewrite. The management UI in the browser is the whole
interface, exactly as ADR 0009 decided.

## What already exists (verified in the codebase)

| Concern | Where | State |
|---|---|---|
| Pinned `win32-x64` Node v26.3.1, TorrServer MatriX.141.1, ffmpeg BtbN n8.1.2 | `packaging/*-lock.json` | Done |
| Zip/`.exe`-aware fetchers | `packaging/fetch-*.mjs` | Done (BtbN branch untested) |
| `%LOCALAPPDATA%\HoshiStream` state defaults | `addon/src/config-schema.ts`, `scripts/bootstrap.mjs` | Done |
| Separator/case-safe path guard | `addon/src/path-safety.ts` | Done |
| Windows playback: mpv named-pipe IPC, `cmd /c start` fallback | `addon/src/player.ts` | Done |
| Process stats degrade to unavailable on Windows | `addon/src/resources.ts` | Done |
| Browser path picker fallback; UI hides native picker when absent | `routes.ts` (`listLocalMedia`, `validateBrowserLocalPath`), `assets/manage/views/*.js` | Done |

## Gaps — the actual work

### W1 — Portability fixes in `native-server.mjs` (testable from macOS)

1. **TorrServer binary name.** Line ~54 hardcodes `TorrServer`; on win32 it must be
   `TorrServer.exe` (the fetcher already installs it under that name).
2. **Picker socket.** `NATIVE_PICKER_SOCKET` is set unconditionally to a Unix socket
   path. On win32, omit it so the add-on reports `nativePicker: false` and the UI
   falls back to browser path entry. Verify `NativePicker` treats an unset socket as
   unavailable rather than erroring.
3. **Shutdown semantics.** `SIGHUP` does not exist on Windows and `child.kill("SIGTERM")`
   is a hard `TerminateProcess`. Keep the handlers (Node maps what it can), but make the
   stop path not depend on graceful TorrServer signal handling: the existing
   force-kill-after-5s fallback already covers it. The parent watchdog uses `process.ppid`,
   which works on Windows — keep it.
4. **Fetcher target override.** Accept an optional `HOSHISTREAM_TARGET` (e.g. `win32-x64`)
   in the three fetchers so the Windows vendor tree can be assembled from the Mac.
   Binary names must then key off the *target*, not `process.platform`.

### W2 — Launcher, stop script, packaging (authored on macOS, verified on Windows)

1. **`scripts/start-native.ps1`** — mirror of `start-native.sh`: resolve state dir
   (`%HOSHISTREAM_STATE_DIR%` or `%LOCALAPPDATA%\HoshiStream`), refuse double-start via
   the PID file, launch the vendored `node.exe scripts\native-server.mjs --detached`
   hidden (`Start-Process -WindowStyle Hidden`), redirect logs to
   `<state>\logs\hoshistream.log`, wait for the PID file.
2. **`scripts/stop-native.ps1`** — read the PID file, `Stop-Process` the supervisor;
   TorrServer exits via the supervisor's own stop path (or the 5s force-kill).
3. **Start at login (opt-in)** — `scripts/install-login-task.ps1` writing a per-user
   `HKCU\Software\Microsoft\Windows\CurrentVersion\Run` entry pointing at
   `start-native.ps1`; a matching uninstall script. Not run automatically.
4. **`packaging/build-windows-zip.mjs`** — produce `HoshiStream-<version>-win-x64.zip`
   with the same runtime layout the macOS bundle uses
   (`addon/dist`, `addon/assets`, pruned `addon/node_modules`, `scripts/`, `packaging/`,
   `vendor/{node,torrserver,ffmpeg}/win32-x64`, plus a `README.txt` with first-run steps).
   Reuse the dependency-pruning logic from `build-macos-app.sh`.
5. **Firewall** — do not touch firewall state. Document that Windows prompts on first
   listen for `node.exe` and `TorrServer.exe`, and what to allow (add-on port 7001,
   TorrServer 8090 + peer port) — private networks only.

### W3 — Verification on a real Windows machine, then docs

Per the native-only plan: *"Phase B should not be declared done on the basis of code
that compiles; it needs a real run."*

Checklist on Windows 10/11 x64:
- [ ] PowerShell scripts parse and run (no pwsh on the dev Mac — unvalidated syntax)
- [ ] Fetchers install all three runtimes into `vendor/*/win32-x64`
- [ ] First run creates `%LOCALAPPDATA%\HoshiStream`, `.env`, and a generated token
- [ ] TorrServer starts, `/echo` answers; add-on `/ready` answers
- [ ] Library add (magnet + local file) works via the browser path picker
- [ ] A stream URL resolves and plays on a LAN client
- [ ] mDNS discovery answers on the LAN (dgram multicast on Windows)
- [ ] Stream repair (when `TRANSCODE_ENABLED=true`) runs with the vendored ffmpeg
- [ ] `stop-native.ps1` terminates both processes and releases both ports
- [ ] Registry Run entry starts it at login; uninstall script removes it

Then write `guides/setup-native-windows.md`, update `index.md` and `README.md`, and add
a changelog entry.

## Explicit non-goals (v1)

- Tray application (ADR 0009 — can follow if wanted)
- Native file picker (browser picker is the fallback by design)
- Sleep prevention via `SetThreadExecutionState` — documented as a known gap
- Installer / code signing — plain zip, like the unsigned macOS `.dmg`
- Any change to supervision architecture

## Sequencing

```
W1 (portability fixes, mac-testable) ──> W2 (launcher + zip) ──> W3 (Windows machine)
```

W1 and W2 can ship reviewed but the plan is not done until W3 passes on real hardware.

## Risks

- **No Windows machine yet** — the hard blocker for W3. W1/W2 are still worth landing
  so the verification session is short.
- **BtbN ffmpeg is a GPL build** — fine for the vendored-binary, spawn-over-exec model
  already in use, but keep it out of any linked distribution.
- **`--dontkill` flag and TorrServer flags on Windows** — verify against the MatriX.141.1
  Windows binary during W3; do not assume parity with darwin.
- **PowerShell execution policy** — scripts may need `-ExecutionPolicy Bypass` in the
  Run entry / README instructions.

## Verification (every phase)

From `addon/`: `npm run typecheck`, `npm test`, `npm run lint`, `npm run format:check`.
W1 changes to `native-server.mjs` and fetchers get unit coverage where practical
(target-keyed binary paths, picker-socket omission on win32).
