# Setup: Native macOS App

The menu-bar app bundles Node and TorrServer, preserves the library and tokenized URLs, and supervises both services. This is the only deployment mode — see [ADR 0003](../decisions/0003-native-menu-bar-app-no-electron.md) for the app design and [ADR 0009](../decisions/0009-native-only-deployment.md) for why Docker was removed.

"Just the app" still means two supervised processes: the Node add-on (library, management UI, add-on protocol, local file serving) and TorrServer (the BitTorrent engine). The app starts and stops both.

## Build and install

```bash
node packaging/fetch-node-runtime.mjs
node packaging/fetch-torrserver.mjs
node packaging/fetch-ffmpeg.mjs
./packaging/build-macos-app.sh
mkdir -p ~/Applications
ditto build/HoshiStream.app ~/Applications/HoshiStream.app
open ~/Applications/HoshiStream.app
```

Runtime downloads are pinned by `packaging/node-lock.json` and `packaging/torrserver-lock.json`.

## Menu-bar controls

- Open HoshiStream (management page in the default browser)
- Copy the Stremio URL
- Restart the server
- Reveal logs
- Start at Login
- Quit (stops both services cleanly)

## State and logs

| Path | Contents |
|---|---|
| `~/Library/Application Support/HoshiStream` | Library, settings, managed media |
| `~/Library/Logs/HoshiStream/server.log` | Server logs |

## Native file pickers

When the menu-bar app runs, the Finder file/folder controls on the management page link media in its original location without copying. A folder is added as one series; filenames such as `S01E02` or `1x02` supply episode numbers, otherwise files become season 1 in filename order. After moving or renaming media, use **Edit → Relink in Finder**.

Deleting a Finder-linked entry never deletes its source file. The browser upload fallback (available without the native app) copies videos into managed HoshiStream storage instead.

## Configuration

Copy `.env.example` to `.env`. The native app reads `ACCESS_TOKEN`, `MEDIA_DIR`,
`HOSHISTREAM_STATE_DIR`, `ADDON_PORT`, `HOME_SPEED_MBPS`, `PLAYER_PATH`, `LAN_REDIRECT`,
`TRANSCODE_ENABLED`, and `TRANSCODE_MAX_SESSIONS`,
and derives the rest — including `TORRSERVER_INTERNAL_URL`, the public URLs, and the
vendored ffmpeg/ffprobe paths — from the detected LAN address and install layout. The
remaining variables in `.env.example` only apply when running the add-on directly with
`npm start`.

Stream repair (ADR 0010) is off by default; set `TRANSCODE_ENABLED=true` to offer
"Compatible" streams for media the TV cannot direct-play. LAN discovery
(`_hoshistream._tcp` over mDNS, ADR 0011) is on by default; set `MDNS_ENABLED=false`
to turn it off.

## TorrServer tuning

TorrServer is configured for direct play rather than for conservative resource use. The
values live in `<state dir>/torrserver/config/settings.json`; the reasoning for each is in
[changelog/0.6.0-performance.md](../changelog/0.6.0-performance.md). Two need action
outside the config file:

- **Peer port `32001`.** `PeersListenPort` is fixed so it can be forwarded. Without an
  inbound path, TorrServer only reaches peers that are themselves unfirewalled, which caps
  throughput badly. Forward TCP and UDP 32001 to this machine on your router.
- **Upload is enabled.** BitTorrent peers reciprocate, so a client that refuses to upload
  gets choked or deprioritized. Use `UploadRateLimit` to cap it rather than disabling it.

## Security

Keep the add-on port (7000/7001) and TorrServer's web port (8090) on the trusted LAN only —
no router forwarding, no UPnP, no public exposure. See
[ADR 0004](../decisions/0004-token-in-path-and-bearer-security-model.md).

Port 32001 is the exception and is a different kind of port: it carries BitTorrent peer
traffic, not the management API or the add-on protocol, and exposes no HoshiStream surface.
Forwarding it does not weaken that boundary. `DisableUPNP` stays `true` so the mapping is
always explicit rather than negotiated automatically.

## Playback notes

Keep the Mac awake during playback (`caffeinate -dimsu`); closing the lid may suspend networking and stop playback.

To watch on this machine, open an entry and use **▶ Play on this Mac** in the detail
header — no TV client needed.

HoshiStream drives `mpv` directly when it can find one, which gives it play, pause, seek
and resume control ([ADR 0008](../decisions/0008-bundled-mpv-player-over-json-ipc.md)). The
binary is resolved from `PLAYER_PATH`, then a bundled copy, then `PATH`; `brew install mpv`
is enough. Without it, playback is handed to an installed IINA, VLC or mpv application
instead, which plays fine but cannot be controlled from HoshiStream.

For a series, the header action plays the first episode, or resumes the one you last
watched. To start somewhere specific, use the play button beside an episode on the **Files**
tab. The rest of the season is queued behind whichever episode you start, so playback advances
on its own — through mpv's playlist when it is driving, or through `iina-cli` when falling
back to IINA. Position is remembered per episode, so the header action resumes the exact
episode and timestamp you left. If playback stalls on a wireless link, check that before
changing any settings — a 4K remux needs a sustained 60–100 Mbps.
