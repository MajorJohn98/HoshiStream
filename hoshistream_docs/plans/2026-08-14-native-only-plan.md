# Native-Only Consolidation Plan

Status: Phase A shipped ([changelog/0.7.0-native-only.md](../changelog/0.7.0-native-only.md)); Phase B needs a Windows machine
Date: 2026-08-14

## Problem

HoshiStream ships two deployment modes — Docker Compose and a native macOS app — that run
the same two processes (the Node add-on and TorrServer). It only ever needs to run on the
user's Mac, and later Windows. The second mode costs real maintenance: duplicated
configuration, two TorrServer settings files that already drifted apart once, container
path defaults baked into the config schema, and Docker-internal hostname special cases in
the request path.

Docker on macOS is also actively worse for the primary use case, routing high-bitrate
streams through a VM and a userspace proxy.

## Goals

- One deployment mode: the native app.
- Configuration defaults that describe a real machine instead of a container filesystem.
- A Windows path that does not depend on Docker.

## Non-Goals

- Headless, NAS, or Linux deployment. Explicitly dropped — this is the decision that makes
  the rest of the plan safe.
- Removing TorrServer or the add-on process. Both are still required; "just the app" still
  means two supervised processes.
- Bundling mpv (still blocked on GPL terms) or changing playback behavior.

## The consequence that drives Phase B

Dropping Docker removes the only Windows story that did not require native packaging.
Windows support now depends entirely on a native supervisor, which makes decision D1
blocking rather than optional.

**This changes my earlier recommendation.** The previous plan proposed rewriting the
supervisor in Go for both platforms. Inspecting the split shows that is unnecessary:

| Concern | Where it lives now | Cross-platform? |
|---|---|---|
| Process supervision, ports, env, state dirs, TorrServer config | `scripts/native-server.mjs` (~244 lines of Node) | **Already yes** — the only coupling is the `${platform}-${arch}` binary path and the picker socket |
| Tray menu, login item, sleep assertion, Finder pickers, log viewer | `supervisor/macos/Sources/*.swift` (~359 lines) | macOS-only |

The supervision logic — the part that would be genuinely painful to rewrite — is already
platform-neutral Node. Only the *shell* is macOS-specific. Rewriting the working Swift app
in Go would replace tested code to solve a problem that mostly does not exist.

**Revised D1: keep the Swift app for macOS. Give Windows a minimal launcher rather than a
port of the tray app.** A Windows v1 does not need a tray icon: the management UI is
already a browser page, and the browser-based path picker
(`listLocalMedia` + `validateBrowserLocalPath`) already exists as a fallback for the
native Finder picker. A tray app can follow later if it is actually wanted.

## Phase A — Remove Docker

### Delete

- `docker-compose.yml`
- `addon/Dockerfile`, `addon/.dockerignore`
- `torrserver/config/settings.json` and the `torrserver/` tree (the native app uses
  `native-data/torrserver/`). This also removes the drift risk that produced two
  disagreeing configs.

### Code

- **`config-schema.ts`** — replace container defaults (`/data/library.json`, `/media`,
  `/data/media`, `/data/run/supervisor.sock`) with per-platform application-data paths:
  `~/Library/Application Support/HoshiStream` on macOS, `%LOCALAPPDATA%\HoshiStream` on
  Windows. Drop the `publicUrl` refinement that rejects the Docker-internal hostnames
  `addon` and `torrserver`.
- **`streams.ts`** — drop the matching `["addon", "torrserver"]` hostname special case in
  `resolvePublicUrls`. It exists only to stop a container hostname leaking into a stream
  URL.
- **Tests** — `streams.test.ts` and `management.test.ts` assert the Docker-hostname
  behavior; replace those cases rather than deleting the coverage, so the surrounding
  Host-header logic stays tested.

### Configuration

- **`.env.example`** — point `TORRSERVER_INTERNAL_URL` at `http://127.0.0.1:8090` instead
  of the `torrserver` container hostname, and split the file into the variables the native
  app reads and the ones that only matter when running the add-on directly.

  **Correction to an earlier assumption in this plan:** `MEDIA_DIR` and
  `HOSHISTREAM_STATE_DIR` were described as Compose-only. They are not. `MEDIA_DIR` is read
  by `native-server.mjs` as the media root and `HOSHISTREAM_STATE_DIR` by
  `start-native.sh` / `stop-native.sh`. Both stay.
- **Migration note:** an existing `.env` with
  `TORRSERVER_INTERNAL_URL=http://torrserver:8090` no longer resolves. In practice the
  native supervisor overrides that variable with `http://127.0.0.1:<port>` before starting
  the add-on, so an existing native install keeps working; the stale value only bites when
  running the add-on directly. A startup warning covers that case rather than a hard
  failure.

### Documentation

- Delete `guides/setup-docker.md`; fold the still-relevant parts (TorrServer tuning
  rationale, peer-port forwarding, the ports-on-LAN-only reminder) into
  `guides/setup-native-macos.md`.
- `architecture/architecture-overview.md` — collapse "Deployment modes" to one.
- `guides/remote-access-cloudflare-tunnel.md` — drop the Compose profile; the native
  `cloudflared` path is already documented and becomes the only one.
- Update `index.md`, `README.md`, `guides/troubleshooting.md`, `guides/adding-media.md`,
  `guides/development.md`, `api/addon-protocol.md`.
- **`AGENTS.md`** — remove `docker compose config -q` from the required validation loop and
  the Docker references in the setup section. This file drives every future change, so
  leaving it stale would keep reintroducing Docker assumptions.
- Historical changelogs and superseded plans keep their Docker references; they are a
  record of what happened.
- New ADR `0009-native-only-deployment.md` recording the decision and the headless
  trade-off that was knowingly given up.

## Phase B — Windows without Docker

1. **State and paths** — `%LOCALAPPDATA%\HoshiStream` for library, logs, and TorrServer
   data, mirroring the macOS Application Support layout. The path-safety module shipped in
   0.6.0 already handles the separator and case-sensitivity differences.
2. **Launcher** — a small script or binary that runs `native-server.mjs` with the bundled
   Node, registered via a per-user Registry `Run` entry. No tray in v1.
3. **Picker** — the Unix-socket Finder picker has no Windows equivalent yet. v1 uses the
   existing browser-based path entry; `NATIVE_PICKER_SOCKET` becomes optional and the UI
   hides the native picker when it is unavailable.
4. **Firewall** — the add-on port and TorrServer peer port need inbound rules. Prompt on
   first run rather than changing firewall state silently.
5. **Packaging** — a plain zip with the layout the macOS bundle already uses. The
   `win32-x64` lockfile entries and zip/`.exe`-aware fetchers shipped in 0.6.0.
6. **Sleep prevention** — `SetThreadExecutionState`, deferred; note it as a known gap
   rather than blocking v1.

## Sequencing

Phase A is self-contained and can ship immediately. Phase B depends on Phase A only for
the path defaults, but genuinely depends on access to a Windows machine for verification.

```
Phase A (remove Docker) ──> Phase B (Windows launcher)  [needs a Windows machine]
```

## Risks

- **This is a one-way door for headless deployment.** Compose is recoverable from git
  history, but the config defaults, the removed hostname handling, and the docs all move
  toward a single machine. It is the right call given the answer about NAS use, but it
  should be a conscious one.
- **An existing `.env` will break** on `TORRSERVER_INTERNAL_URL`. Mitigated by the startup
  warning and migration note above.
- **Windows cannot be verified from this machine.** Phase B should not be declared done on
  the basis of code that compiles; it needs a real run.
- **Deleting `torrserver/config/`** discards the Docker-side settings file. The native
  config in `native-data/` is the one in use and already carries the 0.6.0 tuning.

## Verification

Per phase: `npm run typecheck`, `npm test`, `npm run lint`, `npm run format:check` from
`addon/`. The `docker compose config -q` step disappears with Phase A and must be removed
from `AGENTS.md` at the same time.

Beyond the suite, Phase A needs a live run of the native app confirming that the add-on
starts, the library loads, a local file plays through the built-in player, and a stream
URL still resolves for the TV — using the new default paths rather than the container
ones.
