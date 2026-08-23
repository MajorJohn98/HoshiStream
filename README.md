# HoshiStream

HoshiStream is a private, local-first Stremio-compatible add-on for Nuvio. It stores a small personal catalog, asks TorrServer to inspect authorized torrents, and gives Nuvio direct TorrServer playback URLs. The Node.js add-on never proxies video bytes and does no transcoding.

Use this software only with media you own, public-domain media, or media you are authorized to access. It provides no torrent search, index scraping, source lists, or bundled magnet links.

Full project documentation lives in [`hoshistream_docs/`](hoshistream_docs/index.md) (architecture, decision records, guides, API references, plans, and changelog).

## Architecture

```text
Nuvio on Mac ───────┐
                    ├── LAN ──> HoshiStream :7001 ──> TorrServer API
Nuvio on webOS TV ──┘                  │
                                      └── returns direct :8090/play/... URL
                                                       │
                                                       └── authorized peers
```

## Current status

The five MVP implementation phases are complete:

- Native app supervising TorrServer and the add-on, with health checks.
- Tokenized manifest, atomic JSON library, catalogs, search, pagination, metadata, and management API.
- TorrServer magnet and `.torrent` registration, metadata polling, inspection, removal, and media-file selection.
- Movie streams, series episode mapping, and public TorrServer URL rewriting.
- Bounded disk cache, inactive cleanup, structured logs, tests, and documentation.

No graphical dashboard, database, external metadata provider, torrent search, or transcoder is included.

Live Mac/webOS playback still requires testing with media you are authorized to access. No test magnet is bundled.

## Prerequisites

- Apple Silicon Mac (Windows support is in progress)
- Mac and playback devices on the same trusted LAN
- Nuvio on the LG webOS TV, or nothing at all to watch on the Mac itself

Node.js 22 and TorrServer are vendored into the app bundle; a host Node installation is only needed for local development or to build from source.

## Install

### From a disk image

The released `.dmg` is the normal way to install, on your own Mac or someone else's.

1. Open `HoshiStream-<version>.dmg` and drag **HoshiStream.app** onto **Applications**.
2. Clear the quarantine flag once, since the build carries an ad-hoc signature rather than an Apple Developer ID:

   ```bash
   xattr -dr com.apple.quarantine /Applications/HoshiStream.app
   ```

   Without this, macOS usually reports "HoshiStream is damaged and can't be opened" — a dialog with no "Open Anyway" button, so the Privacy & Security override does not help. The `-r` matters: it also clears the flag from the bundled `node`, `TorrServer`, and `ffmpeg` binaries.

3. Launch it from Applications. It appears in the menu bar, not the Dock.

No configuration is needed first. The first launch creates `~/Library/Application Support/HoshiStream` containing a `.env` (mode `0600`) with a freshly generated `ACCESS_TOKEN`, a `MEDIA_DIR` defaulting to `~/Movies`, an empty library, and TorrServer's data directories.

See [guides/distributing-macos-app.md](hoshistream_docs/guides/distributing-macos-app.md) for building a disk image and the signing limitations.

### From source

```bash
cd addon && npm ci && cd ..
node packaging/fetch-node-runtime.mjs
node packaging/fetch-torrserver.mjs
node packaging/fetch-ffmpeg.mjs
./packaging/build-macos-app.sh
ditto build/HoshiStream.app /Applications/HoshiStream.app
open /Applications/HoshiStream.app
```

Runtime downloads are SHA-256 pinned by the lockfiles in `packaging/`. To produce a disk image for other Macs, run `./packaging/build-macos-dmg.sh` afterwards; it prints the path to `build/HoshiStream-<version>.dmg`.

A build normally resolves its state directory at runtime, which is what makes the bundle portable. To pin a development build to a checkout instead:

```bash
HOSHISTREAM_PROJECT_ROOT=/path/to/checkout ./packaging/build-macos-app.sh
```

### Using the app

Use the menu-bar icon to open HoshiStream, copy the Stremio URL, restart the
server, reveal logs, enable Start at Login, or quit cleanly. Mutable state is
stored in `~/Library/Application Support/HoshiStream`; logs are written to
`~/Library/Logs/HoshiStream/server.log`.

The menu-bar app keeps the Mac awake automatically while a stream is active.
Closing the MacBook lid may still suspend networking and stop playback.

To watch on the Mac itself, use **Play on this computer** on an entry's playback
tab. HoshiStream drives mpv directly, so no TV client is needed locally
([ADR 0008](hoshistream_docs/decisions/0008-bundled-mpv-player-over-json-ipc.md)).

## Configure

The app generates its own `.env` on first launch, so this is only for changing defaults. Edit `~/Library/Application Support/HoshiStream/.env` and choose **Restart Server** from the menu bar:

```env
ADDON_PORT=7001
ACCESS_TOKEN=generated-on-first-launch
MEDIA_DIR=/Users/your-name/Movies
HOME_SPEED_MBPS=10
```

The app derives everything else — `TORRSERVER_INTERNAL_URL`, the public LAN URLs, the library path, and the vendored ffmpeg paths — from the detected LAN address and install layout. The remaining variables in `.env.example` apply only when running the add-on directly with `npm start`. To confirm the LAN address the app will advertise, run `./scripts/find-lan-ip.sh`.


## Add media

Every management request requires `Authorization: Bearer`:

For a local web interface, open:

```text
http://127.0.0.1:7001/manage/ACCESS_TOKEN
```

Set `MEDIA_DIR` in `.env` to the Mac folder containing your videos. Restart
the app, open the management page, and choose a compatible file from the
**Local file** menu. Files are streamed directly without copying or
transcoding.

When the menu-bar app is running, the Finder file and folder controls keep
selected media in its original location without copying it. A folder is added
as one series; filenames such as `S01E02` or `1x02` supply episode numbers,
otherwise files become season 1 in filename order. Use **Edit → Relink in
Finder** after moving or renaming local media.

The browser upload fallback still copies selected videos into managed
HoshiStream storage. Deleting a Finder-linked entry never deletes its source.

```bash
export ACCESS_TOKEN='the-value-from-your-.env'

curl -H "Authorization: Bearer $ACCESS_TOKEN" \
  http://127.0.0.1:7001/api/library

curl -X POST \
  -H "Authorization: Bearer $ACCESS_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"type":"movie","name":"Authorized Movie","magnetUri":"magnet:?xt=urn:btih:YOUR_INFO_HASH"}' \
  http://127.0.0.1:7001/api/library
```

For a `.torrent` file, give an absolute path on the Mac:

```bash
curl -X POST \
  -H "Authorization: Bearer $ACCESS_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"type":"series","name":"Authorized Series","torrentFilePath":"/Users/your-name/Downloads/series.torrent"}' \
  http://127.0.0.1:7001/api/library
```

Update, inspect, or delete an entry:

```bash
curl -X PATCH \
  -H "Authorization: Bearer $ACCESS_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"description":"My private copy","preferredFileIndex":1}' \
  'http://127.0.0.1:7001/api/library/hoshi%3AITEM_UUID'

curl -X POST \
  -H "Authorization: Bearer $ACCESS_TOKEN" \
  'http://127.0.0.1:7001/api/library/hoshi%3AITEM_UUID/inspect'

curl -X DELETE \
  -H "Authorization: Bearer $ACCESS_TOKEN" \
  'http://127.0.0.1:7001/api/library/hoshi%3AITEM_UUID'
```

Inspection may take up to 30 seconds while TorrServer obtains metadata. File IDs are TorrServer’s one-based IDs.
The management page also probes the selected media for resolution, codecs,
duration, average bitrate, and a recommended speed with 50% headroom. Set
`HOME_SPEED_MBPS` to your measured connection speed for the viability verdict.

## Install in Nuvio

Install the tokenized manifest on both clients:

```text
http://MAC_LAN_IP:7001/addon/ACCESS_TOKEN/manifest.json
```

URL-encode the token if it contains URL-reserved punctuation. The untokenized `/manifest.json` intentionally returns HTTP 401.

From another LAN device, open the tokenized manifest in a browser first. It should return JSON. Then open `http://MAC_LAN_IP:8090`; this confirms TorrServer is reachable.

## TorrServer API decision

The image is pinned to `ghcr.io/yourok/torrserver:MatriX.141.1`, whose official release supplies Linux arm64. Its live Swagger document reports API version `MatriX.141` at:

```text
http://127.0.0.1:8090/swagger/index.html
```

The adapter uses only verified endpoints:

- `GET /echo`
- `POST /torrents` with `add`, `get`, `list`, and `rem`
- `POST /torrent/upload`
- `GET /play/{hash}/{id}`

## Cache, cleanup, and footprint

`torrserver/config/settings.json` configures:

- Disk-backed cache: 2 GiB per active torrent
- Preload target: 25% of cache, approximately 512 MiB
- Connection limit: 25
- Inactive disconnect timeout: 5 minutes
- Cache deletion when the torrent closes
- Upload disabled
- UPnP disabled
- Rutor and Torznab search disabled

TorrServer has one cache-size setting that applies to either RAM or disk; it cannot provide a separate 512 MiB RAM cache plus 2 GiB disk tier. HoshiStream therefore chooses a bounded 2 GiB disk cache. The MVP assumes one active stream, so its normal cache target remains approximately 2 GiB. Multiple simultaneously active torrents can each allocate that capacity; they are not a supported MVP workload.

TorrServer automatically closes inactive, non-persisted torrents after five minutes. This avoids stale playback URLs during normal TV navigation while `RemoveCacheOnDrop` still removes their disk cache. Logs are written to `~/Library/Logs/HoshiStream/server.log`.

## Performance and codecs

Engineering targets, not guarantees:

- One direct-play stream
- 720p or compressed 1080p
- Start within roughly 15 seconds for a healthy torrent
- Torrent speed at least 1.5× media bitrate
- Seek recovery in roughly 10–20 seconds
- Combined memory normally below 1.5 GiB
- Total images, cache, configuration, and logs near or below 5 GiB

There is no FFmpeg transcoding. Compatibility depends on Nuvio and the television. Prefer MP4 or compatible MKV, H.264 video, AAC or AC3 audio, and SRT or WebVTT subtitles.

## Health and logs

```text
GET /health
GET /ready
```

`/health` confirms the add-on process. `/ready` checks the JSON library and TorrServer `/echo`.

Logs are structured JSON for startup, library mutations, torrent inspection, file selection, stream URL generation, and failures. HoshiStream does not log access tokens, authorization headers, or magnet URIs.

## Security

- Keep both ports on a trusted LAN; never expose them through router forwarding, UPnP, a public tunnel, or the public internet.
- The add-on protocol uses a secret path token.
- The management API requires the same token as a bearer credential and compares its digest in constant time.
- TorrServer serves playback and administration on the same port and does not offer route-level authorization. Its optional Basic Auth also protects playback, which may not work reliably with Nuvio/webOS. For this MVP, the trusted LAN and host firewall are the TorrServer boundary.
- Anyone who can reach port 8090 on that LAN can reach TorrServer administration. Use a separate guest-free VLAN or host firewall if the LAN is not trusted.
- No telemetry or external account is used.

## Troubleshooting

**Port returns `Server: AirTunes` or HTTP 403:** macOS AirPlay Receiver owns port 7000. The app defaults to 7001 to avoid it; if you set `ADDON_PORT=7000`, either turn off **System Settings → General → AirDrop & Handoff → AirPlay Receiver** and restart the app, or pick another port.

**Manifest works on the Mac but not the TV:** confirm the public URLs use the LAN IP, not `127.0.0.1` or `torrserver`; verify both devices are on the same non-isolated network.

**TorrServer unavailable:** check `~/Library/Logs/HoshiStream/server.log` and open `/swagger/index.html`.

**No playable files:** inspect the entry. Supported extensions are `.mp4`, `.mkv`, `.webm`, `.avi`, `.mov`, and `.m4v`. Set `preferredFileIndex` to an inspected playable file ID when automatic selection is wrong.

**Playback stalls:** choose a healthier authorized torrent, compare peer download speed with the media bitrate, keep the Mac awake, and test a webOS-compatible codec.

**Corrupt library JSON:** the add-on quarantines an unreadable `library.json` as `library.json.corrupt-<timestamp>` and restores the last-known-good `library.json.bak` automatically. If both are damaged, stop the stack and repair the file as a JSON array. Atomic writes prevent partial replacement during normal management API updates.

## Development checks

```bash
cd addon
npm ci
npm run typecheck
npm test
npm run lint
npm run format:check

TORRSERVER_TEST_URL=http://127.0.0.1:8090 npm test
```

The optional integration test checks only health and the empty/list response; it downloads no media.

## Cleanup and uninstall

Remove one inactive torrent through TorrServer’s UI, or quit the app from the menu bar to stop both services.

To uninstall, quit the app from the menu bar, then delete `/Applications/HoshiStream.app`. All mutable state lives in `~/Library/Application Support/HoshiStream` (library, managed media, TorrServer config and cache) with logs in `~/Library/Logs/HoshiStream`. Those survive an app deletion, so a reinstall keeps your library; remove them too for a clean slate, which permanently deletes the local library, configuration, and cache.
