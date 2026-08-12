# Troubleshooting

## Port 7000 returns `Server: AirTunes` or HTTP 403

macOS AirPlay Receiver owns the port. Turn off **System Settings → General → AirDrop & Handoff → AirPlay Receiver**, then restart the stack. Alternatively change `ADDON_PORT` in `.env`.

## Manifest works on the Mac but not the TV

- Confirm `PUBLIC_ADDON_URL` and `PUBLIC_TORRSERVER_URL` use the Mac's LAN IP, not `127.0.0.1` or `torrserver`.
- Verify both devices are on the same non-isolated network (no AP/client isolation, no guest VLAN).
- Open the tokenized manifest in the TV-side browser first; it must return JSON.

## TorrServer unavailable

```bash
docker compose ps
docker compose logs torrserver
```

Then open `http://127.0.0.1:8090/swagger/index.html`. The add-on's `/ready` endpoint also checks TorrServer `/echo`.

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
