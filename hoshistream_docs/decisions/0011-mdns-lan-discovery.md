# 0011 — LAN discovery via built-in mDNS responder

Status: accepted
Date: 2026-08-23

## Context

Setting up a client today means finding the server's LAN IP and typing a
tokenized URL. The IP changes with DHCP renewals and network moves, breaking
saved URLs. Ampchor's architecture review (see
`hoshistream_docs/AMPCHOR_ARCHITECTURE.md`) showed the standard fix: publish a
Bonjour/mDNS service on the LAN so clients and setup helpers can find the box
by name — the same mechanism AirPlay and Chromecast use, needing no router
configuration.

An external rendezvous server was considered and rejected: it would ship the
LAN IP and a stable identifier to third-party infrastructure on a schedule
(the project's first phone-home), and no Stremio client could query it anyway.
mDNS achieves the same LAN-only outcome with zero infrastructure.

Where the responder lives also matters. The Swift supervisor could publish via
`NetService`, but that covers only the macOS app — not the terminal launch
path (`start-native.sh`) or the future Windows build. A small responder inside
the Node add-on covers every mode with one implementation.

## Decision

- The add-on itself advertises `_hoshistream._tcp.local` on multicast
  224.0.0.251:5353 via a dependency-free responder (`mdns.ts`, Node `dgram`).
- Records published: PTR (service enumeration and instance), SRV (host +
  add-on port), TXT (`version`, `api` only), and an A record for
  `hoshistream.local` with the current LAN IPv4.
- **The TXT record never contains the access token or any URL containing
  it.** Discovery only finds the box; trust still requires the token, which
  the user pastes once (ADR 0004 unchanged).
- Announcements go out on start; a goodbye (TTL 0) on shutdown; the LAN IP is
  re-checked periodically and a change triggers re-announcement.
- Config-gated with `MDNS_ENABLED`, default **on** — the trusted-LAN boundary
  from ADR 0004 already assumes LAN peers may see the service; anyone who
  disagrees sets it to `false`.
- No new npm dependencies: the responder encodes and parses just the DNS
  subset it needs (~200 lines).

## Consequences

- Setup helpers, future companion tooling, and standard Bonjour browsers can
  find HoshiStream by name; the add-on URL still has to be entered once.
- Stremio clients do not browse mDNS, so this does not remove the manual
  install step on the TV — it removes the "find the IP" step everywhere else.
- Multicast is blocked on some VLAN/guest networks; discovery then simply
  fails and manual entry still works. No subnet-scan fallback is built.
- A hand-rolled DNS encoder is a small maintenance surface; it is kept to a
  fixed record set with unit-tested packet building.

## Alternatives considered

- **Swift supervisor `NetService`** — macOS-app-only; leaves terminal and
  Windows modes undiscoverable.
- **`bonjour-service` npm package** — violates the two-runtime-dependency
  rule for ~200 lines of replaceable logic.
- **External rendezvous service** — rejected on privacy and client-support
  grounds, as above.
