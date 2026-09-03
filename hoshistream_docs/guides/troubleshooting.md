# Troubleshooting

## Port 7000 returns `Server: AirTunes` or HTTP 403

macOS AirPlay Receiver owns the port. Turn off **System Settings → General → AirDrop & Handoff → AirPlay Receiver**, then restart the stack. Alternatively change `ADDON_PORT` in `.env`.

## Manifest works on the Mac but not the TV

- Confirm `PUBLIC_ADDON_URL` and `PUBLIC_TORRSERVER_URL` use the Mac's LAN IP, not `127.0.0.1` or `torrserver`.
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
webview is refusing the HTTPS→HTTP-LAN redirect (mixed-content / private
network rules). Native TV clients and Nuvio follow the redirect; for the
desktop app on the Mac itself, install the LAN or `127.0.0.1` manifest URL
instead.

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

## Playback stalls

- Choose a healthier authorized torrent; compare peer download speed with the media bitrate (`?probe=true` inspection gives bitrate and a speed verdict).
- Keep the Mac awake (`caffeinate -dimsu`); closing the lid may suspend networking.
- Test a webOS-compatible codec: prefer MP4 or compatible MKV, H.264 video, AAC/AC3 audio, SRT/WebVTT subtitles. There is no transcoding.

## Corrupt library JSON

Stop the stack and repair `data/library.json` as a JSON array. Atomic writes prevent partial replacement during normal management API updates.

## Local media path rejected

Local paths must be absolute, and browser-entered paths are validated against `MEDIA_ROOT`/managed storage. With the native app, use the Finder picker instead of typing paths. After moving or renaming linked media, use **Edit → Relink in Finder**.
