# 0015 — Keep atomic JSON stores; SQLite deferred

Status: accepted (2026-09-04).

## Context

HoshiStream persists everything as small JSON files written atomically
(temp file + rename, `0600`): `library.json`, `tags.json`, `volumes.json`,
`disk-cleanup.json`, `disk-schedule.json`, `device-names.json`. Reads are
served from an in-memory copy invalidated by `stat()` mtime; every mutation
rewrites the whole file. The working agreement says "no database".

With tags added (0.13.0) the question was raised whether SQLite would now be
worthwhile. `node:sqlite` (`DatabaseSync`) ships in the Node 22+/26 runtime, so
it would cost no dependency.

Measured on a real library (28 entries): `library.json` is 345 KB, of which
78 % is `inspectionCache` (923 cached torrent file records) and 8 % each
posters and magnets. The chatty writers (playback position, last-streamed)
are throttled to 15 s and 3 min.

## Options

1. **Keep JSON** (status quo).
2. **SQLite, normalized** — ~8 tables for entries, files, overrides, sources,
   disk copies, tags. Real relational queries and cross-store transactions;
   requires explicit export/import, backups, and schema migrations, and a
   rewrite of `library.ts` plus its ~15 dependent test files.
3. **SQLite, JSON blobs** — one row per entry holding the document. Pays the
   migration/backup/export cost while gaining almost none of the query
   benefits.

## Decision

Option 1. The JSON design is well inside its comfort zone and its properties
are features, not accidents: the library is a file the user can read, diff,
back up, hand-edit, import/export, and that recovers itself from corruption
(`.corrupt-<ts>` quarantine, `.bak` restore). Zod already validates the
document schema at every boundary.

The one real pressure point — rewrite amplification from a large derived
`inspectionCache` — is addressed without a database if it ever bites: split
the cache into a sibling file keyed by entry id (shrinking `library.json` by
~80 % and cleaning up exports), and/or debounce `Library.update()` to coalesce
bursts.

## Revisit when

- Libraries routinely exceed ~1–2k entries, or
- a feature needs relational queries (per-device watch history, per-episode
  progress across many series, full-text search), or
- two processes must share the state directory concurrently (today the menu-bar
  app and the terminal server cannot, because they share ports).

If that point is reached, `node:sqlite` is the tool: no dependency, and its
synchronous API fits `Library`'s serialized queue. Migration is a one-time
import of `library.json`; JSON export stays as the portability format. A tag
rename currently spans two files (`tags.json`, then `library.json`) and is not
atomic across them; this is accepted as low-impact and self-healing (the entry
sheet still shows and saves the old name, which re-registers it).
