# Building and distributing Windows desktop builds

The target is Windows 11 x64. The desktop app and Chrome helper are
self-contained .NET 10 executables; recipients do not need .NET, Node, npm
or mpv installed separately.

## Build prerequisites

Use Node 22.18+ with npm, the .NET SDK pinned in
`packaging/windows-toolchain-lock.json` (currently 10.0.103), and an x64
Windows machine for installer compilation. macOS can cross-publish the
Windows payload for inspection. The SDK pin and shipped runtime patch are
separate: both Windows executables ship .NET 10.0.11.

From the repository root:

```powershell
cd addon
npm ci
cd ..
$env:HOSHISTREAM_TARGET = "win32-x64"
node packaging/fetch-node-runtime.mjs
node packaging/fetch-torrserver.mjs
node packaging/fetch-ffmpeg.mjs
node packaging/fetch-mpv.mjs
node packaging/build-windows-app.mjs --stage-only
```

On macOS, set the target with `export HOSHISTREAM_TARGET=win32-x64` instead.
Every fetch is checksum-pinned. Windows FFmpeg uses a retained month-end BtbN
release rather than a daily asset that disappears after two weeks. Keep the
pin serviced before upstream's two-year month-end retention expires.

The local validation tree is `build/windows-stage/HoshiStream/`.
`HoshiStream.exe` is the tray entry point; `native-host/` contains the
separate Chrome helper. Copy the complete tree, not just the executables,
when testing on your own Windows computer.

The staging validator requires all runtimes, assets, scripts and production
dependencies. It rejects private state and development dependencies, checks
self-contained framework versions and records a payload digest manifest.
Neither a configured `PLAYER_PATH` nor a developer's PATH can substitute for
the bundled release runtimes.

## Local installer validation on Windows

```powershell
node packaging/build-windows-app.mjs --stage-only --validate-installer
```

This downloads and verifies the pinned Inno Setup compiler and produces a
validation installer under `build/windows-validation/`. It does not silently
install HoshiStream on the build machine.

`.github/workflows/windows.yml` exercises shared behavior, native contracts,
source/built/packaged runtime startup, and disposable installer upgrade/
uninstall scenarios. Interactive Windows acceptance is still required:
tray visibility, dialogs, Chrome cold start, idle sleep, device/network
changes and representative authorized LAN playback cannot be inferred from
cross-compilation.

## Redistribution gate

**Private sharing is redistribution too.** The downloaded mpv, FFmpeg and
TorrServer builds have applicable corresponding-source obligations and
third-party components. License notices or a link to an upstream repository
alone do not establish that all requirements have been fulfilled.

See `packaging/windows-third-party.txt`. Before producing distributable
artifacts, assemble and review the exact component source/license/build
materials under `vendor/windows-redistribution/`. Its `manifest.json` binds
the review and included source files to the current packaging lockfiles.
Changing a pin invalidates an older review.

No attestation claiming that this bundle is complete is supplied by the
implementation. Stage-only output is for local validation, not sharing.
The regular installer/ZIP commands intentionally fail while this release
gate is missing. Do not bypass it with an invented review.

After completing the review and Windows acceptance:

```powershell
node packaging/build-windows-app.mjs
```

This emits the versioned Windows installer, portable ZIP, matching companion
ZIP and SHA-256 checksum files under `build/`.
`node packaging/build-windows-zip.mjs` builds the reviewed ZIP without Inno
Setup and can run on macOS.

## Installation behavior

The installer uses `%LOCALAPPDATA%\Programs\HoshiStream`, creates Start Menu
entries and optionally a desktop shortcut. Login startup is a separate tray
opt-in. Optional Chrome/magnet registration uses the installed app's own
ownership-aware commands; it never sets a protected default-app choice.

Before upgrade/uninstall, maintenance asks the verified tray and local
runtime to stop. Failure is explicit rather than an unverified PID kill.
Uninstall preserves `%LOCALAPPDATA%\HoshiStream` and never deletes linked
external media. Another installation's registry entries are left alone.

This release is unsigned. Explain SmartScreen/unknown-publisher warnings,
provide checksums, and do not ask users to disable Defender or managed
policies. Signing, Store distribution and automatic updates are deferred.
