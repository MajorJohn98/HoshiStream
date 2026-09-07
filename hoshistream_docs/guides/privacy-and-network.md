# Privacy and network boundary

HoshiStream keeps its library/configuration on your computer and has no
automatic beta telemetry or in-app reporting service. **Local-first does not
mean offline or anonymous.** Use only authorized media and a trusted home LAN.
The first cohort excludes router forwarding, tunnels/public exposure and
remote playback; enabling a pointer does not make media remotely accessible.

## Credentials and local data

Private management/add-on/media URLs contain the access token. Treat them like
passwords: anyone who obtains one may gain access within network reach.
Do not paste them into issues, screenshots, public link checkers or support
messages. Browser history, clipboard contents, client configuration and local
logs may expose private context even when the app does not intentionally log
tokens. Plain HTTP LAN traffic is not end-to-end encrypted.

`.env` contains the per-install `ACCESS_TOKEN` and `POINTER_PUSH_SECRET`; a
backup contains those same credentials. Never send raw `.env`, authorization
headers, full magnets, `.torrent` files, libraries, control metadata or backups
to support. Do not silently rotate lost pointer credentials: restore the private
backup or arrange deliberate claim recovery with the service operator.

The add-on listens on the LAN (normally port 7001); TorrServer's web/admin
service normally uses 8090 and is **not protected by the add-on's token**.
Both require the trusted-LAN boundary. Do not expose either through router
forwarding, UPnP, a public reverse proxy or guest/untrusted networks.
The peer port (normally 32001) is BitTorrent traffic, not the management API.

## What can contact the network

| Activity                                                  | Destination and disclosure                                                                                                                                                                                                                                                          |
| --------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Startup and manual Check Speed                            | Cloudflare `speed.cloudflare.com`: an automatic download measurement, not just a LAN test. The service sees normal connection metadata including your public IP. The implementation requests a 1 MB warm-up and up to 50 MB of test data, with bounded measurement/timeout windows. |
| LAN-aware tunnel routing, when that advanced path is used | Cloudflare `www.cloudflare.com/cdn-cgi/trace` for public-IP comparison, cached for five minutes after success. This is not the pointer and is outside first-cohort remote-access scope.                                                                                             |
| Authorized torrent metadata checks and playback           | TorrServer can contact trackers, DHT/PEX peers and torrent web seeds as applicable. Checks may read media samples; peers can observe IP addresses/infohashes. Uploading is enabled in the shipped settings. No torrent anonymity is promised.                                       |
| Local linked/uploaded media playback                      | The host serves bytes directly to the selected local/LAN player. Linked originals are not copied merely by linking them. Player software may have its own network behavior.                                                                                                         |
| LAN discovery (on by default)                             | LAN multicast mDNS advertises the service/port, not the access token. Set `MDNS_ENABLED=false` and restart to disable discovery; that does not stop other networking.                                                                                                               |
| Explicit pointer operations                               | Your selected service receives manual registration/update/check/removal requests. Registration sends the private token, per-install authentication and LAN address/port; clients using the stable URL also send that token and requested add-on paths to the service.               |
| Artwork and explicitly entered remote resources           | The browser/player may fetch configured poster/background URLs or torrent-specified resources from their hosts. Those hosts see request metadata. Do not use private URLs as artwork.                                                                                               |
| Voluntary beta feedback                                   | Only the report you deliberately submit to the selected private GitHub repository; GitHub and authorized repository members can access it. No report is sent automatically.                                                                                                         |

Saving/enabling pointer setup and app launch alone do not contact the pointer
service. Manual registration is claim-on-first-push with a unique local secret;
there is no shared installer secret. The approved suggested service is
`https://hoshistream-pointer.vercel.app`, operated by **Major John's projects**;
custom endpoints retain their own operator/data policies.

Disabling pointer use locally is not remote deletion. Use **Remove remote
pointer** before uninstalling if you want the service record removed, and
check the manual operation's result. A failed or ambiguous response is not
proof of deletion. Restore the original secret if it is lost; do not send it
to the operator. See [pointer setup](pointer-server-vercel.md).

There is currently no supported switch that makes normal startup entirely
offline: `HOME_SPEED_MBPS` is a fallback, not a speed-test opt-out, and
`LAN_REDIRECT=off` does not disable the startup speed measurement. Do not
interpret a failed speed request as telemetry consent or total network
isolation. Offline-only users should not join this advertised cohort.

For private manual diagnostics and accidental disclosure, use the
[support procedure](closed-beta-support.md). For preservation/removal
expectations, see [backup, restore and updates](backup-restore-updates.md).
