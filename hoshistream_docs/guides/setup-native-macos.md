# Setup: Native macOS App

The menu-bar app bundles Node, TorrServer, FFmpeg and ffprobe, preserves the
library and tokenized URLs, and supervises both services. The candidate is
Apple Silicon, macOS 13.5+, browser-first H.264/AAC MP4 playback on a trusted LAN.
mpv is optional and separately installed. Native deployment also supports a
[foreground terminal stack](development.md), without a menu bar.
See [ADR 0003](../decisions/0003-native-menu-bar-app-no-electron.md) for the
app design and [ADR 0009](../decisions/0009-native-only-deployment.md) for why
containers were removed.

"Just the app" still means two supervised processes: the Node add-on (library, management UI, add-on protocol, local file serving) and TorrServer (the BitTorrent engine). The app starts and stops both.

## Build and install

Use Git, Node 22.18+ with npm and Apple's Command Line Tools
(`xcode-select --install`) or Xcode. From the repository root:

```bash
cd addon
npm ci
cd ..
node packaging/fetch-node-runtime.mjs
node packaging/fetch-torrserver.mjs
node packaging/fetch-ffmpeg.mjs
./packaging/build-macos-app.sh
```

Quit an existing instance, then copy `build/HoshiStream.app` to Applications
with Finder and open it. Preserve the previous app and state when replacing it;
do not assume old versions can read new state. Follow the
[stopped backup, update and rollback procedure](backup-restore-updates.md).

Runtime downloads are pinned by `packaging/node-lock.json`,
`packaging/torrserver-lock.json` and `packaging/ffmpeg-lock.json`. The current
bundled Node is v26.3.1; Node 22.18+ is the source-mode minimum, not the shipped
version. All four executables are required; a developer PATH cannot fill a gap.
Re-run the corresponding fetch script if its provenance receipt is missing.

To hand the app to another Mac, build a disk image instead — see
[distributing-macos-app.md](distributing-macos-app.md).

## First run

Once the local server is ready, a fresh install opens the skippable
[Get started guide](getting-started.md) in your browser. It helps you add a title
and connect Nuvio or Stremio. Reopen it with **Get Started** in the menu-bar menu.

The app resolves its state directory at runtime, so the bundle is portable across Macs. On
first launch it creates `~/Library/Application Support/HoshiStream` with a `.env` (mode
`0600`) containing a generated `ACCESS_TOKEN` and a `MEDIA_DIR` defaulting to `~/Movies`,
plus an empty library and TorrServer's data directories. Editing `.env` before the first
launch is optional.

A build can be pinned to a checkout for development:

```bash
HOSHISTREAM_PROJECT_ROOT=/path/to/checkout ./packaging/build-macos-app.sh
```

## Menu-bar controls

- Open HoshiStream (management page in the default browser)
- Get Started (reopen the setup guide)
- Copy the Stremio URL
- Restart the server
- Reveal logs
- Start at Login
- Use HoshiStream for Magnet Links (opt-in system default; opens Add Media for review)
- Quit (stops both services cleanly)

## State and logs

| Path | Contents |
|---|---|
| `~/Library/Application Support/HoshiStream` | `.env`, `library.json`, auxiliary JSON stores, TorrServer state |
| `~/Library/Application Support/HoshiStream/data/media` | Managed browser uploads |
| `~/Library/Logs/HoshiStream/server.log` | Server logs |
| `~/Library/Application Support/HoshiStream/onboarding.json` | Local setup progress and dismissal |

## Native file pickers

When the menu-bar app runs, the Finder file/folder controls on the management page link media in its original location without copying. A folder is added as one series; filenames such as `S01E02` or `1x02` supply episode numbers, otherwise files become season 1 in filename order. After moving or renaming media, use **Edit → Relink in Finder**.

Deleting a Finder-linked entry never deletes its source file. The browser upload fallback (available without the native app) copies videos into managed HoshiStream storage instead.

## Configuration

Installed users should let first launch generate `.env`, then edit it privately
at `~/Library/Application Support/HoshiStream/.env` if needed and choose
**Restart Server**. Checkout `.env` is separate. The native app reads
`ACCESS_TOKEN`, `MEDIA_DIR`,
`ADDON_PORT`, `HOME_SPEED_MBPS`, `PLAYER_PATH`, `LAN_REDIRECT`,
`TRANSCODE_ENABLED`, and `TRANSCODE_MAX_SESSIONS`,
and derives the rest — including `TORRSERVER_INTERNAL_URL`, the public URLs, and the
vendored ffmpeg/ffprobe paths — from the detected LAN address and install layout. The
remaining variables in `.env.example` only apply when running the add-on directly with
`npm start`.

The Mac shell uses its resolved project root for state; a `.env`
`HOSHISTREAM_STATE_DIR` does not redirect it. That environment override belongs
to the terminal start script. Record actual roots before backup or recovery.

Stream repair (ADR 0010) is off by default; set `TRANSCODE_ENABLED=true` to offer
"Compatible" streams for media the TV cannot direct-play. LAN discovery
(`_hoshistream._tcp` over mDNS, ADR 0011) is on by default; set `MDNS_ENABLED=false`
to turn it off.

## TorrServer tuning

TorrServer is configured for direct play rather than for conservative resource use. The
values live in `<state dir>/torrserver/config/settings.json`; the reasoning for each is in
[changelog/0.6.0-performance.md](../changelog/0.6.0-performance.md) and
[changelog/pointer-freshness-and-slow-link-tuning.md](../changelog/pointer-freshness-and-slow-link-tuning.md).
There is no application-side buffer — the player streams TorrServer's `/play` URL
directly — so these settings and your line are the only levers. Two need action
outside the config file:

- **Peer port `32001`.** `PeersListenPort` is fixed. Inbound peer reachability can
  affect torrent throughput; router changes are outside the initial beta
  workflow and are not an installation prerequisite.
- **Upload is capped, not disabled.** BitTorrent peers reciprocate, so a client that
  refuses to upload gets choked or deprioritized, but an unthrottled uplink on an
  asymmetric line starves the download. The shipped `UploadRateLimit` is `128` KB/s
  (~1 Mbps); raise it to roughly 70–80 % of your measured upload speed if you have
  more. `ConnectionsLimit` ships at `100`.

The file is seeded from `packaging/torrserver-settings.json` only when it does not
exist, so an existing install keeps its old values after an update. You no longer
need to edit it by hand: **System → Status → TorrServer tuning** shows the live
values of the six knobs that matter (upload/download caps, peer connections,
memory cache, read-ahead, idle-torrent timeout), applies edits through
TorrServer's own settings API — which rewrites `settings.json` for you — and has
a **Reset to shipped defaults** button. Applying reconnects TorrServer's
BitTorrent client and drops active torrents, so the form refuses while someone
is streaming. After a speed test the page also suggests an upload cap of about a
tenth of your measured download speed; it is offered, never applied silently.

## Security

Keep the add-on port (7000/7001) and TorrServer's web port (8090) on the trusted LAN only —
no router forwarding, no UPnP, no public exposure. See
[ADR 0004](../decisions/0004-token-in-path-and-bearer-security-model.md).

TorrServer administration is not guarded by the add-on token. Startup also
downloads speed-measurement data from Cloudflare; local-first is not offline.
Read the short [privacy/network statement](privacy-and-network.md).

Port 32001 carries BitTorrent peer traffic, not management or add-on requests.
Keep router/public exposure outside this beta; `DisableUPNP` stays `true`.

## Playback notes

Keep the Mac awake; closing the lid may suspend networking and stop playback.
Open an entry and choose **Play**, or select a file on **Files**, to open the
**in-browser player**. No external player is needed for compatible H.264/AAC
MP4 media. Codec/container support, source reachability and sustained playback
still depend on the browser and file; a successful sample check is not a
playback guarantee.

The legacy [host-player API](../api/management-api-reference.md#host-playback)
remains an advanced optional path, not the management page's Play button.
macOS does not bundle mpv. To use that API, install mpv separately and set
`PLAYER_PATH` in the installed app's `.env` to the executable's absolute path
(for example `/opt/homebrew/bin/mpv` for an Apple Silicon Homebrew installation),
then restart the server. Do not assume a menu-bar app inherits your shell PATH.
No Homebrew installation is required for the normal browser workflow.

The API can control mpv over IPC or hand off to an installed IINA/VLC/system
handler; handoff does not supply HoshiStream playback controls and does not
establish codec compatibility. External-player and broader codec acceptance
are outside the initial browser-first candidate promise.
