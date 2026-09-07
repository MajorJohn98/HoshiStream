# Windows setup

Target: Windows 11 x64, private unsigned desktop builds.
Windows-machine acceptance is required before a build is recommended for use.

## Install and first launch

Use the versioned Windows installer from a trusted build, or extract the matching
portable ZIP to a stable folder you own. The desktop payload bundles .NET, Node,
TorrServer, mpv, ffmpeg and ffprobe. Recipients do not need development tools or
a separately installed player.

The installer is per-user. Program files normally live under
`%LOCALAPPDATA%\Programs\HoshiStream`, while mutable state lives separately in
`%LOCALAPPDATA%\HoshiStream`. Launch **HoshiStream** from the Start Menu (or
`HoshiStream.exe` in the portable folder).

The icon appears in the Windows notification area, possibly initially under
the overflow arrow. Pin it using Windows taskbar settings if desired. No
permanent taskbar window is expected: the management interface opens in the
default browser, and closing that browser does not quit HoshiStream.

First launch generates the private `.env`, access token and pointer push secret,
then starts TorrServer and the add-on. Existing configuration/library state is
preserved. Open the library from the tray instead of copying tokens manually.
The normal local management route is `/manage/<token>`.

Unsigned builds can trigger SmartScreen or an unknown-publisher prompt. Only
proceed with a build whose source you trust. Checksums detect altered downloads
but do not establish publisher identity. Do not disable Defender or work around
organization-managed restrictions; use an approved distribution in that case.

## Tray actions

The desktop shell provides the macOS menu's equivalent actions: open the
library or first-run setup, copy the add-on URL, restart, check speed, update
a configured remote pointer, change login/magnet settings, show logs, and quit.

**Start at Login** is optional and off by default. It starts the current-user
tray, not a background service before sign-in. **Quit** stops the owned runtime
and releases its ports after draining work.

While playback is active, the app requests that Windows avoid idle system
sleep. The display may turn off. Deliberate sleep, laptop lid behavior,
battery/power policy and system shutdown still take priority; wake the PC
before expecting another device to stream.

## Private LAN access

Allow access only on a trusted Windows **Private** network if other devices need
to stream. HoshiStream does not silently install firewall rules.

| Purpose | Default |
|---|---|
| Add-on and management | TCP 7001, configurable |
| Direct TorrServer playback | TCP 8090 |
| Local discovery | UDP 5353 multicast |
| BitTorrent peers | Configured TCP/UDP peer port, normally 32001 |

Firewall prompts may name the bundled `node.exe` or `TorrServer.exe`. Do not
expose management ports on Public networks or forward them from the router.
Optional peer-port forwarding is separate from LAN access. Automatic UPnP
remains disabled.

On another LAN device, the copied tokenized manifest should return JSON before
you install it in Nuvio/Stremio. If local readiness succeeds but LAN access fails,
check the network profile, firewall, selected LAN interface and VPN adapters.
Do not publish the manifest token or management URL.

## Media, drives and playback

Native file/folder selection links media in place. Relinking changes the
reference after a move; deleting a linked entry does not delete its source.
Browser uploads still copy media into managed storage.

Register a local drive/folder on the existing Storage page. HoshiStream tracks
its marker identity rather than trusting its drive letter. A disconnected
drive becomes offline; conflicting copies of the same marker must remain
ambiguous instead of being selected silently. Network-share discovery is not
part of this release.

**Play on this computer** uses the bundled mpv in automatic mode and supports
the existing playback controls and series queue. `PLAYER_PATH` remains an
explicit override. Browser playback still depends on the browser's codecs.
Direct play is the default; this port adds no transcoding features.

## Chrome companion and magnet links

Load the matching companion ZIP as an unpacked extension for private testing,
as described in [chrome-companion.md](chrome-companion.md). Native host
registration is not the same as extension installation. Keep the stable
extension identity; changing it intentionally requires matching registration.

The helper talks only to this computer's HoshiStream instance. Captures still
require explicit review and confirmation; neither the extension nor a clicked
magnet silently adds or downloads media.

Choose HoshiStream for `magnet:` links only if wanted, using Windows default-app
settings from the tray action. Installation makes it an available handler,
not an automatic replacement for another torrent application.

## Configuration, upgrades and removal

Edit `%LOCALAPPDATA%\HoshiStream\.env` and restart from the tray:

```env
ADDON_PORT=7001
MEDIA_DIR=C:\Users\your-name\Videos
HOME_SPEED_MBPS=10
```

Preserve generated secrets; do not replace them with example placeholders.
Logs are under the state directory's `logs` folder. `HOSHISTREAM_STATE_DIR`,
when set in the launching process, selects a different state directory.
Keep application state on a private local NTFS folder, not a network share
or a filesystem lacking atomic hard links/access control.

Upgrades preserve the state directory and repair this installation's native
registrations. Uninstall removes program files/integration, not the personal
library, cache or original linked media. Do not manually delete state unless
you intentionally want to reset the installation and have kept any needed data.

## Run directly from the repository

An x64 Node 22.18+ installation, npm and repository access are enough for server
development; .NET is only needed to build the desktop shell:

```powershell
cd addon
npm ci
cd ..
node packaging/fetch-torrserver.mjs
node packaging/fetch-ffmpeg.mjs
node scripts/native-server.mjs --dev
```

This foreground source mode reads/generates the repository `.env` and uses
`native-data/`. It does not launch the native tray/pickers. Keep the terminal
open and press Ctrl+C to stop. Correct copied macOS paths before using an
existing `.env`.

For installed-state server operation without the tray:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts\start-native.ps1 --dev
powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts\stop-native.ps1
```

The execution-policy override is scoped to that PowerShell process; managed
policy may still prohibit scripts. Quit other app/dev instances first. The
scripts require authenticated readiness and graceful stop, not blind PID kills.
See [development.md](development.md) for watch mode and isolated smoke checks.
