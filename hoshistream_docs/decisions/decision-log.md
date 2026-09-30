# Decision log

HoshiStream's architecture decisions, one short entry each. This living log
replaced the 27 individual ADR files on 2026-09-30 so decisions can change as
quickly as the features they govern.

## Using this log

- Entries keep their former ADR numbers, so "ADR 0020" anywhere in the docs
  means entry 0020 here. Entries are grouped by area; search for the number
  to find one. The next new entry is 0028.
- When a decision changes, edit its entry in place and add a dated
  `Changed:` line with the reason. Move a dropped decision to Retired
  decisions with a one-line reason instead of deleting it.
- Keep entries to the decision, its hard limits and the reason. Details
  belong in plans, guides and API references.
- The hard rules for coding agents live in `AGENTS.md`; keep the two in step.
- The full ADR texts (context, options, consequences) stay in git history.
  To read or restore them, find the commit that removed them and use its
  parent:

  ```sh
  git log --diff-filter=D --format=%h -1 -- 'hoshistream_docs/decisions/0*'
  git checkout <commit>^ -- hoshistream_docs/decisions
  ```

  Entry 0027's ADR was added in commit `ab0e3fc`, just before the removal;
  if a squash merge left that commit out of `main`, fetch it from the pull
  request that removed the ADR files.

## Platform and runtime

### 0001 — Pin TorrServer and use only verified endpoints

Accepted 2026-08-10. Pin moved to `MatriX.141`.

HoshiStream uses one pinned TorrServer build, `MatriX.141`, SHA-256 checked
through `packaging/torrserver-lock.json` (upstream deleted the original
`MatriX.141.1` release). It calls only endpoints verified against that
build's Swagger or source, listed in
[torrserver-endpoints-used.md](../api/torrserver-endpoints-used.md), and
validates every response with Zod. Torrents are added with
`save_to_db: false`, so TorrServer forgets inactive ones and the library stays
the record. Moving the pin means re-verifying every endpoint used.

### 0002 — One bounded disk cache

Accepted 2026-08-10. Values retuned since.

TorrServer uses a single bounded, disk-backed cache instead of RAM plus disk
tiering, removes cache data when a torrent is dropped (`RemoveCacheOnDrop`),
and keeps UPnP and its Rutor and Torznab search off. The design assumes one
active stream. The shipped values were retuned in 0.6.0 and later (a larger
cache and preload, more connections, capped upload):
`packaging/torrserver-settings.json` is the source of truth, and the owner
can change them in System → Status.

### 0003 — Native supervisor app, no Electron

Accepted 2026-08-10. Changed by 0009 (native only) and 0022 (Windows).

A small, Syncthing-style native supervisor runs the bundled Node add-on and a
TorrServer sidecar from pinned runtimes (`packaging/fetch-*.mjs`). On macOS it
is a Swift menu-bar app (`supervisor/macos`). The browser-based management UI
is the main interface; native pickers reach the add-on over a local socket.
Electron was rejected. Out of scope for now: auto-update, App Store builds, a
Windows service and a Linux daemon.

### 0009 — Native-only deployment, no containers

Accepted 2026-08-14. Its Windows launcher scope was replaced by 0022.

Docker was removed; the native app is the only way to run HoshiStream. State
lives in per-user folders (`~/Library/Application Support/HoshiStream`,
`%LOCALAPPDATA%\HoshiStream`, `$XDG_DATA_HOME/hoshistream`). The two
deployment modes had drifted apart, and Docker on macOS adds a VM and a proxy
hop to every high-bitrate stream. Accepted cost: no headless, NAS or Linux
deployment, and the computer must be awake to stream. Do not reintroduce
containers.

### 0014 — Run TypeScript source directly

Accepted 2026-09-04.

Node's built-in type stripping (Node 22.18 or later) runs `addon/src` without
a build. Relative imports use `.ts` specifiers, and `erasableSyntaxOnly` plus
`verbatimModuleSyntax` make `tsc` reject syntax Node cannot strip (enums,
namespaces, parameter properties). `--dev` launches the source; packaged apps
still ship `dist/`. `tsx` was rejected as an unneeded toolchain dependency.

### 0022 — Windows native desktop release

Accepted 2026-09-06.

Windows 11 x64 gets a small, self-contained .NET 10 Windows Forms tray app
beside the shared Node code; macOS keeps its Swift supervisor. The per-user
installer puts the program in `%LOCALAPPDATA%\Programs\HoshiStream` and keeps
state in `%LOCALAPPDATA%\HoshiStream` across upgrades and uninstalls. A
kill-on-close Job Object owns the process tree, native dialogs use
current-user named pipes, and NTFS ACLs protect private files. The app
bundles pinned mpv, ffmpeg and ffprobe with their notices, ports the Chrome
native host, and offers magnet handling as a choice without taking over
defaults. Start at Login is opt-in; firewall access stays on Private
networks. The installer is unsigned, for private sharing. Deferred: Windows
10, ARM64, signing, Store distribution and automatic updates.

## Playback

### 0008 — mpv over JSON IPC for host playback

Accepted 2026-08-14.

"Play on this computer" runs `mpv` as a child process and controls it over
its JSON IPC socket (a Unix socket or named pipe). The code lives in the Node
add-on, so one implementation serves macOS and Windows. The player is
`PLAYER_PATH`, else a bundled `vendor/mpv/<platform>-<arch>/mpv`, else `mpv`
on `PATH`; failing all three, the OS default handler opens the target without
control (`mode: "system"`). Local files are passed as paths, torrents as
TorrServer `/play` URLs with a larger demuxer buffer. The position is saved
at most every 15 s. Rejected: an HTML5 `<video>` player (WebKit and WebView2
cannot play MKV, DTS or TrueHD), handing off to IINA or VLC, and embedding a
decoder. A bundled mpv carries GPL obligations.

### 0010 — Opt-in stream repair with a vendored ffmpeg

Accepted 2026-08-23. Shipped in 0.8.0.

Direct play stays the default. With `TRANSCODE_ENABLED=true`, when the probe
predicts a failure for the requesting client (or the owner forces it for an
entry), a pinned, vendored ffmpeg repairs the stream on demand into
token-gated HLS: a copy-only remux, an audio conversion (DTS or TrueHD to
AC3), or a VideoToolbox hardware video re-encode. Tunnel clients are also
offered a lower-bitrate rendition when the original exceeds
`TRANSCODE_VIDEO_BITRATE_MBPS`. ffmpeg reads torrents through TorrServer's
loopback URL, so TorrServer still prioritizes pieces. Sessions are bounded
(`TRANSCODE_MAX_SESSIONS`, default 2), reaped when idle and swept at startup.
Never: transcoding when direct play works, background or batch
pre-transcoding, software video encoding, or an adaptive bitrate ladder.

## Security, network and remote access

### 0004 — Path token, bearer API and trusted LAN

Accepted 2026-08-10.

Stremio clients cannot send headers, so add-on URLs carry the access token in
the path (`/addon/{ACCESS_TOKEN}/…`); the untokenized manifest returns 401.
`/api/*` requires a bearer token. Tokens are at least 20 characters and are
compared in constant time. TorrServer stays inside the trusted LAN: never
expose its port, enable UPnP or bind it publicly. Never log tokens, auth
headers or complete magnet URIs. Library-dependent protocol responses are
`no-store`.

### 0005 — Stream URLs from the Host header

Accepted 2026-08-12.

Stream and add-on URLs are built from the request's Host header, with the
configured URLs as a fallback, so they keep working when the LAN IP changes.

### 0007 — LAN URLs for tunnel clients on the same network

Accepted 2026-08-12. Extends 0005.

When a request arrives through the Cloudflare Tunnel and its
`CF-Connecting-IP` equals the server's own public IP (looked up through
Cloudflare's trace endpoint; cached 5 minutes, 2 s timeout), the response uses
LAN URLs instead of tunnel URLs. Any doubt falls back to Host-derived URLs.
`LAN_REDIRECT=off` disables it, for example behind CGNAT.

### 0011 — mDNS LAN discovery

Accepted 2026-08-23.

The add-on advertises `_hoshistream._tcp.local` and `hoshistream.local`
through a dependency-free responder (`mdns.ts`), so discovery works however
HoshiStream is launched. TXT records carry only `version` and `api`, never
the token or a tokenized URL: discovery finds the box, and the token still
controls access. On by default; `MDNS_ENABLED=false` turns it off. Rejected:
an external rendezvous service (it would send the LAN IP off the network on a
schedule) and the `bonjour-service` package (a dependency for ~200 lines).

### 0012 — Stable manifest URL through a pointer server

Accepted 2026-09-01. Storage and auth replaced by 0013.

An optional pointer server (`pointer/`, deployed to the owner's own Vercel
account) gives clients a permanent manifest URL. It serves a stored copy of
the manifest and answers every other add-on path with a 307 redirect to the
last pushed LAN base URL, so media never passes through it. Pushes are
strictly manual (the menu item or `POST /api/pointer/push`), never scheduled.
Nothing is contacted unless `POINTER_URL` and `POINTER_PUSH_SECRET` are set.
Accepted trade-off: tokenized catalog and stream request paths transit
Vercel.

### 0013 — Multi-tenant pointer server

Accepted 2026-09-02. Blob storage changed by 0024.

One deployment serves many installs without accounts. Records are keyed by a
hash of the token. The first push for an unseen token claims it with a
per-install push secret, stored hashed, which later pushes, deletes and
status calls must present. Storage is Upstash Redis (90-day TTL, refreshed on
each push) with Vercel Blob as a fallback. Hardening: pushed base URLs must
be private or LAN addresses unless `ALLOW_PUBLIC_BASE_URLS=true` (no open
redirector), fixed-window rate limits, a 64 KiB manifest cap, tokens and
secrets of at least 20 characters, and a 404 for every unknown token or wrong
secret. The server never stores tokens, secrets, library data or media.

### 0024 — Immutable pointer Blob versions

Accepted 2026-09-12.

The Blob backend never overwrites a record. Each push writes a new version
under `hoshistream-pointer-v3/<tokenHash[:32]>/`; the newest is found with
the `list` API, and older versions are deleted best-effort. Vercel's Blob CDN
had served an overwritten record stale for days, so pushes "succeeded" while
redirects pointed at an old address. Redis storage and manual pushes are
unchanged; each install moves to `v3` on its next push.

## Library, metadata and catalogs

### 0006 — Inspection cache on entries

Accepted 2026-08-12. Extended 2026-09-13.

Each entry stores `inspectionCache` (info hash, selected files, time), so
stream and meta requests answer from the library and re-add the torrent
quickly instead of inspecting it again. Clients cannot set it through the
API; editing an entry's source clears it. The 2026-09-13 extension added
background refills, shared inspections and series meta served from the
cache.

### 0015 — Keep atomic JSON stores; SQLite deferred

Accepted 2026-09-04.

State stays in small JSON files written atomically (a temporary file, then a
rename; mode `0600`) and validated with Zod. The owner can read, diff, back
up and hand-edit them, and a corrupt file is quarantined and restored from
its `.bak`. If rewriting the large `inspectionCache` ever hurts, move it to a
sibling file first. Revisit when libraries routinely pass 1,000–2,000
entries, a feature needs relational queries, or two processes must share the
state folder; then use `node:sqlite` (no dependency) and keep JSON export.

### 0025 — Watched state from observed reads

Accepted 2026-09-13. Its Continue Watching rows are unadvertised since 0027.

No client reports its playback position, so watched state comes from reads
the add-on observes: the TorrServer `/cache` reader position, `Range` starts
on local files, and the browser player's own signals. A file is started at
its first read and watched after a read at 90 % or more at least 60 s later;
watched is sticky. State is stored per file in `library.json`, dropped when
the source changes, and mirrored best-effort to TorrServer's `/viewed` list.
`defaultVideoId` is set only on Continue Watching rows, never on series meta,
where Stremio treats it as a single video and hides the episode list.

### 0026 — Opt-in Cinemeta metadata enrichment

Accepted 2026-09-13.

Off by default. When on, metadata for movies and series is pulled from
Stremio's public Cinemeta after adding (or on demand) and stored on the
entry; clients are still answered from `library.json`. Only a cleaned title
and optional year leave the machine. A single confident match is applied;
otherwise the entry is marked for review with up to five candidates. Viewer
edits always win, artwork is cached locally with the remote URL as a
fallback, and ids stay `hoshi:` (the IMDb id is provenance). Limits: 2
concurrent requests, a 3-hour cache, 10 s timeouts and 2 MB per response.

### 0027 — Advertise only the private picker catalogs

Accepted 2026-09-30.

The manifest advertises only Private Movies (`private-movies`) and Private
Series (`private-series`), each with `search`, `genre` and `skip` extras.
Nuvio already shows its own Continue Watching row, which HoshiStream's extra
rows duplicated. The Continue Watching, Recently added, Unwatched and tag
handlers remain for clients with a cached manifest, so restoring a row is a
manifest-only change. Clients must reinstall the add-on, and the pointer must
be pushed again, before old rows disappear.

## Adding media, search and checks

### 0019 — Post-save source checks

Accepted 2026-09-06. Result interpretation replaced by 0023.

Saving and checking are separate. Interactive Add flows start a source check
by default after a successful save; the owner can opt out per add. A check
inspects metadata and probes one representative file with the bundled
ffprobe, within a 60 s overall deadline and a 20 s probe limit. Checks run
one at a time from a bounded queue, persist their progress, and are tied to
the source revision, so edits invalidate them and late results cannot
overwrite a changed entry. Restart marks unfinished checks as interrupted
without contacting peers. A failed check never deletes, re-creates or
silently changes an entry.

### 0020 — Manual import and the Chrome companion

Accepted 2026-09-06. Windows added by 0022.

In-app discovery is retired: no search providers, indexer settings or
Search UI.

Adding needs no search service. Manual import (magnets and `.torrent` files)
keeps torrent validation, source identity and explicit series-overlap review,
using provider-neutral drafts whose prepare and commit steps are separate,
bounded and retry-safe. The Manifest V3 Chrome companion captures only on an
explicit toolbar or context-menu action, through a side panel with temporary
`activeTab` access. It never searches sites, reads history, exports cookies,
watches downloads, runs page code or holds all-sites access. A native
messaging helper, registered for the exact extension ID, relays only
allowlisted commands; tokens, local paths and full entries never reach the
extension.

### 0021 — Native magnet-link handler

Accepted 2026-09-06. Windows added by 0022.

The macOS app declares the `magnet:` scheme and offers an explicit "Use
HoshiStream for Magnet Links" action; installing never replaces another
default. Links queue while the server starts (at most 16, for up to 60 s).
The server validates a single BitTorrent v1 identity and issues an opaque
review ticket (in memory, 10 minutes, at most 32, cleared on restart). Only
the ticket ID enters the management page's URL fragment; the magnet never
appears in browser URLs or native logs. The ticket prefills Add Media;
saving stays explicit.

### 0023 — File-scoped readiness evidence

Accepted 2026-09-07.

Metadata, sampled media, browser support and sustained playback are separate
observations. A sample counts as readable only once a video frame decodes;
timeouts and thin samples are inconclusive, not proof of a bad source.
Evidence is tied to the source revision, file and job, and is never reused
for another episode. One cancellable coordinator runs all analysis.
Automatic checks get 60 s and an explicit retry up to 180 s, with no
automatic escalation. Browser support, native-player advice and network
measurements stay separate: the host's Internet speed does not decide
whether a source is viable. No library-wide rechecks and no network activity
on restart.

## Retired decisions

In-app discovery (0016–0018) was retired by 0020 on 2026-09-06 because it was
too hard for non-technical users to set up and keep working: the bridges
needed separate services, ports, API keys and indexer lists, and the scrapers
needed per-site upkeep and could be blocked.

### 0016 — Opt-in curated torrent search

Accepted 2026-09-05. Retired by 0020.

Opt-in search over a small, maintainer-reviewed catalog of open films on the
Internet Archive, with rights evidence and a pinned SHA-256 per torrent.
Still in use: the `bencode` dependency (with `uint8-util`) approved here,
which parses torrent files in a worker (`addon/src/imports/torrent-worker.ts`).

### 0017 — Local search bridges and reviewed series imports

Accepted 2026-09-05. Bridges retired by 0020.

Optional loopback Prowlarr and Jackett bridges and explicit public indexers
were removed with the search UI. Still in force: adding sources to an
existing series is its own review-and-confirm step, and torrent metadata is
inspected only on an explicit request before commit.

### 0018 — Bundled direct search providers

Accepted 2026-09-05. Retired by 0020.

Bundled YTS, Nyaa and 1337x adapters parsed site HTML so search needed no
separate service. Sites could block them (1337x already returned 403), and
each adapter needed upkeep. The HTML parser dependency was removed with them.
