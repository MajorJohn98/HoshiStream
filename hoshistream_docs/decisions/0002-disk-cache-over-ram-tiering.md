# 0002 — Single bounded disk cache instead of RAM + disk tiering

- **Status:** Accepted
- **Date:** 2026-08-10 (recorded; decision made during MVP phases)

## Context

The original goal was a small RAM cache (~512 MiB) plus a larger disk tier. TorrServer has one cache-size setting that applies to either RAM or disk; it cannot provide separate tiers.

## Decision

Configure a bounded disk-backed cache in `torrserver/config/settings.json`:

- 2 GiB cache per active torrent, preload target 25% (~512 MiB)
- Connection limit 25; inactive disconnect after 5 minutes
- `RemoveCacheOnDrop`: cache is deleted when the torrent closes
- Upload, UPnP, and Rutor/Torznab search disabled

The MVP assumes one active stream, so the normal cache target is ~2 GiB. Compose additionally caps TorrServer at 1.3 GiB RAM and the add-on at 200 MiB.

## Consequences

- Predictable disk footprint; total stack target near or below 5 GiB.
- Multiple simultaneous torrents can each allocate 2 GiB — explicitly not a supported MVP workload.
- Non-persisted torrents auto-close after 5 minutes of inactivity, avoiding stale playback URLs during TV navigation.
