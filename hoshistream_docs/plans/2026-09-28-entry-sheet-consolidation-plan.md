# 2026-09-28 — Entry sheet consolidation

Status: implemented. Changelog: [entry-sheet-consolidation.md](../changelog/entry-sheet-consolidation.md)

## Problem

Seven tabs (Details, Metadata, Source, Files, Episodes, Playback check, Keep
on disk) with overlap: two forms and two Saves for one presentation concern;
the same episode list twice with season sub-tabs; three Inspect buttons; the
source-check status in three places; the magnet link edited under Details;
"Play this file" duplicating the hero's Play.

## Decision

Keep four real separations — presentation, source plumbing, diagnostics,
storage — and fold everything else into them:

1. **Details**: Cinemeta match, essentials, Ongoing (series), "More details"
   disclosure for the optional fields. One PATCH (`metadataPatch` merged in).
2. **Episodes** (series): per-episode presentation plus Watched and play.
3. **Source**: summary, magnet editor (disclosure), torrents and numbering,
   Files section (cached list or mapping editor; the only Inspect).
4. **Playback**: source check, direct stream, stream-repair toggle.
5. **Storage**: the disk copy, unchanged.

`TAB_ALIASES` maps retired keys (`metadata`, `files`) to their new homes.

## Validation

Management-asset tests pin the tab list and aliases. A throwaway server
(temp `HOME`, stub TorrServer) verified every tab at desktop and 390 px: no
horizontal overflow except intentional data-table scrolling on phones, five
tabs fit without scrolling, and the Details, watch-toggle and magnet saves
persist correctly.
