# 0012 — Stable manifest URL via a self-controlled Vercel pointer server

Status: accepted
Date: 2026-09-01
Complements: [ADR 0005](0005-host-header-public-urls.md), [ADR 0011](0011-mdns-lan-discovery.md)

## Context

The add-on URL installed in Stremio/Nuvio clients embeds the Mac's LAN IP.
ADR 0005 stopped stream URLs from going stale and ADR 0011 made the box
discoverable, but the manifest URL saved on every client still dies with each
DHCP renewal or network move, forcing the user to re-enter it on every TV.

ADR 0011 rejected an external rendezvous server because it would ship the LAN
IP and a stable identifier to third-party infrastructure *automatically and
on a schedule*, and no Stremio client could query it. This decision revisits
that boundary with two changes the user explicitly accepted: the server is
**self-controlled** (a personal Vercel deployment), and updates are
**strictly manual** — a menu-bar click, never a background heartbeat.

## Decision

- A small pointer server (`pointer/`, deployed to the user's own Vercel
  account) serves a permanent manifest URL:
  `https://<pointer-host>/addon/<token>/manifest.json`.
- The server stores exactly one record in Vercel Blob: the last-pushed LAN
  base URL, a SHA-256 hash of the access token (never the token), a copy of
  the manifest, and a timestamp. No library data, no media, no request
  proxying of content.
- `manifest.json` is served from the stored copy (some clients persist a
  post-redirect URL, which would reintroduce staleness). Every other add-on
  resource under `/addon/<token>/…` is answered with a `307` redirect to the
  Mac's pushed base URL; clients follow it per-request, so playback stays
  LAN-direct and ADR 0005 keeps the embedded stream URLs correct.
- The blob is public-read but its pathname is derived from the push secret,
  making the URL unguessable; the record contains only a private-range IP, a
  token hash, and the (non-sensitive) manifest.
- Pushes require a `PUSH_SECRET` bearer token and happen only when the user
  clicks "Update Remote Pointer" in the menu bar (or calls
  `POST /api/pointer/push`). The add-on persists the last-pushed base URL and
  flags staleness when the current LAN IP differs.
- Config-gated: `POINTER_URL` + `POINTER_PUSH_SECRET` in `.env`, both unset
  by default. Without them nothing changes and nothing is contacted.

## Consequences

- One-time client setup: the pointer URL never changes, on any network.
- Catalog/stream *requests* now transit Vercel (paths only, tokenized); media
  bytes never do. This is the accepted privacy trade-off.
- If the IP changes before the next push, playback fails until one click on
  the Mac — a deliberate trade for keeping updates manual. The menu item
  shows a warning state when the addon detects the mismatch.
- Internet or Vercel outage kills the pointer URL, but the LAN URL keeps
  working unchanged; the feature is purely additive.
- Redirect-only relaying means the pointer serves nothing useful to someone
  without the token, and sharing the *library* later (a stated future goal)
  can be layered on by teaching the server to serve pushed catalog JSON.

## Alternatives considered

- **`hoshistream.local` in the manifest URL** — zero infrastructure, but
  mDNS resolution is unreliable on Android/Google TV, the primary clients.
- **Client-side rediscovery in Nuvio** — best UX, still open as a future
  complement; does not help other Stremio clients.
- **Dynamic DNS to the LAN IP** — blocked by router rebind protection on
  many networks; still leaks the LAN IP, to public DNS instead.
- **Full proxy hosting the catalog** — pushes library data off-LAN; deferred
  until library sharing is actually wanted.
