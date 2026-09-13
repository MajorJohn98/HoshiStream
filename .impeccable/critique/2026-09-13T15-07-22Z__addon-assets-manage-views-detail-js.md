---
target: manage detail sheet
total_score: 22
max_score: 40
na_heuristics: 
p0_count: 0
p1_count: 3
timestamp: 2026-09-13T15-07-22Z
slug: addon-assets-manage-views-detail-js
---
# Critique: manage detail sheet (addon/assets/manage/views/detail.js)

Method: dual-agent (A: 1814191c · B: 8ff7c1f0). Browser inspection skipped: manage URL embeds the access token.

## Design Health Score — 22/40

| # | Heuristic | Score | Key Issue |
|---|---|---|---|
| 1 | Visibility of System Status | 2 | Save is below the fold; feedback is a transient toast only |
| 2 | Match System / Real World | 2 | "Sample read" is jargon and over-reassures (green) |
| 3 | User Control and Freedom | 2 | No unsaved-changes guard on close/Escape/backdrop |
| 4 | Consistency and Standards | 3 | Good tablist/dialog semantics; 7-tab editor strains modal convention |
| 5 | Error Prevention | 2 | Disk deletion uses native confirm() |
| 6 | Recognition vs Recall | 2 | Details vs Metadata indistinguishable; verb-tabs |
| 7 | Flexibility & Efficiency | 3 | Resume + arrow keys good; no glanceable health summary |
| 8 | Aesthetic & Minimalist | 2 | First screen is URL plumbing, not what matters about the title |
| 9 | Error Recovery | 2 | Generic notify(error.message), vanishes |
| 10 | Help & Documentation | 2 | Good inline notes but scattered |

## Design specificity
Hero (poster/title/status/Play) and the source-check / keep-on-disk vocabulary are genuinely HoshiStream. The body of the first tab is generic CMS edit form — Title/Type/Description/Poster URL/Background URL — and could belong to any admin.

## Priority issues
- P1 7-tab flat IA (detail.js SECTIONS ~1760). Collapse to Overview · Source & files · Playback · Storage; fold Metadata into Overview as an advanced section.
- P1 First screen optimizes metadata editing, not "can I watch this / is it healthy". Add a health summary card above the form (source kind, selected file, last inspected, sample verdict, disk state).
- P1 "Sample read" green badge (source-check.js:106) implies playable; caveat lives deeper (134-138). Rename and demote colour.
- P2 Save affordance below fold, toast-only feedback, no dirty guard (detail.js:220-224, api.js notify). Sticky action footer with Saved/Unsaved state.
- P2 Consequential multi-tab editor (incl. file deletion) as dismissible modal. Either route it as a page or add focus trap + unsaved guard.

## Minor
- Tab focus removes global ring, underline-only (styles.css ~1745)
- Poster placeholder ★ generic; close button gets initial focus (dismiss-first)
- Magnet privacy note far from magnet textarea
- Tab strip becomes horizontal overflow scroller on narrow screens
- Detector: 0 findings, but ran in regex-fallback mode (htmlparser2 missing) — undercount.

## Questions
1. Should detail open on a "Can I watch this?" card rather than the edit form?
2. Three owner intentions — Watch / Fix source / Keep locally — instead of seven admin buckets?
3. Is "Sample read" the promise you want users to trust before pressing play?
