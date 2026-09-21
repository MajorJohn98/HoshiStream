# Windows CI portability plan

**Date:** 2026-09-21 · **Issue:** #14 · **Status:** implemented

## Problem

`Native desktop validation / shared (windows-2025)` has failed on every run
since the job was added (2026-09-07). The last run before this work reported
**25 failed tests across 10 files**; macOS passes. Windows is a planned native
target ([ADR 0009](../decisions/0009-native-only-deployment.md)), so the job
must be green rather than ignored.

## Root causes

The codebase was already Windows-aware in most places (named pipes in
`player-ipc`, an ACL script in `scripts/private-files.mjs`, a `Get-Acl`
verification branch in `bootstrap.test.ts`). The failures reduce to one
runtime bug and a handful of tests written without a Windows branch.

| #   | Cause                                                                                                                                                                                                                                                                                                               | Tests                                              | Kind                                                                                |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------- | ----------------------------------------------------------------------------------- |
| 1   | `restrictAccess` spawns `powershell.exe` (Windows PowerShell 5.1) with `{ ...process.env }`. On the runner the parent is `pwsh` 7, whose `PSModulePath` points at PS 7 modules. 5.1 then tries to load the PS 7 build of `Microsoft.PowerShell.Security` and `Set-Acl` fails with `CouldNotAutoloadMatchingModule`. | `bootstrap` ×10, `native-runtime` ×6               | **runtime bug** — would also affect a user who launches the app from a pwsh 7 shell |
| 2   | `expect(stat.mode & 0o777).toBe(0o600)` — Windows has no POSIX mode bits; `writeFile({ mode })` is a no-op and `stat` reports `0o666`.                                                                                                                                                                              | `tags`, `onboarding`, `device-names`, `pointer` ×2 | test-only                                                                           |
| 3   | `stateRoot("darwin")` test compares with the host `path.join`; the source correctly uses `path.posix`.                                                                                                                                                                                                              | `config`                                           | test-only                                                                           |
| 4   | `pathFor` test matches `/\/1\/2\.jpg$/`; Windows uses `\`.                                                                                                                                                                                                                                                          | `thumbnails`                                       | test-only                                                                           |
| 5   | NTFS updates a directory's `LastWriteTime` lazily, so adding a file does not reliably bump the parent `mtimeMs` that the inspection cache keys on.                                                                                                                                                                  | `local-media`                                      | test-only (the 30 s cache TTL bounds the product effect)                            |
| 6   | Named pipes: the server-side `connection` callback can fire _after_ the client's `connect` resolves, so the fake mpv had no client to `emit` to.                                                                                                                                                                    | `player-ipc`                                       | test-only race                                                                      |

## Changes

1. `scripts/private-files.mjs` — export `windowsPowerShellEnvironment(extra)`
   that copies `process.env` **without** `PSModulePath` (and `PSModulePath`
   in any casing), and use it for the `Set-Acl` spawn.
2. `addon/tests/helpers/private-files.ts` — `expectOwnerOnly(path)`:
   asserts `0o600` on POSIX; on Windows asserts only that the file exists
   and documents why (per-file mode bits are not the mechanism there — the
   state root under `%LOCALAPPDATA%` is per-user and `restrictAccess`
   protects the directories that need an explicit ACL).
3. `bootstrap.test.ts` — keep the real `Get-Acl` verification for `.env`
   (that file _is_ ACL-restricted) but spawn with the cleaned environment.
4. `config.test.ts` → `posix.join`; `thumbnails.test.ts` → `sep`-aware
   suffix; `local-media.test.ts` → explicit `utimes` on the directory after
   adding the file; `player-ipc.test.ts` → `fakeMpv.emit` waits for the first
   server-side client.

## Acceptance

- `shared (windows-2025)` and `shared (macos-15)` both pass.
- No blanket `skipIf(win32)`; every Windows branch says what differs and why.
- `typecheck`, `test`, `lint`, `format:check` clean locally.

## Follow-ups (not in this change)

- The Windows smoke steps further down the workflow (`smoke-native.mjs`,
  installer upgrade) have never executed because the test step failed first.
  They may surface further issues once reached.
