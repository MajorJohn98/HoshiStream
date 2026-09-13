# Entry health card plan

**Date:** 2026-09-13
**Status:** Proposed — awaiting review before implementation
**Scope:** `addon/assets/manage/views/detail.js` (OverviewTab), `addon/assets/manage/styles.css`, tests. No server or API changes.

## Why

A design critique of the entry sheet (`.impeccable/critique/2026-09-13T15-07-22Z__addon-assets-manage-views-detail-js.md`, 22/40) found that opening a title lands the owner on a generic edit form — Title, Type, Description, Poster URL, Background URL — before anything that matters about the title. For a personal playback tool the first question is *"Can I watch this, and is it healthy?"* That information already exists in the entry (`sourceCheck`, `inspectionCache`, `diskCopy`, `playback`) but is spread across the Source, Files, Playback check and Keep on disk tabs.

This plan implements the top-ranked fix only: a **health card** at the top of the Details tab, with the edit form demoted behind an **Edit details** disclosure. Tab consolidation, the "Sample read" rename, and a sticky save footer remain in the critique backlog and are out of scope.

## Goals

1. The first viewport of the Details tab answers: source kind, what will play, when it was last inspected, the source-check verdict *with its caveat*, disk state, and one next action.
2. The metadata form stays fully functional but is collapsed by default once a title is set up.
3. No new dependencies, no new API calls, no layout change to the hero or tab strip.

## Non-goals

- Changing `SECTIONS` or tab labels.
- Renaming source-check badge labels or tones (`components/source-check.js`).
- Moving Save into a sticky footer or adding an unsaved-changes guard.
- Any server-side change.

## Design

### Health card (`EntryHealthCard`)

Rendered inside `OverviewTab` above the form, inside the existing `Section`. A single bordered panel using the sheet's surface tokens (same family as `.kv`), laid out as a compact definition grid on desktop and stacked rows under the existing `≤ 720px` breakpoint.

Rows, derived purely from `state.selected` (all helpers already exist in `detail.js` / `source-check.js`):

| Row | Source of truth | Copy |
|---|---|---|
| Source | `magnetUri` / `torrentFilePath` / `localFilePath` / `localFolderPath` | Same `kind` string as SourceTab ("Authorized magnet link", "Linked local file", …) |
| Will play | movie: file chosen by `pickSourceCheckFileId` or `selectedFiles[0]`; series: `entry.playback` episode if resuming, else "N episodes mapped" / "Episodes not mapped" | File name or `S2E4 · name`; falls back to "No file selected yet" |
| Last inspected | `inspectionCache.inspectedAt` via `agoLabel` | "3 days ago · 24 files selected" or "Never inspected" |
| Source check | `sourceCheckBadge(entry.sourceCheck)` | Existing dot + label, **plus** a muted one-liner: "A sample decoding is not a guarantee of full playback." shown when tone is `ok` |
| Local copy | `diskBadge(entry)` / `diskCopy.desired` | "On disk ✓", "Disk 3/10", or "Streaming only" |

**Next action** (one `secondary` button, right-aligned on desktop). First match wins:

1. `inspectionCache` missing → **Inspect source** (`setState({ tab: "source" })`, focus Inspect)
2. series with unmapped episodes → **Map episodes** (`tab: "episodes"`)
3. `sourceCheck` unchecked / failed / interrupted → **Run playback check** (`tab: "playback"`)
4. otherwise → no button; the hero's Resume / Watch now already covers it

The card never duplicates the primary Play action.

### Edit details disclosure

The existing `<form class="form-grid">` is wrapped in a native `<details class="edit-details">` with `<summary>Edit details</summary>` (same primitive already used by `.setup-url` in welcome/pointer views).

Open by default when the entry is not yet set up: no `poster` **or** no `description`. Otherwise closed. The open/closed state is not persisted; it is recomputed per entry (`key=${entry.id}`), matching the form's existing reset behaviour.

`Section` note changes from "Title, artwork, description, and tags as Stremio sees them." to "How this title looks and plays. Expand Edit details to change what Stremio sees." Save row and the "Changes apply to Stremio on its next catalog refresh." note are unchanged.

### Styling

New rules in `styles.css`, next to `.kv`:

- `.health-card` — bordered surface, `grid-template-columns: repeat(auto-fit, minmax(160px, 1fr))`, gap from existing spacing tokens.
- `.health-card dt / dd` — mirror `.kv` typography so the card reads as one family with the Source tab.
- `.health-card .caveat` — reuse `.inline-note` styling.
- `details.edit-details > summary` — styled as a text button with the accent chevron; `:focus-visible` uses the global ring (do not suppress it).
- Reduced-motion safe: no animation on open/close.

## Implementation steps

1. Extract `kind` computation from `SourceTab` into a small `sourceKind(entry)` helper so both tabs share it.
2. Add `EntryHealthCard({ entry })` above `OverviewTab`'s form; compute rows + next action.
3. Wrap the form in `<details class="edit-details" open=${needsSetup}>`.
4. Add CSS.
5. Tests (`addon/tests/`): the manage UI has no component test harness, so cover the pure helpers only — `sourceKind`, next-action selection, and the "needs setup" predicate — by exporting them from a new `addon/assets/manage/entry-health.js` module (plain functions, no Preact) and importing them in `detail.js`. Follow the pattern of `playback-attempt.js` / `magnet-link.js`, which are already unit-tested this way.
6. Manual check in the browser: movie with sample read, series with unmapped episodes, local file never inspected, entry with no poster (form should be open).
7. Run `npm run typecheck && npm test && npm run lint && npm run format:check` from `addon/`.
8. Add a changelog entry and link this plan from `hoshistream_docs/index.md`.

## Open questions for review

- Should the disclosure remember its state per session (sessionStorage), or is recompute-per-entry acceptable? Plan assumes recompute.
- Is "Streaming only" the right label for no disk copy, or should it be blank to reduce noise?
- Should the caveat under a green source check appear always, or only on first open? Plan assumes always — it is the point of the critique finding.
