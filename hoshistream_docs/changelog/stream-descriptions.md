# Stream descriptions and web-readiness hints

Date: 2026-09-12 · Phase 14 of the
[playback, pointer, library and operations expansion plan](../plans/2026-09-12-playback-pointer-library-expansion-plan.md).

## What changed

- **Richer stream text.** `description` on every stream is now up to four
  plain-text lines built from the cached direct-play probe: `Torrent · 1080p ·
H.264 · E-AC3 · 4.5 GB`, then `6.2 Mbps average`, then any `Check player:`
  caveat, then the line-fit verdict. Unknown fields are skipped, so an
  un-probed file still reads `Torrent · 4.5 GB`. Resolution classes come from
  the probe's height (with width as a tie-breaker for letterboxed encodes);
  codecs use friendly names (`HEVC`, `E-AC3`, `TrueHD`) and fall back to the
  upper-cased ffprobe name.
- **Line-fit verdict on every stream.** `presentStreams` still lists what the
  line can carry first, but now appends `fits your line` or `above your line ·
needs 12.0 Mbps, line ~9 Mbps` as a final line whenever both the bitrate and
  a home speed test are known (previously only the heavy files were annotated,
  inline with `•`).
- **`behaviorHints.notWebReady`.** Set to `true` on the direct stream when the
  probe found HEVC/H.265, MPEG-4 ASP, VC-1, MPEG-2 video, DTS/DTS-HD/TrueHD/
  Blu-ray PCM audio, or an AVI container. Stremio Web then offers its
  external-player path instead of a black screen. Repaired `Compatible • …`
  streams never carry the flag.
- **`behaviorHints.videoHash`.** OpenSubtitles hash (size + Σ of the first and
  last 64 KiB as little-endian uint64, 16 hex digits) so Stremio's built-in
  subtitle matching works for viewers with a subtitle add-on. Computed only
  from files on local disk — local entries and complete disk copies whose
  drive is online — never by reading through TorrServer. Results are cached
  by path, size and mtime (512 entries); files under 128 KiB are skipped.

## Deviation from the plan

The plan's exit example reads `TrueHD 7.1 (eng)`. The stored probe summary
(`DirectPlay`) carries codec names only — no channel layout or language — so
those labels are not shown rather than guessed. Adding them means widening the
ffprobe summary, which is a separate change.

## Files

- `addon/src/streams.ts` — `describe`, `resolutionLabel`, `notWebReady`,
  `streamBehaviorHints(entryId, file, { directPlay, videoHash })`,
  `presentStreams` verdict line, `getStreams(..., volumes?)`.
- `addon/src/video-hash.ts` (new) — `hashChunks`, `openSubtitlesHash`,
  `clearVideoHashCache`.
- `addon/src/routes/protocol.ts` — passes the volume registry to `getStreams`.
- Tests: `addon/tests/streams.test.ts`, `addon/tests/video-hash.test.ts`.
- Docs: `api/addon-protocol.md` stream section.
