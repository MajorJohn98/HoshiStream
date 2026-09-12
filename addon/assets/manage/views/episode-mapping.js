// Pure helpers behind the series mapping editor: build editable rows from an
// inspection, shift episode numbers, spot duplicates and gaps, and turn the
// rows back into a library PATCH. No DOM access so the logic is testable.

// Composite file ids encode the owning source (see media-file-selection.ts).
const SOURCE_STRIDE = 100_000;

export function sourceIndexOf(id) {
  return Math.floor(id / SOURCE_STRIDE);
}

export function rawIdOf(id) {
  return id % SOURCE_STRIDE;
}

// One row per file in the listing. Inclusion comes from the saved include
// override, else from whether the file is currently selected; season/episode
// come from the current selection (which already has every override applied),
// falling back to the listing order for excluded files.
export function mappingRows(files, selectedFiles, fileOverrides = []) {
  const overrides = new Map(fileOverrides.map((x) => [x.id, x]));
  const selected = new Map(selectedFiles.map((x) => [x.id, x]));
  return files.map((file, index) => {
    const override = overrides.get(file.id);
    const current = selected.get(file.id);
    return {
      id: file.id,
      path: file.path,
      length: file.length,
      included: override?.included ?? Boolean(current),
      season: current?.season ?? override?.season ?? 1,
      episode: current?.episode ?? override?.episode ?? index + 1,
    };
  });
}

// Shifts the episode number of every included row that passes `matches` by
// `by`. Returns null when any result would fall below 1 so the caller can
// refuse instead of producing an invalid mapping.
export function shiftEpisodes(rows, by, matches = () => true) {
  if (!Number.isInteger(by) || by === 0) return rows;
  const next = rows.map((row) =>
    row.included && matches(row) ? { ...row, episode: row.episode + by } : row,
  );
  return next.some((row) => row.included && row.episode < 1) ? null : next;
}

// Duplicates: included rows sharing a (season, episode). Gaps: episode
// numbers missing between the first and last included episode of a season.
export function mappingIssues(rows) {
  const bySlot = new Map();
  const bySeason = new Map();
  for (const row of rows) {
    if (!row.included) continue;
    const slot = row.season + ":" + row.episode;
    bySlot.set(slot, [...(bySlot.get(slot) ?? []), row.id]);
    bySeason.set(row.season, [
      ...(bySeason.get(row.season) ?? []),
      row.episode,
    ]);
  }
  const duplicates = new Set();
  for (const ids of bySlot.values())
    if (ids.length > 1) for (const id of ids) duplicates.add(id);
  const gaps = [];
  for (const [season, episodes] of [...bySeason].sort(([a], [b]) => a - b)) {
    const present = new Set(episodes);
    const missing = [];
    for (let e = Math.min(...episodes); e <= Math.max(...episodes); e++)
      if (!present.has(e)) missing.push(e);
    if (missing.length) gaps.push({ season, missing });
  }
  return { duplicates, gaps };
}

export function describeGaps(gaps) {
  return gaps
    .map(
      ({ season, missing }) =>
        "Season " +
        season +
        " skips episode" +
        (missing.length > 1 ? "s " : " ") +
        missing.join(", "),
    )
    .join("; ");
}

function stripServerOwned(source) {
  const { managedMedia, sourceHash, searchImport, ...rest } = source;
  void managedMedia;
  void sourceHash;
  void searchImport;
  return rest;
}

// The PATCH that persists the editor: every included row becomes an
// episodeOverride (season/episode keyed by composite id), and inclusion goes
// to each source's own fileOverrides — but only when it changed, because
// include lists are part of the source definition and re-trigger checks.
export function mappingPatch(rows, initialRows, entry) {
  const patch = {
    episodeOverrides: rows
      .filter((row) => row.included)
      .map(({ id, season, episode }) => ({ id, season, episode })),
  };
  const before = new Map(initialRows.map((row) => [row.id, row.included]));
  const inclusionChanged = rows.some(
    (row) => before.get(row.id) !== row.included,
  );
  if (!inclusionChanged) return patch;
  const perSource = new Map();
  for (const row of rows) {
    const index = sourceIndexOf(row.id);
    perSource.set(index, [
      ...(perSource.get(index) ?? []),
      { id: rawIdOf(row.id), included: row.included },
    ]);
  }
  patch.fileOverrides = perSource.get(0) ?? [];
  if (entry.extraSources?.length)
    patch.extraSources = entry.extraSources.map((source, k) => ({
      ...stripServerOwned(source),
      fileOverrides: perSource.get(k + 1) ?? source.fileOverrides ?? [],
    }));
  return patch;
}
