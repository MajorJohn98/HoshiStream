# Adding Media

Use only media you own, public-domain media, or media you are authorized to access.
Add media manually in the app or with the same-computer
[Chrome companion](chrome-companion.md). In-app torrent discovery and provider
configuration have been removed; existing library entries remain usable.

New to the app? Open **Get started** in the sidebar for
[first-title and player setup](getting-started.md).

## Management page (recommended)

Open the token-gated page locally:

```text
http://127.0.0.1:7000/manage/<ACCESS_TOKEN>
```

Press **+ Add Media** in the Library toolbar to open the Add Media dialog. From there you can add magnet links, upload `.torrent` files, pick local files (native Finder picker with the menu-bar app, or browser upload fallback), and pick tags; the entry sheet then lets you edit metadata, posters, and tags, inspect entries, and probe technical details.

Details can also be fetched for you. Turn on **Title details from Cinemeta** under System → Status (off by default; it sends each title's name and year to Stremio's public Cinemeta service, see [privacy](privacy-and-network.md)). New titles then get their description, artwork, year, runtime, rating, cast, genres, and episode names automatically when the match is unambiguous; otherwise the entry sheet's **Match** card shows a short pick list. Anything you type yourself is never overwritten — a field written by Cinemeta shows a small "from Cinemeta" hint until you edit it. **Fetch details for existing titles** on the same card backfills a library that was added before the toggle.

### Saved does not mean ready to play

**Inspect and check after saving** is on by default in interactive Add, with a
per-add opt-out. Saving happens first. The separate check then resolves metadata
and reads a bounded sample with ffprobe; torrent checks may contact peers.
Failures keep the saved entry and offer retry/cancel rather than another Add.

Progress distinguishes queued, inspecting and probing from the result. A timeout
is **inconclusive**, not proof that a torrent is unplayable. **Metadata found**
means the file listing is available; **Sample read** requires a decoded video
frame, not merely a codec name in the file header. Browser support is a separate
hint, not the source's availability.

A basic check examines one selected file, not every episode. Format,
audio codec, browser capabilities and changing swarm availability can still
affect actual playback. Use the existing Compatible/native-player options where
appropriate; checks do not start transcoding or change your selected file.

Automatic/basic checks have a 60-second overall deadline and a 20-second probe
limit. An explicit longer retry has a 180-second total limit; it is never started
automatically. Both modes are cancellable. TorrServer
can prefetch cache pieces, so the probe's analysis limit is not a hard network
byte cap. Restarted/incomplete checks are marked interrupted and are not
automatically resumed.

Facts are scoped to the file and source that were checked and carry an observation
time. Older analysis results remain historical information, not current playback
assurances. A failed later attempt does not erase known codec facts, but also does
not leave an old positive result as the latest availability result.

The browser player distinguishes slow startup, buffering, autoplay restrictions,
and decoding errors. Slow startup alone does not switch formats. Use retry/wait
or explicitly choose another offered quality when needed. **Open direct stream**
opens the raw media URL; it is not an automated playback test.

### Open magnet links directly on macOS

Install the current HoshiStream app in Applications and choose **Use HoshiStream
for Magnet Links** from its menu-bar menu. This changes the Mac's default magnet
handler; it does not require the Chrome extension. Accept the browser's
**Open HoshiStream** prompt when shown.

Clicking a magnet starts HoshiStream if necessary and opens Add Media in your
default browser, with the magnet and any suggested name filled in. Review and
edit the details, then press **Add to library**. Opening a link alone never saves
an entry or downloads torrent data.

The private handoff expires after ten minutes or an app restart. If it expires,
click the original magnet again or choose **Enter manually**. To use another
default torrent app later, select that app's magnet-association setting.

### Chrome-assisted adding

Browse normally, then use **Add to HoshiStream** on a magnet link or open the
companion's side panel. Review the suggested name, type and tags before adding.
You can also paste a magnet or choose/drop a `.torrent` file already downloaded
through the browser. No indexer, API key or local server address is needed.

The native helper transfers only the selected source and approved metadata to
the local app. It does not export browser cookies or browsing history. A duplicate
source offers the existing entry instead of silently adding another copy.
See [the companion guide](chrome-companion.md) for installation and recovery.

Back up **`library.json` and the managed media directory together**. The browser's
JSON export excludes local paths and does not embed `.torrent` files; by itself it
cannot restore a file-backed source. Imported files follow the existing managed
media deletion rules.

### Add a captured source to an existing series

In the companion, choose **Add to existing series**, select a torrent-backed
series and optionally supply a season hint. Local-file/folder entries are not
eligible. Filename season/episode numbers take precedence over the hint.

Request an episode preview explicitly. This can contact peers through TorrServer
to inspect metadata, but does not yet add the source. If the existing series
has not been inspected, inspect it first so the preview can compare its episodes.

Review new episodes and overlaps. Confirm replacements before adding a source
that covers episodes already present; the newly appended source wins those
overlaps. A changed target or expired preview requires a fresh review rather
than silently reusing old approval. Existing title, tags and source choices are
not overwritten.

The confirmation is retry-safe, including after a lost response and restart.
Cancelling or expiring a preview reclaims its temporary torrent metadata.
Imported extra-source files retain their managed ownership through source edits
and reorderings. Removing a source or entry never deletes user-owned files or
managed files still referenced elsewhere.

### Tags

Tags are genre-style labels (Action, Comedy, Anime, …). Toggle them on the Add Media dialog or the entry sheet's Overview form; type a new name and press Enter to create one on the spot. The Library's tag chips filter to titles carrying **every** selected tag, and Stremio shows the same tags as genres in its catalog picker. The **Tags** page (sidebar) lists every tag with its usage count and lets you add, rename, or delete tags — renames and deletions update all titles that carry the tag.

### Multi-torrent series

One series entry can be backed by several torrents — season packs, single
episodes, or a mix:

- **Add Media** dialog (magnet source): use **+ Add another torrent** to attach
  extra magnets, each with an optional season number for packs whose file
  names carry no `SxxEyy` numbering.
- **Detail → Source** tab: add or remove extra torrents on an existing
  torrent-backed series; re-inspect afterwards to refresh the episode list.
- Filename numbering always wins over the season hint. If two torrents claim
  the same episode, the most recently added source wins — add a better pack
  to replace episodes.

### Local files

- With the native app: Finder pickers link files/folders in place — nothing is copied. The **Add Media** local/folder cards show a **Choose with Finder** button, and the detail **Source** tab offers **Relink in Finder** after moving/renaming. A folder becomes one series; `S01E02` / `1x02` filename patterns map episodes, otherwise files become season 1 in filename order.
- Set `MEDIA_DIR` in `.env` to the folder containing your videos, restart the app, then choose from the **Local file** menu.
- Browser upload always copies the file into managed storage; deleting a Finder-linked entry never deletes the source.

Supported extensions: `.mp4`, `.mkv`, `.webm`, `.avi`, `.mov`, `.m4v`.

### Subtitle sidecars

Subtitle files already sitting next to a video — in the torrent or in a linked
folder — are offered automatically to Nuvio and the browser player; there is
no subtitle search or download. `.srt`, `.vtt`, `.ass` and `.ssa` files match
a video by name: `Movie.srt`, `Movie.en.srt`, `Movie.eng.forced.srt`, or a
`Subs/` copy of the same name. For a movie torrent with a single video file,
every sidecar in the torrent is offered (release groups often name them by
language alone). SRT is converted to WebVTT on the fly; nothing is stored.

## Management API (curl)

All `/api/*` requests need `Authorization: Bearer <ACCESS_TOKEN>`. Full reference: [management-api-reference](../api/management-api-reference.md).

```bash
export ACCESS_TOKEN='the-value-from-your-.env'

# list
curl -H "Authorization: ******" http://127.0.0.1:7000/api/library

# add a movie by magnet
curl -X POST -H "Authorization: ******" \
  -H 'Content-Type: application/json' \
  -d '{"type":"movie","name":"Authorized Movie","magnetUri":"magnet:?xt=urn:btih:YOUR_INFO_HASH"}' \
  http://127.0.0.1:7000/api/library

# add a series from a .torrent placed under data/
curl -X POST -H "Authorization: ******" \
  -H 'Content-Type: application/json' \
  -d '{"type":"series","name":"Authorized Series","torrentFilePath":"/data/series.torrent"}' \
  http://127.0.0.1:7000/api/library

# update / inspect / delete (URL-encode the hoshi: id)
curl -X PATCH -H "Authorization: ******" -H 'Content-Type: application/json' \
  -d '{"description":"My private copy","preferredFileIndex":1}' \
  'http://127.0.0.1:7000/api/library/hoshi%3AITEM_UUID'

curl -X POST -H "Authorization: ******" \
  'http://127.0.0.1:7000/api/library/hoshi%3AITEM_UUID/inspect'

curl -X DELETE -H "Authorization: ******" \
  'http://127.0.0.1:7000/api/library/hoshi%3AITEM_UUID'
```

## Inspection and viability

Basic inspection allows up to 30 seconds for torrent metadata; file IDs are
TorrServer's returned one-based IDs. A timeout means metadata did not arrive
within that attempt's budget, not that the source is dead. Add `?probe=true` to
inspection for bounded technical analysis through the same queue as source
checks. Probes read a limited packet window and require an actual decoded video
frame before reporting sample readability.

Average bitrate and the recommended speed with 50% headroom are estimates.
`HOME_SPEED_MBPS` and the built-in speed test describe the host's Internet
download connection, not swarm throughput, client Wi-Fi, or remote upload
capacity. They do not determine a playable/unplayable verdict.

If automatic file selection is wrong, set `preferredFileIndex` to an inspected playable file ID. For series, `fileOverrides` can include/exclude files per source, and `episodeOverrides` pins season/episode numbers per file after everything else has been applied. In the management UI, open the entry's **Files** tab after inspecting: edit the season/episode boxes, use **Shift up / Shift down** to renumber a whole season at once, and save — rows that would land two files on one episode are highlighted and block saving, and gaps in a season are called out below the toolbar. **Restore automatic mapping** clears both kinds of override.
