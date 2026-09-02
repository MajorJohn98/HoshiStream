# HoshiStream pointer server

A tiny Vercel deployment that gives the HoshiStream add-on a **permanent
manifest URL**. Clients install `https://<this-host>/addon/<token>/manifest.json`
once; the server serves the manifest and `307`-redirects every other add-on
request to the owner's current LAN address. It stores only a pointer record
per tenant (base URL, token hash, push-secret hash, manifest copy) — no
library data, no media, no client logs.

**Multi-tenant, no signup** (ADR 0013): the first push with an unseen token
claims it; later pushes must present the same per-install push secret. Any
number of HoshiStream users can share one deployment — or run their own.

Updates are **manual**: the macOS menu-bar item "Update Remote Pointer"
pushes the current LAN IP. Nothing phones home automatically.

## Self-hosting

[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https%3A%2F%2Fgithub.com%2FMajorJohn98%2FHoshiStream%2Ftree%2Fmain%2Fpointer)

Then connect a storage backend in the Vercel dashboard (Storage tab):

- **Upstash Redis (recommended)** — shared rate limits and automatic 90-day
  expiry of abandoned pointers (`KV_REST_API_URL`/`KV_REST_API_TOKEN` are
  provisioned automatically).
- **Vercel Blob** — zero extra services; expiry enforced at read time,
  per-instance rate limits (`BLOB_READ_WRITE_TOKEN`).

Optional env vars:

- `ALLOW_PUBLIC_BASE_URLS=true` — accept non-LAN base URLs (e.g. Cloudflare
  Tunnel hostnames). Leave unset on shared instances: the LAN-only rule is
  the open-redirect protection.
- `PUSH_SECRET` — legacy single-tenant fallback only.

See `hoshistream_docs/guides/pointer-server-vercel.md` for full deployment
steps and `hoshistream_docs/decisions/0013-multi-tenant-pointer-server.md`
for the rationale.
