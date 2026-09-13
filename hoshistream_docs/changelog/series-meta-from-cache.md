# Series meta from the cache, background refill after source edits

Date: 2026-09-13. Follows [ADR 0006](../decisions/0006-inspection-cache-on-entries.md)
and [ADR 0025](../decisions/0025-watched-state-from-observed-reads.md).

## Symptoms

- Opening a series in Stremio (desktop and TV) after any episode had been
  started showed a single stream for one episode instead of the episode list.
- Adding a second (third, …) season's magnet link to a series and then opening
  it in Stremio hung and timed out: the meta request was inspecting every
  source in turn, each with a 30-second metadata deadline.

## Changes

- **No `defaultVideoId` on series `meta`.** Stremio reads that hint on a meta
  as "one video" and replaces the episode list with that video's stream picker.
  The hint stays on Continue Watching catalog rows, where it deep-links to the
  resume episode. (`metadata.ts`)
- **Cached series `meta` never waits on TorrServer.** With an inspection cache
  the episode list is built from the cache alone; re-registering the torrents
  in case TorrServer dropped them moves to the background, as movies already
  did. (`metadata.ts`)
- **Source edits refill the cache in the background.** `PATCH /api/library/:id`
  that changes the source definition (extra sources, file overrides, magnet,
  …) still drops the cache, then starts the inspection immediately instead of
  waiting for the user to click Inspect or for Stremio to ask.
  (`routes/library-api.ts`, `warmStreamSource`)
- **One inspection per entry and source revision.** `sharedInspection` in
  `inspection.ts` dedupes concurrent full inspections: Stremio's meta and
  stream requests, the Inspect button and the post-edit warm-up all join the
  same run. Keyed by the source-definition revision so an edit made mid-run
  starts its own inspection rather than joining one the cache guard will
  reject.
- The Additional torrents panel now says "episodes are refreshing in the
  background" rather than asking for a manual inspection.

## Not changed

- A source whose metadata never arrives still fails the whole inspection after
  its 30-second deadline, so a dead extra torrent leaves the series without a
  cache. Skipping such a source (a partial cache) is a possible follow-up.
- The first-ever inspection of a series added without a post-save check still
  runs inside the first Stremio request that needs it.

## Tests

- `inspection.test.ts`: cached series meta answers while `torrServer.get`
  hangs; series with history keeps its full episode list; a warm-up, a meta
  request and an explicit `sharedInspection` call register the torrent once.
- `library.test.ts`: `PATCH` adding an extra source leaves a two-source cache
  behind without any further call.
