# Pointer server on Vercel — permanent add-on URL

The pointer server gives HoshiStream a manifest URL that never changes, so
you enter it into Stremio/Nuvio clients exactly once. Design and trade-offs:
[ADR 0012](../decisions/0012-vercel-pointer-server.md).

What it does:

- Serves `https://<your-project>.vercel.app/addon/<token>/manifest.json`
  from a stored copy of your manifest.
- `307`-redirects every other add-on request to your Mac's last-pushed LAN
  address. Media never touches Vercel.
- Updates only when you click **Update Remote Pointer** in the menu bar.

## 1. Create the Vercel project

Requirements: a free [Vercel](https://vercel.com) account and the
[Vercel CLI](https://vercel.com/docs/cli) (`npm i -g vercel`).

```bash
cd pointer
npm ci
vercel link          # create/link a project, e.g. "hoshistream-pointer"
```

## 2. Add Blob storage and the push secret

1. In the Vercel dashboard → your project → **Storage** → create a **Blob**
   store and connect it to the project. This provisions
   `BLOB_READ_WRITE_TOKEN` automatically.
2. Generate a long random secret and set it as an environment variable:

   ```bash
   openssl rand -hex 32          # copy the output
   vercel env add PUSH_SECRET    # paste it (Production)
   ```

## 3. Deploy

```bash
vercel deploy --prod
```

Note the production URL, e.g. `https://hoshistream-pointer.vercel.app`.

## 4. Configure HoshiStream

Add to your `.env` (`~/Library/Application Support/HoshiStream/.env` for the
native app):

```bash
POINTER_URL=https://hoshistream-pointer.vercel.app
POINTER_PUSH_SECRET=<the same secret>
```

Restart HoshiStream (menu bar → Restart Server).

## 5. Push and install

1. Menu bar → **Update Remote Pointer**. This sends the current LAN address
   and manifest to the pointer server. It is the only time anything is sent.
2. Menu bar → **Copy Stremio URL** now copies the permanent pointer URL —
   install it in your clients once.

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

- The server stores: your LAN base URL, a SHA-256 of your access token, your
  manifest, and a timestamp. Never the token, the library, or media.
- Catalog/stream request *paths* transit Vercel; media bytes go directly
  from your Mac to the client on the LAN.
- Nothing is pushed automatically — remove `POINTER_URL` from `.env` to turn
  the feature off entirely.
