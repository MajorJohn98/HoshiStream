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
- Updates only when you click **Register / update** in Activity or
  **Update Remote Pointer** in the menu bar.
- Serves **any number of users** on one deployment: the first push with your
  token claims it, and only your per-install push secret can update it
  afterwards. You can join a friend's instance or run your own.

## Option A — use an existing instance

If someone you trust already runs a pointer server, skip straight to
[Configure HoshiStream](#configure-hoshistream) with their URL. Your
`POINTER_PUSH_SECRET` is generated on first run and stays in your private
configuration. Manual actions send it to the chosen service for authentication;
never give it to an operator as a setup step. Trust the operator: the service
processes your credentials and sees your pushed LAN address and manifest.

For the closed beta, the suggested endpoint is
`https://hoshistream-pointer.vercel.app`, operated by **Major John's projects**
(the project owner's Vercel team). This is a suggestion, not automatic enrollment.
Existing custom endpoints are preserved. The endpoint and operator were confirmed
against the linked Vercel project on 2026-09-07; deployed multi-recipient/client
acceptance remains a release gate.

To find another deployment's URL, open Vercel, select its project, then
**Settings > Domains** and choose the stable production domain, not a preview
deployment URL. The project/team selector identifies the operator responsible
for the deployment. A service URL is not a Vercel API token, Redis credential,
Blob credential, or deployment-wide `PUSH_SECRET`.

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

In the installed app, choose **Remote Pointer Settings...** from the menu bar,
or open **Activity > Remote pointer** in the management page:

1. Review the suggested service or enter your own trusted HTTPS service origin.
2. Click **Save and enable**. This saves setup privately on this computer;
   it does not contact the service, register a record, or require a restart.
3. Click **Register / update** to send this installation's current LAN address
   and manifest. The first push claims its token with its own push secret.
4. After a successful, current registration, **Copy private pointer URL**
   supplies the stable URL. The native **Copy Stremio URL** uses it only while
   the local state reports it usable; otherwise it uses the direct LAN URL.

HTTPS endpoints must be origins without a path, query, fragment, or embedded
credentials. Loopback HTTP is allowed for local self-hosted development only.
Changing service while a remote record is still remembered requires removing
that record first; disabling locally alone does not remove it.

The full-stack terminal path (`node scripts/native-server.mjs --dev`) generates
credentials in the checkout's `.env` and uses `native-data/` for pointer state.
The installed app uses `~/Library/Application Support/HoshiStream/.env` and
pointer state in that same state directory. `pointer-settings.json` stores the
enabled state and service origin; `pointer-state.json` stores registration
evidence. Neither file replaces the secret in `.env`.

Advanced configuration can still set an initial endpoint in `.env`:

```bash
POINTER_URL=https://hoshistream-pointer.vercel.app
```

Restart after editing `.env`. Saved UI settings take precedence over this
initial endpoint, including an explicit disabled choice. Keep `.env`, its
`ACCESS_TOKEN`, and its `POINTER_PUSH_SECRET` private and unchanged during upgrades.
The add-on-only `npm run dev` path does not run native first-run provisioning;
use the whole-stack command for generated recipient credentials.

## When your IP changes

Pointer-based requests can fail until you click **Register / update** again.
The menu flags a changed address. This is not automatic IP tracking.
**Get started > Copy direct LAN URL** and the native **Copy Direct LAN URL**
remain available when the pointer service is unavailable. Browser clients
that block HTTPS-to-HTTP LAN redirects must use this direct URL; it needs
reinstalling in those clients when the LAN address changes.

## States and recovery

Opening Activity or saving setup only reads/writes local state. **Check service**
is a separate manual request. Status is observed evidence, not a continuous
guarantee of service availability.

| State | Action |
|---|---|
| Disabled / not configured | Review the service and save/enable locally, then register manually. |
| Ready to register | No successful current registration is recorded; click Register / update. |
| Registered | The last successful operation confirmed the record. Keep the computer running on the LAN. |
| LAN address changed | Register / update manually from the new network. |
| Expired | Register / update again; server records expire after 90 days without a push. |
| Service unreachable / invalid response / rate limited | Keep using the direct LAN URL; verify the endpoint and retry the manual action later. |
| Authentication failed | Restore the original per-install push secret; a new random secret cannot update an existing claim. An old single-tenant deployment must be upgraded by its operator. |
| Record or credential not confirmed | The status API deliberately returns 404 for both missing records and wrong credentials. Do not infer a successful removal or a free claim; a deliberate update distinguishes authentication rejection. |
| Local setup unavailable | Check private state permissions or restore its backup. Corrupt files are not silently replaced. |

On an older installation with no pointer history, first-run provisioning can
backfill a missing secret. If an endpoint or pointer state already exists, a
missing/invalid secret is **not** silently replaced. Restore the original `.env`
from your private backup while the app is stopped. If the whole `.env` is lost
but pointer files remain, startup stops instead of assigning a new identity.

Without a backup, contact the chosen service's operator through a private
support channel. The operator may remove the old record after confirming the
request through an appropriate out-of-band process, or you can wait for its
expiry. Only after the old claim is deliberately retired should you explicitly
generate/set a new local push secret and register again. Changing the access
token also changes every installed add-on URL; do not do it as a silent repair.
Never use the operator's Vercel, Redis, Blob, or legacy shared `PUSH_SECRET`
credentials as a recipient credential.

**Remove remote record** deletes the service record only after acknowledged
success; failures leave local evidence intact for retry. **Disable locally**
prevents further pointer operations but retains credentials and any existing
remote record. Re-enable before removing it. These actions never remove media
or library entries.

## Privacy notes

- The server stores, per tenant: the LAN base URL, SHA-256 hashes of the
  access token and push secret, the manifest, and timestamps. Never the
  raw token, raw secret, library, or media in its application record. Requests
  necessarily carry credentials; the operator and hosting platform process
  them, and access-log policy is the operator's responsibility.
- Records expire 90 days after the last push; Activity shows the expiry.
- Catalog/stream request *paths* transit Vercel; media bytes go directly
  from your Mac to the client on the LAN.
- Nothing is pushed automatically. Remove the remote record, then disable
  locally to leave the service. Saving a suggested endpoint alone sends nothing.
