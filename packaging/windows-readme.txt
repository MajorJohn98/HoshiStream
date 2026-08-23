HoshiStream for Windows — install notes
=======================================

This is a portable build: there is no installer. Unzip the HoshiStream folder
anywhere you like (for example C:\Program Files is NOT required — your user
folder works fine), then start it.

Starting
--------

Right-click scripts\start-native.ps1 and choose "Run with PowerShell", or from
a terminal:

    powershell -NoProfile -ExecutionPolicy Bypass -File scripts\start-native.ps1

The first start creates:

    %LOCALAPPDATA%\HoshiStream

containing a .env with a freshly generated access token, plus the library and
TorrServer data. Nothing needs configuring first.

Windows Defender Firewall will ask to allow incoming connections for node.exe
and TorrServer.exe — allow them on private networks, or other devices on your
network cannot reach the server. HoshiStream never changes firewall rules
itself.

Open http://localhost:7001/<your token>/manage/ for the library — the token is
in %LOCALAPPDATA%\HoshiStream\.env. The same page shows the Stremio URL to add
the add-on to Nuvio or Stremio.

Stopping
--------

    powershell -NoProfile -ExecutionPolicy Bypass -File scripts\stop-native.ps1

Start at login (optional)
-------------------------

    powershell -NoProfile -ExecutionPolicy Bypass -File scripts\install-login-task.ps1

Undo with scripts\uninstall-login-task.ps1. This writes a single per-user
registry Run entry; no administrator rights are needed.

Notes
-----

- To point the app at a different media folder, edit MEDIA_DIR in
  %LOCALAPPDATA%\HoshiStream\.env and restart.
- Logs live in %LOCALAPPDATA%\HoshiStream\logs\.
- The PC must be awake for anything to stream. Keeping the machine from
  sleeping during playback is not yet automatic on Windows.
