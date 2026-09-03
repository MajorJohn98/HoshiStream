# UI Redesign Plan — Cinema Shelf + Live Sidebar

**Date:** 2026-09-03
**Status:** Approved direction (concept A); implemented alongside this plan

## Experience Model

One user, three moods, one screen budget:

| Mood | Goal | Today | Redesign |
| --- | --- | --- | --- |
| Viewer | Resume/play something in seconds | Hero + grid (works) | Keep; sharpen hierarchy |
| Curator | Add a torrent and make it playable | Separate Add page, 5-tab admin modal | Keep Add view; detail becomes a media page with progressive disclosure |
| Caretaker | "Is everything OK? What's happening?" | Fragmented across Status, Devices, Stream Repair, Storage | One **System** page + an always-visible **live sidebar HUD** |

**Core loop (caretaker):** glance sidebar → see health dot / copy progress / drive warning → click through to the one relevant System section → act → sidebar reflects the result. No hunting.

## Problems Being Fixed

1. Six equally-weighted nav items (anti-pattern: equally weighted dashboards).
2. Background work is invisible: archive progress only exists on the Storage
   page; playback on Devices; repair on Stream Repair.
3. Problems never surface: offline drive, invalid files, stale pointer all
   require visiting the right page.
4. The detail modal buries Play among five admin tabs.

## New Structure

### Shell: left sidebar (collapses to top bar on narrow screens)

- Brand, search, and three destinations: **Library**, **Add Media**, **System**.
- **Live HUD** (bottom of sidebar), fed by a shared polling hub in the store:
  - Health dot (TorrServer + server) → links to System.
  - "Streaming now" row when playback is active.
  - Per-entry archive mini progress bars (copying/queued/waiting reasons).
  - Drive warning row when a volume with kept entries is offline/ambiguous.
  - Repair session count when transcoding.
- HUD rows are links into the matching System section — state is always one
  glance away, and always actionable.

### Library (home)

Unchanged in structure (hero + poster grid + filters); restyled. Disk badge
on cards for entries kept on disk.

### System (merges Status + Devices + Stream Repair + Storage)

Single scrollable page of card sections with anchors:
`#/system/health`, `#/system/storage`, `#/system/devices`, `#/system/repair`.
The four old views become exported card components composed here; old hash
routes redirect.

### Entry page (replaces the 5-tab modal)

Full-screen overlay sheet: backdrop hero (poster, badges, primary **Play**,
Watch in browser), then stacked sections with sticky chips — Details,
Storage, Sources, Files, Playback check. Existing tab components are reused
as section bodies; only the frame changes. Escape/backdrop click closes.

## Implementation Notes

- Static ESM + preact/htm, CSP `'self'` — no build step, no new dependencies.
- `store.js` gains one visibility-aware polling hub (status 10 s, disk-jobs
  3 s, playback 6 s, volumes 12 s) shared by HUD and System cards, replacing
  per-view duplicated pollers where practical.
- Component class names are kept (`panel`, `metrics`, `files`, `form-grid`,
  badges, pills, grid/cards) so all views survive the restyle; layout classes
  (`bar*`) are replaced by `sidebar`/`hud`/`app-layout`.
- `styles.css` rewritten around design tokens (type scale, spacing, radius,
  surface levels) with the same dark cinematic direction.

## Out of Scope

- The in-browser player logic (restyle only).
- New backend endpoints — the redesign is a pure client change.
