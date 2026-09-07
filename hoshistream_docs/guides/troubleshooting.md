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
- Keep the Mac awake (`caffeinate -dimsu`); closing the lid may suspend networking.
- Use the candidate's H.264/AAC MP4 baseline. Existing optional stream repair
  is off by default and outside initial beta acceptance; it is not a universal
  fix or a reason to promise additional codecs.

## Corrupt library JSON

The library store can quarantine corrupt JSON and restore its last-known-good
`.bak` automatically. If recovery fails, stop HoshiStream and preserve the
damaged files before seeking help; do not overwrite them with an empty library.
Default library paths are
`~/Library/Application Support/HoshiStream/library.json` for the installed Mac
app and `<checkout>/native-data/library.json` for the foreground whole stack,
not the old `data/library.json`. A `.bak` or browser JSON export is not a full
backup. The phase 5 backup/restore procedure remains a separate acceptance gate.

## Local media path rejected

Local paths must be absolute, and browser-entered paths are validated against `MEDIA_ROOT`/managed storage. With the native app, use the Finder picker instead of typing paths. After moving or renaming linked media, use **Edit → Relink in Finder**.
