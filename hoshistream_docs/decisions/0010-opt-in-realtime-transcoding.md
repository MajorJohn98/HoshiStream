# 0010 — Opt-in real-time transcoding via vendored ffmpeg

Status: proposed
Date: 2026-08-23
Amends: the "no transcoding" non-goal stated in the MVP scope and
[architecture-overview.md](../architecture/architecture-overview.md)

## Context

HoshiStream was designed as a pure direct-play add-on: TorrServer serves torrent bytes,
the add-on serves local files with range support, and no video is ever re-encoded. That
kept the server out of the media path for torrents and kept the codebase small.

Real-world playback on the primary TV target (LG webOS) breaks that assumption in three
recurring ways:

1. **Container failures** — webOS refuses some MKV muxings even when the video codec is
   hardware-decodable.
2. **Audio failures** — DTS and TrueHD tracks play video with no sound on most LG TVs.
3. **Codec failures** — AV1 and 10-bit HEVC profiles on older TVs cannot be decoded at
   all.

The add-on already runs ffprobe (`media-probe.ts`) and can predict these failures, but it
can only warn — it has no remedy. Separately, remote clients over the Cloudflare Tunnel
(0.5.0) may lack the bandwidth for full-bitrate originals; a lower-bitrate rendition is
the only way those streams play at all.

ffmpeg with VideoToolbox hardware encoding on Apple Silicon makes real-time repair cheap:
remuxing is near-free, audio-only transcoding costs a fraction of one core, and even full
1080p video transcodes run at 5–10× realtime at ~15–30 % CPU.

## Decision

Add an **opt-in, tiered stream-repair pipeline** backed by a vendored, pinned ffmpeg
binary, defaulting to OFF and gated by the existing probe verdict:

- **Tier R (remux)** — `-c copy` container swap (MKV → fMP4/HLS). No re-encode.
- **Tier A (audio fix)** — video copy, audio transcoded (DTS/TrueHD → AC3 or AAC).
- **Tier V (video transcode)** — full re-encode via VideoToolbox (h264/hevc) into HLS,
  used only when the probe verdict says the client cannot direct-play the video, or when
  the user explicitly selects a lower-bitrate rendition for tunnel playback.

Rules:

1. Direct play remains the default and preferred path. A repair tier is chosen only when
   the probe verdict predicts failure for the requesting client class, or the user forces
   it per entry.
2. ffmpeg is vendored and pinned through `packaging/` lockfiles exactly like TorrServer
   (`darwin-arm64`, `win32-x64`); the system ffmpeg is never used.
3. ffmpeg reads torrent input from TorrServer's local HTTP URL (`127.0.0.1`), so
   TorrServer's piece prioritization continues to drive the download. The add-on never
   implements BitTorrent logic.
4. Output is HLS segments in `<state dir>/transcode/<session>/`, served by the add-on
   with token-gated routes. Sessions are bounded: one ffmpeg process per active stream,
   idle-killed when segment requests stop, segments deleted on session end and at
   startup.
5. Software (libx264) fallback is out of scope; if hardware encoding is unavailable the
   add-on falls back to direct play with a warning, never to a CPU-saturating encode.
6. No always-on background pre-transcoding; everything is on-demand per playback session.

## Consequences

- The add-on enters the torrent media path for repaired streams only. Direct-play
  entries are untouched, preserving ADR 0005/0007 URL behavior for them.
- First mutable temp state appears under the state dir; startup must sweep orphaned
  session directories.
- Seeking within a repaired stream restarts ffmpeg with `-ss`; a seek costs a few
  seconds. This is accepted; session-restart logic is the bulk of the implementation.
- A new vendored runtime (~25 MB per platform) joins the packaging lockfiles.
- The "no transcoding" non-goal is narrowed to: *no transcoding when direct play works,
  no background/batch transcoding, no software video encoding.*
- webOS HLS/fMP4 quirks (HEVC in particular) require on-device validation before the
  feature leaves the default-off state.

## Alternatives considered

- **Stay direct-play-only** — leaves known-unplayable media unplayable on the primary TV
  target; probe can warn but not fix.
- **Pre-transcode library entries to a compatible format** — doubles disk usage, adds
  batch job management, and violates local-first simplicity more than on-demand repair.
- **libmpv/custom player on the TV** — not possible; webOS clients are third-party
  Stremio builds we do not control.
- **Full Jellyfin-style adaptive bitrate ladder** — rejected as scope creep; one
  rendition per session, chosen at start, is sufficient for a single-user system.
