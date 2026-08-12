# Plan: LAN-aware stream URLs behind Cloudflare Tunnel

## Problem

With a Cloudflare Tunnel in front of HoshiStream, devices using the tunnel manifest URL get stream URLs on the tunnel hostname — so video hairpins Mac → Cloudflare → back to the living-room TV even when both are on the same WiFi, burning upload and download bandwidth and capping quality.

## Approach: split control plane from data plane

Keep the lightweight addon-protocol JSON on the tunnel, but detect "this client is in my house" and hand back **LAN** stream URLs instead of tunnel URLs.

Detection: requests arriving through cloudflared carry `CF-Connecting-IP` (the client's real public IP, set by Cloudflare and not spoofable from outside). If it equals the server's **own public IP**, the client shares the household's internet connection → return the LAN URLs. Otherwise → keep Host-derived tunnel URLs.

Key insight from the codebase: the existing config fallback URLs (`PUBLIC_ADDON_URL` / `PUBLIC_TORRSERVER_URL`) are already the LAN URLs in both modes — native mode computes them from `lanIp()`, Docker mode has the user set LAN addresses in `.env`. So "return LAN URLs" simply means "prefer the config fallback over the Host header" for same-household tunnel requests. No new address discovery is needed in the addon.

Own-public-IP discovery: lazy, cached lookup of `https://www.cloudflare.com/cdn-cgi/trace` (plain text, `ip=` line), only triggered when a request actually carries `CF-Connecting-IP`. 5-minute TTL, short timeout, failures cached briefly and treated as "unknown" → safe fallback to tunnel URLs (playback still works, just not LAN-direct).

## Todos

1. **public-ip module** (`addon/src/public-ip.ts`) — `ownPublicIp(): Promise<string | null>` with TTL cache (5 min success / 30 s failure), 2 s AbortSignal timeout, `node:net` `isIP` validation, injectable fetch for tests. Structured log on refresh (never logs tokens). Unit tests.
2. **LAN-aware URL resolution** (`streams.ts`) — new `resolveClientAwareUrls(headers, fallback, ownIp)` used by the stream route: if `cf-connecting-ip` is present, valid, and equals `ownIp`, return the config fallback (LAN) URLs; else defer to the existing `resolvePublicUrls(host, fallback)`. Config gains `LAN_REDIRECT` (`auto` | `off`, default `auto`) to disable the behavior for CGNAT households where the same-public-IP heuristic misfires. Route wiring in `routes.ts` (only the `stream` resource branch). Unit tests covering: same IP → LAN, different IP → tunnel host, missing/invalid header → unchanged behavior, `LAN_REDIRECT=off`, lookup failure → tunnel host.
3. **Tunnel deployment plumbing** — optional `cloudflared` service in `docker-compose.yml` gated by `profiles: ["tunnel"]` (image `cloudflare/cloudflared`, `tunnel run --token $TUNNEL_TOKEN`, ingress configured in the Cloudflare dashboard pointing at `http://addon:<port>`), `TUNNEL_TOKEN=` added to `.env.example` with comments. `docker-compose config -q` must stay green with and without the profile.
4. **Docs** — new guide `hoshistream_docs/guides/remote-access-cloudflare-tunnel.md` (dashboard tunnel creation, Docker profile usage, native `brew install cloudflared` mode, how LAN detection works, CGNAT caveat + `LAN_REDIRECT=off`, bandwidth expectations); ADR `0007-lan-detection-via-public-ip-match.md` (decision, alternatives considered: two manifest URLs, split-horizon DNS, Worker middleman; privacy note: one outbound trace request, no data shared); changelog `0.5.0-tunnel-lan-detection.md`; update `index.md` and the API reference note on stream URL resolution.
5. **Validate and ship** — full suite (typecheck, tests, lint, format, `docker-compose config -q`), rebuild + reinstall the macOS app, live smoke test: request a stream with a forged `CF-Connecting-IP` locally to verify both branches; commit per logical unit with the Copilot trailer.

## Notes / decisions

- **Safe default**: any uncertainty (no header, lookup failure, invalid IP) → existing behavior (Host-derived URLs). LAN redirect is a pure optimization.
- **Trust model**: `CF-Connecting-IP` can only be forged by someone who can already reach the addon directly (i.e., already on the LAN or holding the token) — forging it yields a LAN URL they could compute anyway. No new attack surface.
- **No new runtime dependencies** — `fetch` and `node:net` built-ins only.
- **`/local/` and TorrServer play URLs are both rewritten** since both flow through `PublicUrls`.
- Players receiving `http://192.168.x.x` from an `https://` manifest: fine for Stremio/Nuvio native players; documented in the guide.
- Out of scope: automating tunnel creation via the Cloudflare API, Cloudflare Access in front of `/manage/`, split-horizon DNS.
