# 2026-09-02 — Multi-tenant pointer server + connected-clients dashboard

## Goal

Prepare HoshiStream for a public open-source release where:

1. Anyone can point their own Mac at a **shared pointer server** (yours or a
   community instance) — or one-click deploy their own — with zero signup.
2. Each user can see **who is connected**: a local-first dashboard on the Mac
   (recent clients, live playback) plus a small pointer-health card
   (plan "C" agreed in chat).

Non-goals: accounts/emails, cloud storage of library or media data, automatic
phone-home (pushes stay manual, per ADR 0012), torrent search, containers.

## Part 1 — Multi-tenant pointer server

### Current state

Single tenant: one `PUSH_SECRET` env var authorizes pushes, and the Vercel
Blob pathname is derived from that secret. The relay loads the one record and
compares the URL token against its stored hash.

### Design: key by token, claim-on-first-push

A "tenant" is simply the `(token, pushSecret)` pair the Mac app already
generates locally. No registration endpoint, no accounts.

- **Storage key**: `hash(token)` instead of `hash(PUSH_SECRET)`. The relay
  can then look up any tenant's record directly from the token in the URL.
- **Push** (`POST /api/pointer`): body gains `pushSecret` (or keeps it as the
  bearer header). The stored record gains `pushSecretHash`.
  - No record at `hash(token)` → **first push claims the token**; store the
    record with `pushSecretHash`.
  - Record exists → the presented secret's hash must match `pushSecretHash`,
    else `401`. (Token squatting is not a practical risk: tokens are long
    random values that never leave the owner's devices except inside URLs.)
- **Relay** (`GET /addon/<token>/…`): hash the token from the path, load that
  record, serve manifest / 307-redirect exactly as today. The global
  `PUSH_SECRET` env var is removed.
- **Record shape** (superset of today's):
  `{ baseUrl, tokenHash, pushSecretHash, manifest, updatedAt, createdAt }`.

### Storage backend

Move from Vercel Blob to **Upstash Redis** (via Vercel Marketplace):

- Direct key lookup by `hash(token)` — no blob `head` + fetch round trip.
- **Per-key TTL** (e.g. 90 days, refreshed on every push) garbage-collects
  abandoned pointers automatically.
- Built-in primitives for **rate limiting** (`@upstash/ratelimit`).
- Free tier comfortably covers a hobby community instance.

Alternatives considered: keep Blob (works, but no TTL and no rate-limit
support — fine for self-hosters who want zero extra services; we can keep the
storage layer pluggable with Blob as a fallback driver), Turso (better if we
later want history/analytics; not needed for a pointer record), Neon
(overkill for one small JSON per tenant).

### Hardening for public exposure

1. **Open-redirect protection** (the big one): validate `baseUrl` host at
   push time. Default policy allows only private/LAN ranges —
   `10/8`, `172.16/12`, `192.168/16`, `100.64/10` (Tailscale), `*.local`,
   `localhost`. Public hosts are rejected unless the deployment sets
   `ALLOW_PUBLIC_BASE_URLS=true` (documented for tunnel users; note that a
   Cloudflare-Tunnel user already has a stable URL and rarely needs the
   pointer). This prevents strangers from using a community instance as a
   phishing redirector.
2. **Rate limiting**: pushes per IP (e.g. 10/min) and relay hits per token
   (e.g. 120/min) via Upstash ratelimit.
3. **Quotas**: manifest JSON capped (e.g. 64 KiB), token min length 20,
   pushSecret min length 20 — all Zod-enforced.
4. **TTL/expiry**: records expire 90 days after the last push; the Mac app's
   pointer-health check surfaces "expiring soon" so the user re-pushes.
5. **Same privacy posture**: store only hashes of token and pushSecret;
   never log tokens, secrets, or full URLs.

### Endpoints after this phase

| Route | Method | Auth | Purpose |
|---|---|---|---|
| `/api/pointer` | POST | pushSecret (claim/match) | Create/update a tenant's pointer record |
| `/api/pointer` | DELETE | pushSecret | Remove the record ("Disconnect" menu item) |
| `/api/pointer/status` | GET | pushSecret | Pointer health: `updatedAt`, `expiresAt`, baseUrl host (for the Mac dashboard card) |
| `/addon/<token>/…` | GET/HEAD | token in path | Manifest + 307 relay (unchanged behavior) |

### Mac app changes

- Generate and persist a per-install `pointerPushSecret` alongside the
  existing token (config schema + first-run generation).
- "Update Remote Pointer" sends the new body; add "Remove Remote Pointer".
- Config: `POINTER_URL` stays; `POINTER_PUSH_SECRET` becomes per-install
  instead of shared with the server.

## Part 2 — Connected-clients dashboard (plan C)

All client visibility stays **on the Mac**; the pointer server learns nothing
new about clients (no request logging on Vercel).

1. **Recent clients (add-on)**: in-memory ring buffer (e.g. last 200
   requests) keyed by client IP + user-agent, recording last-seen time,
   device label (parsed UA: Nuvio/Stremio/TV/browser), and last resource
   type. No new database — it is ephemeral observability, rebuilt on
   restart. Exposed at a bearer-gated `GET /api/clients`.
2. **Live playback (TorrServer)**: surface active streams from the already
   verified TorrServer endpoints (torrent stats / active readers) as
   `GET /api/playback` — "what is playing right now, and how fast".
3. **Pointer health card**: the add-on (not the browser) calls
   `GET /api/pointer/status` with the push secret and relays a sanitized
   summary — last push, expiry, whether the pushed baseUrl matches the
   current LAN IP ("pointer is stale — push again?").
4. **UI**: new "Devices" panel in the existing Preact management UI (no new
   frontend stack), showing the three sections above.

## Part 3 — Open-source release checklist

- "Deploy to Vercel" button in `pointer/README.md` with env docs
  (`ALLOW_PUBLIC_BASE_URLS`, Upstash vars) so anyone can self-host.
- Guide updates: `guides/pointer-server-vercel.md` gains multi-tenant +
  self-host sections; new ADR (0013) records the multi-tenant/key-by-token
  decision, superseding the single-tenant parts of ADR 0012.
- Repo hygiene for public release: LICENSE, secret scan of history, README
  positioning ("bring your own legal media"), issue templates.

## Phases

1. **Pointer v2 core**: token-keyed storage driver (Upstash + Blob
   fallback), claim-on-first-push auth, DELETE + status endpoints, baseUrl
   host policy, tests. Backward-compat window: keep reading the old
   secret-keyed blob until the first successful v2 push.
2. **Hardening**: rate limits, quotas, TTL refresh, docs + deploy button.
3. **Mac app integration**: per-install push secret, updated menu items,
   pointer status client.
4. **Dashboard**: `/api/clients`, `/api/playback`, pointer-health relay,
   Devices panel in the management UI.
5. **Release prep**: ADR 0013, guide rewrite, changelog, license/repo
   hygiene.

Each phase lands independently; the pointer server stays usable throughout.

## Open questions

- Community instance operation: who pays/monitors the shared deployment, and
  do we advertise it in the README or only document self-hosting?
- Should relay 401s be indistinguishable from 404s (privacy: don't reveal
  that a token exists)? Leaning yes — return 404 for both.
- TTL length (90 days proposed) and whether the Mac app should offer an
  optional "re-push on network change" toggle (would soften ADR 0012's
  strictly-manual stance; default off).
