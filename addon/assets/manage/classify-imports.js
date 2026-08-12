// Classifies entries from an imported library JSON file against the current
// library, flagging conflicts and blocking invalid rows. Shared by the
// management UI and server-side tests.
export function classifyLibraryImports(imported, current) {
  if (!Array.isArray(imported))
    throw new Error("Library JSON must be an array");
  const rows = imported.map((entry) =>
    entry && typeof entry === "object" && !Array.isArray(entry) ? entry : {},
  );
  const normalizedTitle = (entry) =>
    typeof entry.name === "string" ? entry.name.trim().toLowerCase() : "";
  const count = (values) =>
    values.reduce((result, value) => {
      if (value) result.set(value, (result.get(value) ?? 0) + 1);
      return result;
    }, new Map());
  const currentIds = new Set(current.map((entry) => String(entry.id ?? "")));
  const currentTitles = new Set(current.map(normalizedTitle));
  const currentMagnets = new Set(
    current.map((entry) => String(entry.magnetUri ?? "")).filter(Boolean),
  );
  const importedIds = count(rows.map((entry) => String(entry.id ?? "")));
  const importedTitles = count(rows.map(normalizedTitle));
  const importedMagnets = count(
    rows.map((entry) => String(entry.magnetUri ?? "")),
  );
  return rows.map((entry) => {
    const conflicts = [];
    const id = String(entry.id ?? "");
    const title = normalizedTitle(entry);
    const magnet = String(entry.magnetUri ?? "");
    const valid =
      ["movie", "series"].includes(String(entry.type)) && Boolean(title);
    const hasSource = Boolean(
      magnet ||
      entry.torrentFilePath ||
      entry.localFilePath ||
      entry.localFolderPath,
    );
    if (!valid) conflicts.push("Invalid movie or series details");
    if (!hasSource) conflicts.push("No importable source");
    if (id && currentIds.has(id)) conflicts.push("ID already exists");
    if (id && (importedIds.get(id) ?? 0) > 1)
      conflicts.push("Duplicate ID in file");
    if (title && currentTitles.has(title))
      conflicts.push("Title already exists");
    if (title && (importedTitles.get(title) ?? 0) > 1)
      conflicts.push("Duplicate title in file");
    if (magnet && currentMagnets.has(magnet))
      conflicts.push("Magnet link already exists");
    if (magnet && (importedMagnets.get(magnet) ?? 0) > 1)
      conflicts.push("Duplicate magnet link in file");
    return { entry, conflicts, blocked: !valid || !hasSource };
  });
}
