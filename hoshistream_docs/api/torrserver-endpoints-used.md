# TorrServer Endpoints Used

The adapter (`addon/src/torrserver-client.ts`) talks to the native binary pinned
by `packaging/torrserver-lock.json`: upstream **MatriX.141**. The `.141.1`
container-artifact name in historical ADR 0001 is not the current native lock.
The verified source is upstream commit
`d266990face0a530880a19a3e39666d21931aed9`. Use **only** this subset; verify any
new calls against the pinned source or running Swagger at
`http://127.0.0.1:8090/swagger/index.html`.

| Endpoint | Used for |
|---|---|
| `GET /echo` | Health check and version string (`/ready`, `/api/status`) |
| `POST /torrents` `{action:"add", link, title, save_to_db:false}` | Register a magnet without persisting it |
| `POST /torrents` `{action:"get", hash}` | Poll torrent status/metadata (`waitForFiles`, 500 ms interval, caller-bounded deadline; basic checks allow 30 s) |
| `POST /torrents` `{action:"list"}` | List registered torrents |
| `POST /torrents` `{action:"rem", hash}` | Remove a torrent |
| `POST /torrent/upload` (multipart) | Register one `.torrent` file; returns one `state.TorrentStatus` object, not an array (confirmed against the running pinned Swagger) |
| `GET /play/{hash}/{id}` | Direct playback URL handed to Nuvio (rewritten to the public URL); also read by the disk-copy archiver with standard `Range` headers to copy authorized files onto registered storage volumes, and read whole-file (≤ 10 MiB, 20 s timeout) by `subtitle-service.ts` for subtitle sidecars |
| `POST /cache` `{action:"get", hash}` | Cache window for one torrent (`storage/state.CacheState`): `Capacity`, `Filled`, `PiecesLength`, `Pieces{index → {Completed,…}}`, `Readers[{Start,End,Reader}]` (piece indexes) and the embedded `Torrent` status. Polled every 2 s per actively streamed entry by `playback-telemetry.ts`; never retried. Answers `{}` before the cache exists, 404 for an unknown hash |
| `POST /viewed` `{action:"set"\|"rem", hash, file_index}` | Mirror the add-on's watched marks into TorrServer's own viewed list (`web/api/viewed.go` → `settings/viewed.go`) so its web UI agrees with HoshiStream. `file_index` is the raw one-based file id. Both actions reply 200 with an empty body; never retried; failures are logged (`viewed_sync_failed`) and ignored — `library.json` is the source of truth. `list` and `rem` with `file_index:-1` exist but are not used |

## Client behavior

- Every request has a 10 s timeout (`AbortSignal.timeout`); failures raise `TorrServerError`.
- Responses are parsed with Zod (`hash`, `stat`, `stat_string`, `file_stats[{id,path,length}]`, plus optional live stats `loaded_size`, `torrent_size`, `download_speed`, `upload_speed`, `active_peers`, `connected_seeders` surfaced by `/api/playback` — all verified against MatriX.141 `server/torr/state/state.go`); unexpected shapes fail loudly.
- `CacheState` has **no JSON tags** (`server/torr/storage/state/state.go`), so
  its fields arrive Go-cased (`Capacity`, not `capacity`). `Readers[].Start`,
  `End` and `Reader` are absolute piece indexes from
  `torrstor.Reader.getPiecesRange()`/`getReaderPiece()`; `End` is the
  read-ahead window (`CacheSize × ReaderReadAHead %`), capped at the file end.
  `Pieces` lists only pieces the cache currently holds. `Torrent` is
  `t.Status()`, so `download_speed` (bytes/s), `active_peers` and the full
  `file_stats` list come with it — one call per sample. `watch-state.ts` uses
  `file_stats` order to turn the absolute `Reader` piece into a position
  within the streamed file; `bytes_read_useful_data` is per torrent, not per
  file, so it is not used for watched state. `bit_rate` is only set by TorrServer's own `/ffp`
  path and is not relied on.
- File IDs are TorrServer's **one-based** IDs.
- `save_to_db: false` does not add a persistent database record. Inactive torrent
  expiry depends on settings and active readers, not a fixed five-minute rule.
  The shipped `TorrentDisconnectTimeout` is 600 seconds; metadata acquisition
  may wait one minute plus this value. HoshiStream checks deliberately stop
  earlier and report an inconclusive outcome.
- `file_stats` contains declared file IDs, names and lengths from torrent
  metadata. Neither that list nor status `Working` proves payload readability.
- `/play/{hash}/{id}` streams directly and does **not** run the configurable
  preloader. `PreloadCache` is a percentage of cache capacity, not a byte count
  or a mandatory startup threshold on `/play`. HoshiStream does not add
  `/stream?...&preload` calls for checking.
- A GET or Range read may wait for missing pieces; a successful short read
  establishes only those bytes. HEAD/metadata and peer counts are not playback
  tests. Cancelling a client does not guarantee that an upstream blocked reader
  is immediately removed.
- Sample checks use bounded ffprobe frame evidence, not a full-file integrity
  scan or sustained-throughput test. Engine read-ahead can exceed the probe's
  analysis window. `RemoveCacheOnDrop` controls cache cleanup, not viability.

Source references: [file listing](https://github.com/YouROK/TorrServer/blob/d266990face0a530880a19a3e39666d21931aed9/server/torr/torrent.go#L350-L363),
[play handler](https://github.com/YouROK/TorrServer/blob/d266990face0a530880a19a3e39666d21931aed9/server/web/api/play.go#L64-L84),
[preload calculation](https://github.com/YouROK/TorrServer/blob/d266990face0a530880a19a3e39666d21931aed9/server/torr/apihelper.go#L266-L276),
[metadata timeout](https://github.com/YouROK/TorrServer/blob/d266990face0a530880a19a3e39666d21931aed9/server/torr/torrent.go#L111-L130),
[cache handler](https://github.com/YouROK/TorrServer/blob/d266990face0a530880a19a3e39666d21931aed9/server/web/api/cache.go),
[CacheState struct](https://github.com/YouROK/TorrServer/blob/d266990face0a530880a19a3e39666d21931aed9/server/torr/storage/state/state.go),
[cache GetState and reader ranges](https://github.com/YouROK/TorrServer/blob/d266990face0a530880a19a3e39666d21931aed9/server/torr/storage/torrstor/cache.go).
