# 0009 — Native-only deployment, no containers

Status: accepted
Date: 2026-08-14
Amends: [ADR 0003](0003-native-menu-bar-app-no-electron.md)

## Context

HoshiStream shipped two deployment modes that ran the same two processes — the Node add-on
and TorrServer. Docker Compose containerized them; the native macOS app bundled the
runtimes and supervised them directly.

Maintaining both had a real cost:

- Two TorrServer settings files that had already drifted apart (`TorrentDisconnectTimeout`
  was 30 in one and 300 in the other, silently changing rebuffer behavior).
- Container filesystem paths (`/data`, `/media`) baked into the add-on's config defaults,
  which describe no real machine.
- Docker-internal hostname special cases in the config schema and in the request path,
  where `resolvePublicUrls` had to reject `addon` and `torrserver` as Host headers.
- Compose-specific documentation, environment variables, and a validation step in the
  working agreement.

Docker on macOS is also actively worse for the primary use case: it routes traffic through
a virtual machine and a userspace proxy, which costs throughput and latency on exactly the
high-bitrate streams the project exists to serve.

The deciding question was whether HoshiStream would ever need to run somewhere other than
the user's own machine — a NAS, a Raspberry Pi, or an always-on Linux box. The answer was
no: it runs on the user's Mac, and later Windows.

## Decision

Remove Docker. The native app is the only deployment mode.

- Delete `docker-compose.yml`, `addon/Dockerfile`, `addon/.dockerignore`, and the
  Compose-side `torrserver/` tree.
- Replace container path defaults with per-user application data directories:
  `~/Library/Application Support/HoshiStream` on macOS, `%LOCALAPPDATA%\HoshiStream` on
  Windows, `$XDG_DATA_HOME/hoshistream` otherwise.
- Drop the Docker-internal hostname handling in `config-schema.ts` and `streams.ts`.
- Warn, rather than fail, when a configured URL still points at a Compose hostname.

### Consequence for Windows

Removing Docker also removed the only Windows story that did not require native packaging,
so Windows support now depends entirely on a native supervisor.

This does **not** mean rewriting the supervisor. Inspecting the split shows the
platform-neutral part is already the larger one:

| Concern | Location | Portable? |
|---|---|---|
| Process supervision, ports, environment, state dirs, TorrServer config | `scripts/native-server.mjs` (~244 lines of Node) | Already portable |
| Menu bar, login item, sleep assertion, Finder pickers, log viewer | `supervisor/macos/Sources/*.swift` (~359 lines) | macOS-only |

An earlier plan proposed rewriting both in Go for cross-platform parity. That is rejected:
it would replace working, tested Swift to solve a problem that mostly does not exist, since
the supervision logic is already cross-platform Node.

**Windows gets a minimal launcher instead of a port of the menu-bar app.** The management
UI is already a browser page, and a browser-based path picker
(`listLocalMedia` + `validateBrowserLocalPath`) already exists as a fallback for the native
Finder picker. A tray application can follow if it turns out to be wanted.

## Consequences

- One deployment mode, one TorrServer config, no drift.
- Configuration defaults describe real directories.
- Streaming avoids the macOS Docker VM and proxy hop entirely.
- **Headless, NAS, and Linux deployment are given up.** This is the cost, accepted
  knowingly. Compose is recoverable from git history, but the defaults, the removed
  hostname handling, and the documentation all now assume a single user-facing machine.
- The Mac (or Windows PC) must be awake for anything to stream, including to the TV.
- An existing `.env` pointing `TORRSERVER_INTERNAL_URL` at `http://torrserver:8090` no
  longer resolves. In practice the native supervisor overrides that variable before
  starting the add-on, so installed setups keep working; the stale value only matters when
  running the add-on directly with `npm start`, which now logs a
  `stale_container_hostname` warning.
- `MEDIA_DIR` and `HOSHISTREAM_STATE_DIR` are **kept**. Despite looking Compose-shaped they
  are read by `native-server.mjs` and the start/stop scripts respectively.
