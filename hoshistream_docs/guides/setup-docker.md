# Setup: Docker Compose

Run the full stack (add-on + TorrServer) on an Apple Silicon Mac with Docker Desktop or [Colima](https://github.com/abiosoft/colima).

## Prerequisites

- Apple Silicon Mac, Docker + Docker Compose
- Mac and playback devices on the same trusted LAN
- Nuvio on the Mac or LG webOS TV

No host Node.js needed — the add-on image bundles Node 22.

## Configure

```bash
cp .env.example .env
./scripts/find-lan-ip.sh
```

Edit `.env`:

```env
ADDON_PORT=7000
TORRSERVER_INTERNAL_URL=http://torrserver:8090
PUBLIC_TORRSERVER_URL=http://<MAC_LAN_IP>:8090
PUBLIC_ADDON_URL=http://<MAC_LAN_IP>:7000
ACCESS_TOKEN=<long-random-secret>
LIBRARY_PATH=/data/library.json
LOG_LEVEL=info
HOME_SPEED_MBPS=10
MEDIA_DIR=/path/to/your/videos   # mounted read-only at /media
```

Use the Mac's LAN IP for both public URLs (never `127.0.0.1` or Docker hostnames). Generate the token:

```bash
openssl rand -hex 32
```

`ACCESS_TOKEN` must be at least 20 characters. Never commit `.env`.

## Run

```bash
colima start                 # if using Colima
docker compose up -d --build
docker compose ps
docker compose logs -f
./scripts/healthcheck.sh
```

If the `docker compose` plugin is unavailable, use the standalone `docker-compose` equivalents.

To develop the interface against the installed native app's library:

```bash
HOSHISTREAM_STATE_DIR="$HOME/Library/Application Support/HoshiStream" \
  docker compose up -d --build
```

Stop without deleting library or configuration:

```bash
docker compose down
```

## Install in Nuvio

Install the tokenized manifest on each client:

```text
http://<MAC_LAN_IP>:7000/addon/<ACCESS_TOKEN>/manifest.json
```

URL-encode the token if it contains reserved punctuation. The untokenized `/manifest.json` intentionally returns 401. From another LAN device, verify the manifest returns JSON in a browser, then open `http://<MAC_LAN_IP>:8090` to confirm TorrServer is reachable.

## Health

- `GET /health` — add-on process alive
- `GET /ready` — library readable and TorrServer `/echo` responding

Keep the Mac awake during playback: `caffeinate -dimsu`. Closing the lid may suspend networking.

## Security reminders

Keep ports 7000 and 8090 on the trusted LAN only — no router forwarding, UPnP, or public tunnels. See [ADR 0004](../decisions/0004-token-in-path-and-bearer-security-model.md).
