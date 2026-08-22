# 0008 — Drive a bundled mpv over JSON IPC for host playback

Status: accepted
Date: 2026-08-14

## Context

Watching a library entry on the machine running HoshiStream required installing Stremio or
another add-on client, even though the library, the streams and the management UI are all
local. Windows is also now a shipping target, so any answer has to work on both platforms
without being written twice.

Three options were considered.

**An HTML5 `<video>` element in the management UI.** Free, and the UI is already served by
the add-on. But neither WKWebView nor WebView2 can play MKV containers or DTS and TrueHD
audio, which is most of a torrent-sourced library. It would work for MP4/H.264 and fail
for the material that matters.

**Handing the URL to an installed player** such as IINA or VLC. Trivial to implement, but
it is still a third-party dependency, HoshiStream cannot control or observe playback, and
each platform needs a different launch mechanism.

**Embedding a decoder.** Full control, but it means a native player window, transport
controls, track selection and a video pipeline — and with ADR 0003 ruling out Electron,
it would mean writing that twice, once per platform.

## Decision

Drive `mpv` as a child process over its `--input-ipc-server` JSON IPC socket.

`mpv` ships as a self-contained binary for macOS and Windows, decodes everything in a
typical torrent library, and hardware-decodes through VideoToolbox and D3D11. Its IPC
socket exposes the full command set — load, pause, seek, track selection, property
observation — as line-delimited JSON, so HoshiStream gets the control surface of an
embedded player without implementing playback.

The player lives in the Node add-on, not in the platform supervisor. The add-on is already
cross-platform, so this works on macOS and Windows today and does not depend on the
supervisor rewrite contemplated in the cross-platform plan.

Binary resolution order:

1. `PLAYER_PATH`, when set and executable.
2. A bundled `vendor/mpv/<platform>-<arch>/mpv`.
3. `mpv` on `PATH`.

When none resolves, playback falls back to handing the target to the OS default handler
(`open`, `start`, `xdg-open`). Playback works, but HoshiStream cannot control or track it,
and the API reports `mode: "system"` so the UI can say so.

Local entries are handed to the player as a **filesystem path**, not an HTTP URL, so host
playback never touches HTTP, Node, or the range-request machinery. Torrent entries get the
TorrServer `/play` URL with a larger demuxer buffer, which matters far more for a swarm
than for a local file.

## Consequences

- Host playback needs no third-party add-on client and no Electron.
- One implementation serves macOS and Windows; the IPC socket path is the only platform
  difference (Unix socket vs named pipe).
- Local playback bypasses the add-on's HTTP path entirely, which is strictly faster than
  any optimization of that path could be.
- Position is observed through `time-pos` and persisted to the library entry, so resume
  works across restarts. Writes are throttled to at most one per 15 s because the library
  is a JSON file.
- **Bundling `mpv` carries a GPL obligation.** The binary is not vendored yet; resolution
  falls through to `PATH` or the system handoff. Licensing must be settled before a
  bundled binary ships, and that is deliberately left open here.
- The socket path includes a random suffix per launch. An earlier design keyed it to the
  process id alone, which meant a crashed player left a socket file that made every later
  start fail to bind.
