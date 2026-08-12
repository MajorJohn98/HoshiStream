# 0007 — LAN detection via public-IP match

- **Status**: Accepted
- **Date**: 2026-08-12

## Context

With a Cloudflare Tunnel in front of HoshiStream, every client uses one tunnel manifest URL. Stream URLs derived from the request Host header therefore point at the tunnel hostname, so playback hairpins Mac → Cloudflare → back to a TV on the same WiFi — wasting upload and download bandwidth and capping quality at the connection's upload speed.

## Decision

Split the control plane from the data plane. Keep addon-protocol JSON on the tunnel, but when a stream request's `CF-Connecting-IP` equals the server's own public IP, return the configured LAN fallback URLs (`PUBLIC_ADDON_URL` / `PUBLIC_TORRSERVER_URL`) instead of Host-derived tunnel URLs.

- Own public IP comes from a cached lookup of `https://www.cloudflare.com/cdn-cgi/trace` (5-minute success TTL, 30-second failure TTL, 2-second timeout, `isIP` validation). The lookup runs only when a request actually carries `CF-Connecting-IP`.
- Any uncertainty — missing or repeated header, unknown own IP, lookup failure — falls back to the existing Host-derived behavior. The LAN shortcut is a pure optimization; playback never depends on it.
- `LAN_REDIRECT=off` disables the comparison entirely for CGNAT households where one public IP is shared by strangers.

## Alternatives considered

- **Two manifest URLs (LAN + tunnel)**: works but pushes complexity onto every client device and doubles add-on installs.
- **Split-horizon DNS**: requires a local DNS server and per-network configuration; fragile for guests and mobile devices.
- **Cloudflare Worker middleman**: adds a deployment, a shared secret, and latency for information the origin already has via `CF-Connecting-IP`.

## Security and privacy

- `CF-Connecting-IP` is set by Cloudflare and cannot be forged through the tunnel. Someone who can reach the addon directly (already on the LAN) forging it gains only a LAN URL they could compute anyway — no new attack surface.
- The trace lookup is one outbound HTTPS request to Cloudflare returning the server's own public IP; no tokens or library data are transmitted, and the IP is never logged.

## Consequences

- At-home clients using the tunnel manifest stream directly over WiFi; only JSON metadata transits Cloudflare.
- Remote clients are unaffected.
- Supersedes nothing; extends ADR 0005 (Host-header public URLs) with a client-aware branch.
