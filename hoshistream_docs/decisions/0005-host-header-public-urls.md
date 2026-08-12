# 0005 — Derive public stream URLs from the request Host header

## Status

Accepted (2026-08-12)

## Context

Stream responses embedded `PUBLIC_ADDON_URL` and `PUBLIC_TORRSERVER_URL`
verbatim. Docker mode reads them from `.env`; native mode captured the LAN IP
once at startup. When the Mac's DHCP address changed, every manifest and
stream URL silently pointed at a dead IP until the user edited `.env` or
restarted the app.

## Decision

Stream requests resolve both public origins from the incoming `Host` header:
the add-on origin is the request host itself, and the TorrServer origin reuses
the request hostname with the configured TorrServer port. The configured URLs
remain as fallback when the header is missing, syntactically invalid, or a
Docker-internal hostname (`addon`, `torrserver`). Catalog and metadata
responses contain no absolute self-URLs and are unchanged.

## Consequences

- A LAN IP change no longer breaks playback; whichever address the client used
  to reach the add-on is the address it gets back for streaming.
- Both services must stay reachable on the same host, which both deployment
  modes already guarantee.
- A spoofed Host header can only redirect the requester's own stream URLs, so
  no new trust boundary is introduced on the trusted LAN.
