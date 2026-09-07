# Windows desktop release

Date: 2026-09-06
Status: implemented candidate; Windows acceptance and redistribution review remain required

## Release contract

Windows 11 x64, a self-contained .NET 10 Windows Forms tray app, bundled mpv,
and an unsigned per-user installer for private sharing. Keep the existing Node
server, browser UI, JSON stores, and Swift macOS app. No Electron, containers,
before-login service, provider discovery, database, or new transcoding features.

This follows the [Windows launcher plan](2026-08-23-windows-launcher-plan.md);
its ZIP-only scope is historical, not the desktop release target.

## Implementation sequence

1. **Runtime foundation.** Preserve source execution and installed/development
   state separation. Add actual readiness checks, exclusive state ownership,
   bounded authenticated local shutdown, command exit-code handling, and cleanup.
   A PID file is not proof of readiness or permission to terminate a process.
2. **Native shell.** Implement native tray/menu actions, single-instance
   activation, owned-process Job Object cleanup, bounded recovery, opt-in login,
   activity-scoped sleep prevention, high-DPI/keyboard support, and Explorer
   restart recovery. Keep business logic in Node.
3. **Media and storage.** Port picker IPC to current-user Windows named pipes
   while retaining expiring selection grants. Remove Finder-only UI assumptions.
   Rediscover marker-identified local drives after drive-letter changes and
   report Windows resource statistics without fabricated values.
4. **Playback.** Pin and bundle mpv with required runtime files and redistribution
   notices. Fix bundled-player lookup and exercise named-pipe controls and queues.
   Package ffprobe/ffmpeg for existing features; direct play remains the default.
5. **Companion and magnets.** Register a per-user Chrome native-messaging
   executable, preserve framing and exact extension identity, support Windows
   app/browser activation, and keep application lifetime independent of Chrome.
   Magnet associations are opt-in and always open explicit import review.
6. **Packaging.** Stage a complete production payload shared by the portable ZIP
   and Inno Setup installer. Bundle all end-user runtimes, preserve mutable data
   on upgrades/uninstall, and exclude developer data, tokens, and logs.
7. **Acceptance.** Add Windows CI and portable IPC tests; verify clean-machine
   installation and real Windows UI, power, networking, and playback behavior.
   Compilation alone is not evidence that the release is ready.
8. **Documentation.** Supersede relevant ADR scope without editing accepted ADRs,
   document Windows installation/distribution and terminal operation, and publish
   matching app/companion artifacts with checksums and third-party notices.

## Architecture and shared contracts

The installed root is `%LOCALAPPDATA%\Programs\HoshiStream`; mutable state remains
`%LOCALAPPDATA%\HoshiStream`. `HoshiStream.exe` launches `bin/node.exe` with the
existing `scripts/native-server.mjs`, which imports the add-on and owns TorrServer.
The browser host is a separate executable under `native-host/`.

The shell uses redirected stdin for parent-only shutdown commands. Terminal
launchers use an authenticated control listener bound only to `127.0.0.1`, with a
random capability stored in the private state directory. Neither is a new
LAN-accessible management endpoint. Normal shutdown drains application state
before terminating owned children. Windows shell crashes close their Job Object.

Native pickers use a current-user-only named pipe, bounded newline-delimited JSON,
nonce correlation, cancellation, and existing single-use grants. File selection
never grants arbitrary remote filesystem access. Credentials stay out of registry
values, process arguments, extension replies, and logs. NTFS ACLs, not POSIX modes,
enforce private Windows file access.

Start at Login and magnet handling remain opt-in. The existing browser management
UI is authoritative; the tray provides status, common actions, native dialogs,
clipboard, logs, and power/lifecycle integration, not a replacement dashboard.

## Acceptance gates

| Area | Required outcome |
|---|---|
| Install | Fresh non-admin Windows 11 x64 install without Node, .NET, npm, or mpv on PATH |
| Lifecycle | One owned instance; actual readiness; restart/quit/crash release owned processes and ports |
| Tray | Existing menu actions, accurate status/errors, keyboard/high-DPI usability, Explorer restart recovery |
| State | Existing Windows data/token survive upgrade; uninstall preserves data and external media |
| Media | Manual torrent/magnet review, source checks, local linking/relinking, series and tags |
| Storage | Disk-first playback, drive-letter changes, reconnect, clone ambiguity and disk-full errors |
| Playback | Bundled mpv controls/queues and authorized representative Nuvio/Stremio LAN playback |
| Integrations | Correct Chrome identity/framing, cold/warm app start, opt-in reviewed magnet activation |
| Power/network | Idle sleep held only during playback; deliberate sleep respected; resume and LAN recovery |
| Source | Documented source and built terminal modes work, with honest native-feature limitations |
| Regression | Required project checks and Windows-specific checks pass without regressing macOS |

Do not claim a feature-parity percentage or general Windows release readiness
until these gates pass. Unsigned private distribution still requires applicable
third-party redistribution obligations. Explain SmartScreen warnings without
instructing users to disable Defender or organization policy.

## Terminal operation

With Node 22.18+ and npm installed, from a fresh repository root:

```powershell
cd addon
npm ci
cd ..
node packaging/fetch-torrserver.mjs
node packaging/fetch-ffmpeg.mjs
node scripts/native-server.mjs --dev
```

This foreground mode reads/generates the repository `.env`, uses `native-data/`,
and runs TypeScript without a build. Keep the terminal open; Ctrl+C requests
shutdown. It does not create a tray or native picker. A copied macOS `.env` must
have its media paths corrected.

The installed-state alternative is `scripts/start-native.ps1 --dev`, stopped with
`scripts/stop-native.ps1`. Quit any other running instance first. The installed
application requires none of the source-development tooling above.

## Deferred

Windows 10, ARM64, signed/public or Store distribution, automatic updates,
before-login services, and network-share auto-discovery are outside this release.
