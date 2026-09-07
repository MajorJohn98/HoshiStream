# 0022 - Windows native desktop release

Status: accepted
Date: 2026-09-06
Supersedes: the Windows minimal-launcher limitation in ADR 0009 and the
macOS-only integration scope in ADRs 0020 and 0021.

## Context

The shared Node launcher and Windows binary pins already support a native server,
but a ZIP of PowerShell scripts does not provide the requested installed-app
experience. Windows users need a tray icon, native selection and relinking,
reliable shutdown, login integration, host playback, and the same explicit
Chrome/magnet review flows available on macOS.

The user approved Windows 11 x64, a self-contained C#/.NET tray shell, bundled
mpv, and an unsigned installer for private sharing.

## Decision

Keep the Swift macOS supervisor and the shared Node/TypeScript application.
Add a small .NET 10 Windows Forms `NotifyIcon` shell, not Electron or a rewrite
of library/torrent logic. Package its self-contained runtime so the recipient
does not need a developer SDK, Node installation, or separate media player.

The Windows app owns its runtime process tree using a kill-on-close Job Object.
Normal exit first asks Node to drain application work and stop owned children.
Native dialogs and activation use current-user-restricted named pipes.
The Node launcher also provides capability-authenticated loopback-only control
for terminal launchers, independent of the LAN management API.

Install program files per user under `%LOCALAPPDATA%\Programs\HoshiStream`.
Keep state under `%LOCALAPPDATA%\HoshiStream` and preserve it on upgrades and
uninstall. Keep the portable ZIP and direct Node source workflow available.
NTFS ACLs enforce private configuration/control files; Unix modes are not
treated as Windows access control.

Port the Chrome native host through an executable shim and per-user registry
registration. Preserve the exact extension identity, native framing, redaction,
manual capture/review, and same-computer restriction. Register magnet handling
as an available choice; use supported Windows default-app selection instead of
silently replacing another application or modifying protected UserChoice keys.

Start at Login remains opt-in. Playback can prevent idle system sleep, but
must not force the display on or override explicit sleep/lid policy. Firewall
access remains a user decision restricted to trusted Private networks.

Bundle pinned mpv and the existing ffmpeg/ffprobe dependencies with applicable
redistribution notices/source obligations. Direct play remains the default;
this decision does not authorize new transcoding features, torrent discovery,
containers, a database, or a new dashboard.

## Consequences

- Windows has platform-specific native code, but shared business logic and data
  models remain in Node. macOS does not acquire a .NET dependency.
- Self-contained distribution increases size and requires deliberate runtime
  servicing updates.
- A current-user instance is not a before-login service and cannot bypass
  organization security policies.
- Unsigned private builds may trigger SmartScreen/unknown-publisher warnings.
  Checksums establish artifact integrity, not publisher identity.
- Native UI, installation, power behavior, drive changes and actual LAN
  playback require Windows acceptance. Cross-compilation is not release proof.
- Windows 10, ARM64, signed/public or Store distribution, automatic updates and
  network-share auto-discovery remain deferred.
