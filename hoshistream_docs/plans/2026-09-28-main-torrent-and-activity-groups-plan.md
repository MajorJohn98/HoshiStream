# 2026-09-28 — Main torrent handling and Activity torrent groups

Status: implemented. Changelog: [main-torrent-and-activity-groups.md](../changelog/main-torrent-and-activity-groups.md)

## Problem

- The main torrent was unlabeled on Activity while extras showed their
  season, so a series of single-episode torrents had one anonymous row.
- The main torrent could not be removed or demoted, only replaced — and
  replacing it cleared the watched state of every episode, extras included.
- Composite file ids encode source position (`index × 100000 + id`), so
  removing an earlier extra shifted later extras' ids and left their watched
  state, resume position and episode repairs pointing at the wrong files.
- Activity listed every torrent in one flat list; a multi-torrent series
  loads all its torrents when one episode plays, which clutters it.

## Design

- `remapFileId(id, sourceMap)` and `remapSourceFileState(entry, sourceMap)`
  move `watchStates`, `playback.fileId`, `episodeOverrides` and
  `mediaFacts` when sources move; state of a removed source is dropped.
- `Library.patch` builds the map from the edit (extras matched by locator;
  a replaced primary maps to nothing) and applies it instead of wiping all
  watch states.
- `Library.promoteSource(id, index)` swaps the primary source fields with
  extra `index`, remaps state, and drops the inspection cache, direct-play
  verdict and source check (source order decides which torrent wins a
  shared episode). `POST /api/library/{id}/sources/promote` cancels
  in-flight checks and refills in the background. Refused when
  `preferredFileIndex` is pinned (it only applies to the main torrent).
- Activity labels the main torrent by its hints, else "Main torrent" when
  extras exist.
- Activity groups: Streaming, Checking, Copying to disk (only while
  archiving), Idle (collapsed by default), as `<details>` whose state
  persists in `localStorage`. Rates use a KB/s-aware formatter.
