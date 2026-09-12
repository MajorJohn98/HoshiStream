# Subtitle sidecars

Implements Phase 6 of the
[playback, pointer and library expansion plan](../plans/2026-09-12-playback-pointer-library-expansion-plan.md):
subtitle files that already sit next to a video — in the torrent or in a
disk-copy folder — are offered to Nuvio and to the browser player. Nothing is
downloaded from subtitle providers; there is no search and no new dependency.

## What changed

- **Manifest** now declares the `subtitles` resource next to `catalog`,
  `meta` and `stream`. The stremio-addon-sdk builder requires a handler for
  every declared resource, so `createAddon` defines one, but the protocol
  route in `routes/protocol.ts` intercepts `subtitles` before `addon.get`
  (like `stream`) so the returned URLs use the origin the client reached us
  on.
- **`src/subtitles.ts`** (pure, no I/O):
  - `isSubtitlePath` / `subtitleFormat` recognise `.srt`, `.vtt`, `.ass`,
    `.ssa`.
  - `matchSubtitles(video, files, { soleVideo })` pairs sidecars with a video
    by stem: exact stem, or stem + separator + only language / flag tokens
    (`Movie.en.srt`, `Movie.eng.forced.srt`, `Subs/Movie.de.vtt`). A prefix
    is never swallowed (`Movie.en.srt` does not match `Movie 2.mkv`). For a
    movie with a single video file every sidecar in the torrent is claimed,
    because release groups often name them by language alone. `hi` means
    Hindi unless another language token is present, then SDH.
  - `subtitleLanguage` maps ISO 639-1/639-2 codes and English names to the
    639-2/B codes Stremio expects (`eng`, `ger`, `fre`, `rus`, …).
  - `decodeSubtitleBytes` honours BOMs, tries strict UTF-8, then falls back to
    windows-1251 for Cyrillic languages and windows-1252 otherwise.
  - `srtToVtt` is a string transform: strips counters and `X1:` positioning,
    normalises `HH:MM:SS,mmm` (also `.` separators and missing hours) to
    `HH:MM:SS.mmm`, drops cues with malformed or backwards timing or minutes
    / seconds ≥ 60, removes `{\an8}` override tags, and passes WEBVTT input
    through unchanged.
- **`src/subtitle-service.ts`** — `SubtitleService.list(type, id, addonUrl,
  token)` resolves the same video the `stream` resource would serve (via
  `requestedFile`) and lists matching sidecars from the torrent `file_stats`
  (`POST /torrents {action:"get"}`, already used) or from disk;
  `fetch(entryId, key, ext)` reads the sidecar whole-file from
  `GET /play/{hash}/{id}` (20 s timeout) or the disk path, converts SRT to
  WebVTT, and caches the bytes for 1 h (bounded entry count, oldest evicted).
  Files above 10 MiB are refused. Disk reads re-check containment with
  `realpath`, so a symlink pointing outside the folder is neither listed nor
  served.
- **Routes**:
  - `GET /addon/<token>/subtitles/<type>/<id>[/<extra>].json` → no-store
    `{ subtitles: [{ id, url, lang, label }] }`.
  - `GET|HEAD /subtitles/<token>/<entry>/<key>.(vtt|ass|ssa)` → the sidecar
    with `content-type`, `content-length`, `cache-control: max-age=3600`,
    `access-control-allow-origin: *` and `nosniff`. Keys are
    `<infohash>:<fileId>` for torrents and `l:<base64url(relative path)>` for
    disk files; anything else is a 404 from the dispatcher. Unknown entry or
    file → 404; source unreadable → 502 `{ error: "Subtitle source unavailable" }`.
- **Browser player** fetches the subtitles list for the entry (movie id or
  `id:season:episode`) and renders `<track kind="subtitles">` elements for
  the WebVTT entries; ASS/SSA are left to Stremio clients with their own
  renderer.
- **Devices view** labels the new resource `Listed subtitles`.

## Not changed

- No subtitle providers, OpenSubtitles hashes, or downloads (ADR 0020 spirit:
  media stays manual).
- No new runtime dependency; SRT → VTT is a string transform.
- Embedded subtitle tracks (inside MKV) are untouched — the player already
  handles those.

## Tests

- `tests/subtitles.test.ts` — detection, matching rules (stems, language and
  flag suffixes, sole-video claim, series episodes, Hindi vs SDH), `srtToVtt`
  incl. malformed timestamps, and byte decoding.
- `tests/subtitle-service.test.ts` — fake TorrServer: listing, fetch, 1 h
  cache, eviction, upstream errors; disk folders: listing, fetch, and refusal
  of symlinks that escape the folder.
- `tests/subtitle-routes.test.ts` — protocol JSON (no-store, requested
  origin, extra segment, token), file route headers, HEAD, key shapes, 404 /
  502.
- `tests/player-subtitles-ui.test.ts` — `protocolId` and `sidecarTracks`.
- `tests/manifest.test.ts` — updated resource list.
