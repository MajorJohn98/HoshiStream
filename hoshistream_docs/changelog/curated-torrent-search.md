# Curated torrent search

Date: 2026-09-05

The first search release adds an opt-in **Search** source inside **Add Media**.
Search, review, and save remain separate actions. Manual sources and saved-library
search in HoshiStream/Nuvio are unchanged. Prowlarr, Jackett, private trackers,
and attaching search results to existing series remain deferred.

Enable with `TORRENT_SEARCH_ENABLED=true` in the host `.env`, then restart.
The native supervisor forwards the flag; default is false.

## Behavior

- Title/creator matching against three reviewed open films, with explicit live
  metadata checks, license evidence, and safe source links.
- Review name/type/tags before adding; cancellable search, retained edits when
  refreshing a source, honest saved/uninspected feedback, and keyboard navigation.
- Only torrent metadata is retrieved during Add. Inspection uses existing
  TorrServer methods later, selecting the reviewed film path and size rather
  than the largest video in the bundle. Explicit file overrides still win.
- Pinned full-torrent SHA-256, canonical v1 metadata validation in an isolated
  bounded worker, public-IPv4 Archive HTTPS retrieval, redirect/byte/time limits.
- Atomic managed torrent storage, serialized hash deduplication, durable retry
  receipts, and cleanup of marked abandoned imports.
- JSON export strips server-owned provenance/receipts and warns that local
  torrent files are not embedded. Back up `library.json` and managed media together.

## Development-mode correction

Node's `--watch` loader can send `watch:import`
notifications through a worker's message channel before its parser result.
The validation worker now clears the inherited `WATCH_REPORT_DEPENDENCIES`
flag so those notifications cannot be mistaken for invalid torrent metadata.
The native runner still watches `src/`, including worker source changes.
This fixes the misleading "malformed, private, or unsupported" error on valid
catalog torrents when running `npm run dev:native`.

## Torrent upload response correction

Playback follow-up: the pinned TorrServer `/torrent/upload` endpoint returns
a single status object. The client previously expected an array, causing
inspection and stream lookup to fail even after TorrServer accepted the upload.
The client now follows the running build's Swagger contract. The browser player
also distinguishes failed stream requests from a codec/decoding failure.

## Catalog evidence

Metadata and source declarations were reviewed on 2026-09-05. Torrent files were
fetched as metadata only and pins rechecked. No movie payloads were downloaded;
seed availability, payload integrity, and playback are not guaranteed by this
review. Pins and exact payload sizes live in `addon/src/search/catalog.ts`.

| Film | Official rights evidence | Archive item | Reviewed film inside torrent |
|---|---|---|---|
| Big Buck Bunny | [Blender Foundation, CC BY 3.0](https://peach.blender.org/about/) | [BigBuckBunny_124](https://archive.org/details/BigBuckBunny_124) | `Content/big_buck_bunny_720p_surround.avi` |
| Sintel | [Blender Foundation, CC BY 3.0](https://durian.blender.org/sharing/) | [Sintel](https://archive.org/details/Sintel) | `sintel-2048-surround.mp4` |
| Elephants Dream | [Orange/Blender, CC BY 2.5](https://orange.blender.org/blog/creative-commons-license-2/) | [ElephantsDream](https://archive.org/details/ElephantsDream) | `ed_hd.avi` |

Big Buck Bunny's [official downloads](https://peach.blender.org/download/) and
[distribution listing](https://download.blender.org/peach/bigbuckbunny_movies/)
match the reviewed filename; the Archive item's accompanying license agrees.
Sintel's [official downloads](https://durian.blender.org/download/) name the
reviewed film file. Its larger documentary must not become the default film.
Elephants Dream's [official download page](https://orange.blender.org/download/)
links the exact Archive item. Use its official CC BY 2.5 grant, not Archive's
conflicting license tag.

These are bundles, not necessarily one-video torrents. Elephants Dream contains
large source assets; catalog size labels mean total torrent size, not selected
video size. Retain attribution and the films' credits. The evidence does not
extend film licensing to arbitrary separately distributed soundtrack releases.

To update a pin, review primary rights evidence, Archive inventory, the exact
torrent bytes and film path/size, and verify canonical metadata identity again.
Never automatically accept changed bytes or expand the catalog from uploader
license tags alone. See [ADR 0016](../decisions/0016-opt-in-curated-torrent-search.md).
