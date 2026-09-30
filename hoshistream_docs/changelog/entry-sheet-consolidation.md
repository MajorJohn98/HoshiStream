# Entry sheet: seven tabs consolidated into five

Plan: [2026-09-28-entry-sheet-consolidation-plan.md](../plans/2026-09-28-entry-sheet-consolidation-plan.md)

The entry sheet had overlapping tabs, duplicate lists and repeated actions.
It now separates four concerns — how the title is presented, where the media
comes from, whether it plays, and where copies are kept:

| Before | After |
| --- | --- |
| Details, Metadata | **Details** — one form, one **Save details**; the optional extras (year, runtime, rating, people, logo, awards, trailers, poster shape) sit behind **More details**, whose summary counts filled fields. **Ongoing series** moved here. |
| Files (read-only list with watch/play), Episodes | **Episodes** (series) — one row per episode with title, overview, air date, **Watched** toggle and play. The frame column appears only once a frame exists or can be made. |
| Source, Files (mapping) | **Source** — kind and location, **Change magnet link** (moved from Details), torrents and numbering, then **Files** with the single **Inspect** entry point and the mapping editor. Movies keep watch/play on their file row here. |
| Playback check | **Playback** — the check, **Open direct stream** as the section action, one short path note. The duplicate "Play this file" button is gone (the hero's Play covers it). |
| Keep on disk | **Storage** — unchanged content; the one-word label matches the Storage page and lets five tabs fit a phone. |

Also removed: the duplicate source-check row and "Last inspected" row on
Source (the header badge and the Files note carry them), and the second and
third Inspect buttons. Old `metadata` / `files` tab deep links land on
Details / Source.

## Fixes

- Saving Details no longer drops the inspection cache, direct-play verdict
  and media facts. The form sends every field, and the server treated any
  present source field (`type`, `magnetUri`, …) as a change; it now
  invalidates only when a value actually changed.
- Watch toggles are `type="button"`, so marking an episode watched never
  submits the episode-details form.
