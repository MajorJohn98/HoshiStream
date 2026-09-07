# Remote Access with Cloudflare Tunnel

Expose HoshiStream securely outside your home without opening router ports. A Cloudflare Tunnel makes an outbound connection from your machine to Cloudflare; clients reach the add-on through a hostname on your domain. HoshiStream detects when a tunnel client is actually inside your house and hands it LAN stream URLs so video never hairpins through Cloudflare.

## Prerequisites

- A Cloudflare account (free plan works) with a domain added to it.
- The native app running.

## 1. Create the tunnel

1. Cloudflare dashboard → **Zero Trust → Networks → Tunnels → Create a tunnel** (Cloudflared connector).
2. Name it (e.g. `hoshistream`) and copy the **tunnel token**.
3. Under **Public Hostname**, add e.g. `hoshi.your-domain.com` pointing at
   `http://localhost:7001` (or whichever `ADDON_PORT` you configured).

## 2. Run the connector

### macOS

```bash
brew install cloudflared
sudo cloudflared service install eyJh...   # the tunnel token
```

`cloudflared` runs as a LaunchDaemon and reconnects automatically.

### Windows

The HoshiStream Windows installer does not bundle or automatically configure
`cloudflared`. Download it separately from
[Cloudflare's official downloads](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/downloads/)
and follow the dashboard's **Windows** connector instructions for your tunnel.
Cloudflare also documents
[Windows service setup](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/do-more-with-tunnels/local-management/as-a-service/windows/)
for locally managed tunnels.

The connector's service permissions and credentials are separate from
HoshiStream's per-user tray and optional Start at Login. A running connector
does not start HoshiStream before the user signs in. Keep tunnel credentials
private; do not include them in HoshiStream logs or release artifacts.
The existing remote-pointer action remains manual on Windows.

## 3. Use the tunnel manifest URL

Install the add-on in Stremio/Nuvio with the tunnel hostname:

```
https://hoshi.your-domain.com/addon/<ACCESS_TOKEN>/manifest.json
```

The path token still gates everything; the tunnel adds TLS for free.

## How LAN detection works

Requests through the tunnel carry a `CF-Connecting-IP` header with the client's real public IP (set by Cloudflare — it cannot be forged from outside). When a stream is requested, HoshiStream compares that IP with its own public IP (a cached lookup of `cloudflare.com/cdn-cgi/trace`, refreshed every 5 minutes):

- **Match** → the client shares your internet connection, so the stream URLs use your configured LAN addresses (the auto-detected LAN IP, or `PUBLIC_ADDON_URL` / `PUBLIC_TORRSERVER_URL` when running the add-on directly). Video flows directly over WiFi.
- **No match, missing header, or lookup failure** → stream URLs keep the tunnel hostname. Playback always works; the LAN shortcut is purely an optimization.

```mermaid
flowchart LR
    A[Stream request] --> B{CF-Connecting-IP present?}
    B -- no --> H[Host-derived URLs]
    B -- yes --> C{Equals own public IP?}
    C -- yes --> L[LAN URLs - direct WiFi playback]
    C -- no / unknown --> H
```

Only the small JSON control-plane responses ever touch Cloudflare for at-home clients; the video bytes stay on your network.

## Caveats

- **CGNAT**: if your ISP puts multiple households behind one public IP, unrelated clients could be mistaken for at-home ones and receive unreachable LAN URLs. Set `LAN_REDIRECT=off` in `.env` to always use tunnel URLs.
- **Upload bandwidth**: remote playback is capped by your home connection's upload speed.
- **Free-plan terms**: Cloudflare's free tier is not intended for heavy sustained video proxying; personal remote viewing is generally fine, but the LAN detection keeps at-home traffic off Cloudflare entirely.
- **Mixed content**: the manifest is `https://` while LAN stream URLs are `http://` — Stremio and Nuvio native players handle this fine.
