# Main torrent handling and Activity torrent groups

Plan: [2026-09-28-main-torrent-and-activity-groups-plan.md](../plans/2026-09-28-main-torrent-and-activity-groups-plan.md)

- **Make main.** Source tab → each additional torrent has **Make main**,
  swapping it with the main torrent (`POST /api/library/{id}/sources/promote`).
  Watched state, resume position, episode repairs and file facts follow
  their files; the episode list refreshes in the background.
- **Watched state survives source edits.** Removing or reordering extra
  torrents re-homes their file ids instead of leaving watched state on the
  wrong files. Replacing the main magnet forgets only the main torrent's
  episodes, not every episode of the series.
- **Main torrent label.** Activity labels the main torrent like the extras —
  its season/episode (`Season 1 · Episode 1`), else "Main torrent" when the
  series has other torrents.
- **Grouped Activity.** Torrents are split into collapsible **Streaming**,
  **Checking**, **Copying to disk** (only while archiving) and **Idle**
  (collapsed by default) groups with counts and a combined download rate;
  each group remembers whether you left it open. Rates below 1 MB/s now
  read in KB/s instead of "0 MB/s".
