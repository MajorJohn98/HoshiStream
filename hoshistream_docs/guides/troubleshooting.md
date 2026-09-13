# Troubleshooting

## Port 7000 returns `Server: AirTunes` or HTTP 403

macOS AirPlay Receiver owns the port. Turn off **System Settings → General → AirDrop & Handoff → AirPlay Receiver**, then restart the stack. Alternatively change `ADDON_PORT` in `.env`.

## Manifest works on the Mac but not the TV

- In the native app, reconnect to the trusted LAN and restart HoshiStream to
  refresh its detected address, then copy the private add-on URL again. Native
  mode derives its public URLs; only add-on-only mode requires configuring
  `PUBLIC_ADDON_URL` and `PUBLIC_TORRSERVER_URL` directly.
- Verify both devices are on the same non-isolated network (no AP/client isolation, no guest VLAN).
- Open the tokenized manifest in the TV-side browser first; it must return JSON.

## Works on `127.0.0.1` but not on the LAN IP (empty reply)

The macOS Application Firewall blocks the app's bundled `node` until it is
approved — and the approval is lost every time the app bundle is rebuilt or
replaced. Symptom: `curl http://127.0.0.1:7001/health` returns 200 while the
same request against the LAN IP fails with an empty reply, so catalogs die on
every client (including pointer-server redirects). Re-approve it:

```bash
sudo /usr/libexec/ApplicationFirewall/socketfilterfw --add /Applications/HoshiStream.app/Contents/Resources/runtime/bin/node
sudo /usr/libexec/ApplicationFirewall/socketfilterfw --unblockapp /Applications/HoshiStream.app/Contents/Resources/runtime/bin/node
```

## Pointer URL: manifest loads but catalogs say "Failed to fetch"

First rule out the firewall issue above. If the LAN catalog URL works in
`curl` but a *browser-based* client (Stremio desktop) still fails, its
webview may be refusing the HTTPS-to-HTTP-LAN redirect (mixed-content / private
network rules). Behavior depends on the client/version; the beta matrix is
not yet accepted. Install the direct LAN URL instead (or `127.0.0.1` only for
a player on the host). See [pointer setup](pointer-server-vercel.md).

## TorrServer unavailable

```bash
tail -f ~/Library/Logs/HoshiStream/server.log
```

Then open `http://127.0.0.1:8090/swagger/index.html`. The add-on's `/ready` endpoint also checks TorrServer `/echo`.

## Menu bar stuck on "Recovering… (attempt N)"

The log shows `Error open bboltDB: …/torrserver/config/config.db` after a
`timeout`: an orphaned TorrServer from a previous app instance is still
holding the database lock, so every restart attempt dies. This can happen
after replacing the app bundle while it was running.

```bash
pgrep -fl TorrServer        # two entries means one is an orphan
kill <older PID>            # the supervisor recovers on its next attempt
```

## No playable files

Inspect the entry (management page or `POST /api/library/{id}/inspect`). Supported extensions: `.mp4`, `.mkv`, `.webm`, `.avi`, `.mov`, `.m4v`. If automatic selection is wrong, set `preferredFileIndex` to an inspected playable file ID.

## Browser or external player cannot play

The management page's **Play** action opens the browser player. Try authorized
H.264/AAC MP4 media for the candidate baseline; an extension appearing in a file
list or a successful source sample does not establish browser compatibility.
macOS bundles media-analysis tools but **not mpv**. The advanced host-player API
needs a separately installed player; configure an absolute `PLAYER_PATH` for mpv
rather than relying on a menu-bar process inheriting Homebrew's shell PATH.
See [playback prerequisites](setup-native-macos.md#playback-notes).

Downloaded app blocked or reported damaged? Follow the
[trusted, app-scoped installation guidance](distributing-macos-app.md#install-an-approved-image);
do not disable system-wide protections.

## Playback stalls

- Choose a healthier authorized torrent; compare peer download speed with the media bitrate (`?probe=true` inspection gives bitrate and a speed verdict).
- Check the line, not the app: there is no application-side buffer. The
  startup speed test is logged as `speedtest_completed` with `mbps`; a
  ~9 Mbps line cannot sustain a 10 Mbps file no matter how the player buffers.
- Confirm `UploadRateLimit` is capped: System → Status → **TorrServer tuning**
  shows the live value. `0` means unlimited, and an unthrottled uplink on an
  asymmetric line starves the download. Installs that predate the `128` KiB/s
  default keep `0` until you apply a cap there (or press **Reset to shipped
  defaults**) — see [TorrServer tuning](setup-native-macos.md#torrserver-tuning).
- Keep the Mac awake (`caffeinate -dimsu`); closing the lid may suspend networking.
- Use the candidate's H.264/AAC MP4 baseline. Existing optional stream repair
  is off by default and outside initial beta acceptance; it is not a universal
  fix or a reason to promise additional codecs.

## Pointer redirects to an old LAN address

If the pointer URL's manifest loads but streams and catalogs fail, check where
an add-on path redirects (any `/addon/<token>/catalog/...` URL answers `307`
with a `Location` on the Mac's LAN). A target that does not match the Mac's
current LAN address means the remote record is stale even though the app shows
the last push as successful. Push again from Pointer → Update Remote Pointer.
Since the drift check landed, the app reads the record itself at start-up and
after a LAN change; a mismatch shows on the Pointer card with **Update now**
and as a one-off notification, so this usually no longer needs `curl`.
A pointer server deployed before
[ADR 0024](../decisions/0024-immutable-pointer-blob-versions.md) could keep
serving an overwritten record for days; redeploy it, then push once.

## Corrupt library JSON

The library store can recover from its last-known-good `.bak` automatically and
attempt to quarantine corrupt JSON. If recovery fails, stop HoshiStream and
preserve the damaged files before seeking help; do not overwrite them with an
empty library. A missing primary file can also recover from `.bak`; if both
are absent, the store treats the library as new. Unexpectedly empty state after
an update therefore requires checking the resolved paths before adding anything.
Default library paths are
`~/Library/Application Support/HoshiStream/library.json` for the installed Mac
app and `<checkout>/native-data/library.json` for the foreground whole stack,
not the old `data/library.json`. A `.bak` or browser JSON export is not a full
backup. Follow the [stopped backup and same-path restore procedure](backup-restore-updates.md).
Do not run an older app against newer state or remove a stale lock merely to
make backup commands proceed.

## Updating, uninstalling or reporting a problem

Quit the whole app before replacing its bundle. Keep the previous artifact
and a matching full stopped backup; app-only uninstall preserves the library,
credentials and linked originals. See [updates and rollback](backup-restore-updates.md).
After sleep or a LAN change, reconnect to the trusted network, restart the
server and manually update a configured pointer if needed; a pointer is not
remote access.

Use the [private report template](closed-beta-support.md), never a raw log,
`.env`, private URL, magnet or whole library. The chosen feedback repository
is still pending, so do not use public issues as a substitute.
See [privacy and network contacts](privacy-and-network.md) before joining.

### Ask for help with a diagnostics bundle

Open **System → Status** and press **Copy diagnostics** (bottom of the
Checks section). The clipboard receives one JSON document — versions and
build id, OS and Node, TorrServer version and its tuning settings, the last
speed tests, playback telemetry, pointer state, storage volumes and archive
jobs, library *counts*, and the last 300 server log lines. Paste it into the
report.

The bundle is redacted before it leaves the server: the access token,
`POINTER_PUSH_SECRET`, `Authorization` values, `magnet:` URIs, `token=`
query values and your home directory (shown as `~`) never appear, and
library titles, sources and file names are not included. Still read it once
before sending; if something looks private, remove it. When the browser
cannot use the clipboard (plain-HTTP LAN origins), the same bundle is saved
as a `.json` download instead. The menu bar's **Reveal logs** remains for a
full local log.

## Local media path rejected

Local paths must be absolute, and browser-entered paths are validated against `MEDIA_ROOT`/managed storage. With the native app, use the Finder picker instead of typing paths. After moving or renaming linked media, use **Edit → Relink in Finder**.
