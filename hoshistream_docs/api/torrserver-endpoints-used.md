# TorrServer Endpoints Used

The adapter (`addon/src/torrserver-client.ts`) talks to the pinned `ghcr.io/yourok/torrserver:MatriX.141.1` (API `MatriX.141`) and uses **only** this verified subset. Do not add endpoints without re-verifying against the running build's Swagger at `http://127.0.0.1:8090/swagger/index.html` ([ADR 0001](../decisions/0001-torrserver-matrix-141-pinning.md)).

| Endpoint | Used for |
|---|---|
| `GET /echo` | Health check and version string (`/ready`, `/api/status`) |
| `POST /torrents` `{action:"add", link, title, save_to_db:false}` | Register a magnet without persisting it |
| `POST /torrents` `{action:"get", hash}` | Poll torrent status/metadata (`waitForFiles`, 500 ms interval, 30 s deadline) |
| `POST /torrents` `{action:"list"}` | List registered torrents |
| `POST /torrents` `{action:"rem", hash}` | Remove a torrent |
| `POST /torrent/upload` (multipart) | Register a `.torrent` file |
| `GET /play/{hash}/{id}` | Direct playback URL handed to Nuvio (rewritten to the public URL) |

## Client behavior

- Every request has a 10 s timeout (`AbortSignal.timeout`); failures raise `TorrServerError`.
- Responses are parsed with Zod (`hash`, `stat`, `stat_string`, `file_stats[{id,path,length}]`); unexpected shapes fail loudly.
- File IDs are TorrServer's **one-based** IDs.
- `save_to_db: false` means TorrServer auto-closes inactive torrents after 5 minutes and `RemoveCacheOnDrop` clears their disk cache.
