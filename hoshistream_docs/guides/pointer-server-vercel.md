# Pointer server on Vercel — permanent add-on URL

The pointer server gives HoshiStream a manifest URL that never changes, so
you enter it into Stremio/Nuvio clients exactly once. Design and trade-offs:
[ADR 0012](../decisions/0012-vercel-pointer-server.md) and
[ADR 0013](../decisions/0013-multi-tenant-pointer-server.md) (multi-tenant).

What it does:

- Serves `https://<pointer-host>/addon/<token>/manifest.json` from a stored
  copy of your manifest.
- `307`-redirects every other add-on request to your Mac's last-pushed LAN
  address. Media never touches Vercel.
- Updates only when you click **Update Remote Pointer** in the menu bar.
- Serves **any number of users** on one deployment: the first push with your
  token claims it, and only your per-install push secret can update it
  afterwards. You can join a friend's instance or run your own.

## Option A — use an existing instance

If someone you trust already runs a pointer server, skip straight to
[Configure HoshiStream](#configure-hoshistream) with their URL. Your
`POINTER_PUSH_SECRET` is generated on first run and stays yours — the
operator never needs it. Note that the operator can see your pushed LAN
base URL (a private address) and manifest.

## Option B — deploy your own

Requirements: a free [Vercel](https://vercel.com) account and the
[Vercel CLI](https://vercel.com/docs/cli) (`npm i -g vercel`).

```bash
cd pointer
npm ci
vercel link          # create/link a project, e.g. "hoshistream-pointer"
```

### Storage

Pick one:

1. **Upstash Redis (recommended for shared instances)** — Vercel dashboard →
   your project → **Storage** → create an **Upstash Redis** (KV) store and
   connect it. This provisions `KV_REST_API_URL`/`KV_REST_API_TOKEN`
   automatically. Records expire 90 days after the last push and rate
   limits are enforced across all serverless instances.
2. **Vercel Blob (fine for personal use)** — create a **Blob** store and
   connect it (`BLOB_READ_WRITE_TOKEN`). Expiry is enforced at read time and
   rate limiting is best-effort per instance.

### Optional environment variables

- `ALLOW_PUBLIC_BASE_URLS=true` — allow pushed base URLs outside private/LAN
  ranges (e.g. a Cloudflare Tunnel hostname). Leave unset on a shared
  instance: the private-range restriction is what prevents strangers from
  using your deployment as an open redirector.
- `PUSH_SECRET` — legacy single-tenant variable; only keep it if the
  deployment predates ADR 0013, so the old record keeps serving until the
  first new-style push.

### Deploy

```bash
vercel deploy --prod
```

Note the production URL, e.g. `https://hoshistream-pointer.vercel.app`.

## Configure HoshiStream

Add to your `.env` (`~/Library/Application Support/HoshiStream/.env` for the
native app):

```bash
POINTER_URL=https://hoshistream-pointer.vercel.app
```

`POINTER_PUSH_SECRET` is already there — the app generates it on first run.
(On an install that predates this, restart once and it is added, or set any
long random value yourself.)

Restart HoshiStream (menu bar → Restart Server).

## 5. Push and install

1. Menu bar → **Update Remote Pointer**. This sends the current LAN address
   and manifest to the pointer server. It is the only time anything is sent.
   The first push claims your token; later pushes must come from the same
   install (same push secret).
2. Menu bar → **Copy Stremio URL** now copies the permanent pointer URL —
   install it in your clients once.

The **Devices** panel of the management UI shows pointer health (last push,
registration, expiry) and offers **Update** / **Remove** buttons.

## When your IP changes

Streams will fail until you click **Update Remote Pointer** again. The menu
item shows `⚠︎ IP changed` when the addon notices the mismatch. Clients never
need touching again.

## Verifying

```bash
curl -s https://<pointer-host>/addon/<token>/manifest.json | head -c 200
curl -sI https://<pointer-host>/addon/<token>/catalog/movie/private-movies.json | grep -i location
```

The first prints your manifest; the second shows a `location:` header
pointing at your LAN IP.

## Privacy notes

- The server stores, per tenant: the LAN base URL, SHA-256 hashes of the
  access token and push secret, the manifest, and timestamps. Never the
  token, the secret, the library, or media.
- Records expire 90 days after the last push; the Devices panel warns before
  that happens.
- Catalog/stream request *paths* transit Vercel; media bytes go directly
  from your Mac to the client on the LAN.
- Nothing is pushed automatically — remove `POINTER_URL` from `.env` (and
  click **Remove** in the Devices panel to delete the server-side record) to
  turn the feature off entirely.
