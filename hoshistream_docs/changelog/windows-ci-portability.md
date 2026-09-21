# Windows CI portability

Closes #14. The `Native desktop validation / shared (windows-2025)` job had
never passed; this makes it green without skipping Windows behaviour.

## Runtime fixes

- **`PSModulePath` no longer leaks into Windows PowerShell 5.1.** When the app
  or a script is launched from PowerShell 7 (`pwsh` — GitHub's default Windows
  shell and a common developer terminal), `powershell.exe` inherited a
  `PSModulePath` pointing at PS 7 modules and failed to load
  `Microsoft.PowerShell.Security` / `Management`, so `Set-Acl` and the
  registry cmdlets errored with `CouldNotAutoloadMatchingModule`. The spawn
  environment now drops that variable in `scripts/private-files.mjs`
  (`restrictAccess`), `scripts/register-browser-bridge.mjs` (Chrome native
  host registry) and `src/windows-platform.ts` (`enumerateWindowsMounts`).
  Launches from Explorer or the installer were unaffected; launches from a
  pwsh 7 terminal were broken.

## Test fixes (no product change)

- `tests/helpers/private-files.ts` — `expectOwnerOnly(path)` asserts `0o600`
  on POSIX and file presence on Windows, with the reasoning inline (Windows
  privacy comes from the directory ACL, not per-file mode bits).
- `config`: compare `stateRoot("darwin")` with `posix.join`.
- `thumbnails`: separator-aware suffix match.
- `local-media`: bump the directory mtime explicitly (NTFS updates it lazily).
- `player-ipc`: the fake mpv waits for the server-side accept before emitting,
  which on named pipes can land after the client's `connect` resolves.

## Follow-up

The Windows smoke and installer steps later in the same workflow now run for
the first time and may surface further issues.
