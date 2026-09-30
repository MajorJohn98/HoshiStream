# Season and episode hints for multi-torrent series

Plan: [2026-09-28-series-season-episode-hints-plan.md](../plans/2026-09-28-series-season-episode-hints-plan.md)

## What changed

- **Episode hints.** Every torrent in a series — the main one and each extra
  — can now carry an Episode number next to its Season. A single-episode
  torrent whose file has no `SxxEyy` in its name becomes exactly that
  episode instead of colliding on E1; a pack continuing a season (episodes
  13–24 named `01`…`12`) is numbered upward from it.
- **Hints on the main source.** `seasonHint` / `episodeHint` are now entry
  fields for the primary torrent or series folder (nullable on `PATCH`).
  `extraSources[]` gain `episodeHint`, and `POST /api/imports/series-preview`
  accepts it.
- **Smarter filename numbering.** Explicit `S02 E05`, `S02.E05` and
  `Season 2 Episode 5` are now recognised alongside `S02E05` / `2x05`.
  Without explicit numbering, episodes are guessed from `Episode 5`, `Ep05`,
  `E05`, `Show - 05`, and leading `05 - Title` names, and the season from a
  `Season 2` / `S02` folder or token. Guessed episodes that repeat inside one
  torrent are ignored, so "12 Monkeys Pilot.mkv" does not become episode 12.
  Precedence: manual repair → explicit name → hints → guesses → position.
- **Sample folders.** Files in a `Sample/` folder are now treated as samples.
- **Editable sources.** The detail **Source** tab shows **Torrents and
  numbering**: the main torrent and every extra with editable Season /
  Episode and **Save**, plus remove and add. Series folders get the same
  numbering row. Add Media gains **Series numbering** for the main source and
  an Episode field on each additional torrent.
- **Chrome companion.** "Add to existing series" gains an **Episode hint**.
- TorrServer session labels read e.g. "Season 2 · Episode 5".

## Compatibility

Existing libraries load unchanged, and entries without hints keep their
source revision. Stored episode lists are not rewritten; the improved
filename parsing applies the next time a series is inspected, which can
renumber files that were previously mapped by position. Manual episode
repairs still win over everything.
