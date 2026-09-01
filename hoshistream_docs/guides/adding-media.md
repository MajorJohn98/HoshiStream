# Adding Media

Use only media you own, public-domain media, or media you are authorized to access. HoshiStream provides no torrent search, index scraping, source lists, or bundled magnet links.

## Management page (recommended)

Open the token-gated page locally:

```text
http://127.0.0.1:7000/manage/<ACCESS_TOKEN>
```

From there you can add magnet links, upload `.torrent` files, pick local files (native Finder picker with the menu-bar app, or browser upload fallback), edit metadata and posters, inspect entries, and probe technical details.

### Multi-torrent series

One series entry can be backed by several torrents — season packs, single
episodes, or a mix:

- **Add Media** (magnet source): use **+ Add another torrent** to attach
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

Inspection may take up to 30 seconds while TorrServer fetches metadata; file IDs are TorrServer's one-based IDs. Add `?probe=true` to inspection to read resolution, codecs, duration, and average bitrate, and get a recommended speed with 50% headroom. Set `HOME_SPEED_MBPS` in `.env` to your measured connection speed for the viability verdict.

If automatic file selection is wrong, set `preferredFileIndex` to an inspected playable file ID. For series, `fileOverrides` can include/exclude files and pin season/episode numbers.
