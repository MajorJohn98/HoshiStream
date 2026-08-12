# 0004 — Path-token add-on URLs plus bearer-token management API on a trusted LAN

- **Status:** Accepted
- **Date:** 2026-08-10 (recorded; decision made during MVP phases)

## Context

Stremio/Nuvio clients cannot send custom headers when fetching add-on manifests and resources, so header-based auth is impossible for the add-on protocol. TorrServer serves playback and administration on one port with no route-level authorization, and its optional Basic Auth also gates playback, which is unreliable with Nuvio/webOS.

## Decision

- **Add-on protocol:** a secret token in the URL path — `/addon/{ACCESS_TOKEN}/manifest.json` and sibling catalog/meta/stream routes. The untokenized `/manifest.json` returns 401 by design.
- **Management API:** the same token as `Authorization: Bearer` on all `/api/*` routes; the management page and local media streaming use the path token.
- **Comparison:** tokens are compared in constant time via SHA-256 digests and `crypto.timingSafeEqual` (`security.ts`), avoiding both timing leaks and length exceptions.
- **TorrServer boundary:** the trusted LAN and host firewall. Both ports must never be exposed via router forwarding, UPnP, tunnels, or the public internet.
- **Logging:** access tokens, authorization headers, and complete magnet URIs are never logged.

`ACCESS_TOKEN` must be at least 20 characters (config schema); generate with `openssl rand -hex 32`.

## Consequences

- Anyone who can reach port 8090 on the LAN can administer TorrServer; untrusted LANs require a separate VLAN or host firewall rules.
- The token appears in client-side URLs (Nuvio config, browser history); rotating it means reinstalling the manifest on clients.
- Protocol responses that depend on library state (`catalog`, `meta`, `stream`) are served with `cache-control: no-store`.
