HoshiStream for Windows 11 x64 - private unsigned build
=====================================================

Install with HoshiStream-<version>-win-x64-setup.exe, or extract the portable ZIP
and open HoshiStream.exe. Do not run from inside the archive. Node, .NET, npm,
mpv, ffmpeg and TorrServer do not need to be installed separately.

The installer uses %LOCALAPPDATA%\Programs\HoshiStream without administrator
rights. The portable app can live in a writable folder of your choice. Both
use %LOCALAPPDATA%\HoshiStream for private settings, token, JSON library, uploads,
cache and logs. The first launch creates that state. "Portable" describes the
program files; state does not travel beside the executable.

The app appears in the notification area (possibly in its overflow). Choose
Open HoshiStream to open the library. Closing the browser does not stop the
server; choose Quit from the tray. Start at Login is OFF until you enable it
in the tray. The optional desktop shortcut does not enable startup.

Use the tray's Copy Stremio URL action for Nuvio or Stremio. The management route
is http://localhost:7001/manage/<token>, with your configured port if different.
Prefer opening it from the tray rather than copying tokens into messages/logs.
Add only media you are authorized to access. Imports always require review;
neither installation nor a magnet activation starts an automatic media download.

Updates and uninstall
---------------------
Quit the old app, then run the new installer in the same location. Installation
also requests a bounded graceful shutdown of that installation. If it cannot
stop safely, it fails rather than killing unrelated processes. Existing settings,
library, token and media are preserved. Uninstall removes program files and only
registry entries owned by this installation. It does NOT remove the state folder
or externally linked/copied media. Back up the state folder before moving PCs.
Quit before replacing a portable folder; do not merge old/new runtime trees.

Chrome companion and magnets
-----------------------------
The matching HoshiStream-Chrome-Companion-<version>.zip is a separate extension.
Extract it, enable Developer mode at chrome://extensions, choose Load unpacked,
then select that extracted directory. Its stable ID must match this build.
The optional installer bridge task registers a current-user native host immediately;
desktop startup also refreshes that registration when the bundled host is present.
This does not install the extension, grant website access, or import anything.
For portable registration, run from PowerShell in the extracted app directory:

    .\bin\node.exe .\scripts\register-browser-bridge.mjs

Use --unregister to remove only this installation's bridge registration.
Use the optional installer magnet task or the tray's magnet-link settings to
make HoshiStream available in Windows
Default apps, then explicitly choose the MAGNET link type there. The application
never overwrites Windows UserChoice or takes over another client's default.

Unsigned builds and networking
-------------------------------
This private build is unsigned. Windows may display an unknown-publisher or
SmartScreen warning. Confirm the sender and compare the accompanying SHA-256
checksum (PowerShell: Get-FileHash <file> -Algorithm SHA256). A hash checks bytes,
not publisher identity. Only proceed if you trust the source and local policy
allows it; managed PCs may block the app. Do not disable Defender, SmartScreen,
or organization security controls.

HoshiStream never changes firewall rules or router forwarding automatically.
If Windows asks, allow the needed app access on your trusted Private network
only. Do not expose its management services on Public networks. The computer
must remain on for LAN playback. Idle-sleep prevention during activity does not
override deliberate sleep, closing the lid, or power policy.

Terminal alternative (no PowerShell policy changes)
---------------------------------------------------
From the extracted/installed directory:

    .\bin\node.exe .\scripts\native-server.mjs
    .\bin\node.exe .\scripts\native-control.mjs stop

The first command runs in the foreground; issue stop from another terminal.
Do not run the terminal server and tray against the same state simultaneously.
Native picker dialogs and Windows desktop integrations require the tray.

Redistribution
--------------
See third-party\NOTICE.txt and third-party\redistribution for retained licenses,
sources and build instructions. Validation-only staging is NOT a release and
must not be shared. Unsigned private sharing still requires license compliance.
