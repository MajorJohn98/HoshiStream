# 0013 — Multi-tenant pointer server keyed by token (claim-on-first-push)

Status: accepted (2026-09-02). Supersedes the single-tenant storage and auth
model of [ADR 0012](0012-vercel-pointer-server.md); the redirector design,
manual-push rule, and privacy posture of 0012 stand unchanged.

## Context

HoshiStream is being released as open source. One pointer server deployment
should be able to serve many independent users — friends sharing one
community instance, or self-hosters — without accounts, emails, or any
central registry. ADR 0012's design keyed everything to a single
deployment-wide `PUSH_SECRET` environment variable: one deployment, one
tenant.

## Decision

1. **Records are keyed by `hash(token)`.** The relay hashes the token from
   the incoming `/addon/<token>/…` URL and loads that tenant's record
   directly. Any number of tenants share one deployment.
2. **Claim-on-first-push.** A tenant is the `(token, pushSecret)` pair the
   Mac app generates locally. The first `POST /api/pointer` with an unseen
   token stores the record along with `hash(pushSecret)`; every later push
   (and `DELETE`, and `GET /api/pointer/status`) must present the same
   secret. There is no registration endpoint. Token squatting is not a
   practical risk: tokens are long random values that never leave the
   owner's devices except inside their own add-on URLs.
3. **Storage is pluggable: Upstash Redis preferred, Vercel Blob fallback.**
   When `UPSTASH_REDIS_REST_URL`/`KV_REST_API_URL` credentials exist, records
   live in Redis (spoken to via plain `fetch` — no new dependency) with a
   90-day TTL refreshed on every push, and rate limiting uses shared
   `INCR` windows. Without Redis, records are Blob objects at a pathname
   derived from the token hash, expiry is enforced at read time, and rate
   limiting is per-instance best effort.
4. **Public hardening.**
   - Pushed `baseUrl`s must be private/LAN space (10/8, 172.16/12,
     192.168/16, 100.64/10, 169.254/16, loopback, `.local`, ULA/link-local
     IPv6) unless the deployment sets `ALLOW_PUBLIC_BASE_URLS=true`. This
     stops strangers from using a shared instance as an open redirector.
   - Fixed-window rate limits: pushes 10/min/IP, relay 120/min/token,
     status 30/min/IP.
   - Manifest payloads are capped at 64 KiB; tokens and secrets must be at
     least 20 characters.
   - Wrong tokens, unknown tokens, and wrong secrets all answer `404` so the
     server reveals nothing about which tokens exist.
5. **Backward compatibility.** The relay still falls back to the legacy
   `PUSH_SECRET`-keyed blob when a token has no v2 record, so an existing
   install keeps working until its first v2 push.

## Consequences

- Anyone can point their install at a shared deployment, or one-click deploy
  their own; the server still stores only `{baseUrl, tokenHash,
  pushSecretHash, manifest, timestamps}` per tenant — no tokens, secrets,
  library data, or media.
- `POINTER_PUSH_SECRET` becomes a per-install secret generated on first run
  (like `ACCESS_TOKEN`), no longer a value shared with the server operator.
- Abandoned pointers self-delete after 90 days without a push; the Devices
  panel surfaces upcoming expiry so users re-push in time.
- A community instance operator pays for Vercel/Upstash free-tier usage and
  can see pushed LAN base URLs (private addresses) and manifests; users who
  find that unacceptable self-host.

## Alternatives rejected

- **Accounts/registration** — needless friction and a privacy liability for
  a record this small.
- **A full database (Neon/Turso/Supabase)** — one small JSON per tenant
  needs a KV store at most; history/analytics are explicitly not wanted.
- **Client tracking on the server** — connected-clients visibility stays on
  the Mac (plan C); the pointer server learns nothing about clients.
