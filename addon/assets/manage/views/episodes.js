// Pure helpers for the Episodes tab: turning form fields into the
// `episodes` PATCH map and back. Kept free of DOM so tests can import it.

export function episodeKey(season, episode) {
  return season + ":" + episode;
}

// A YYYY-MM-DD date input value → ISO datetime at midnight UTC; blank → undefined.
export function releasedFromDate(value) {
  const text = String(value ?? "").trim();
  if (!text) return undefined;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text))
    throw new Error("Use a YYYY-MM-DD date");
  const iso = new Date(text + "T00:00:00.000Z");
  if (Number.isNaN(iso.getTime())) throw new Error("Not a valid date");
  return iso.toISOString();
}

// ISO datetime → the YYYY-MM-DD an <input type="date"> shows.
export function dateFromReleased(iso) {
  return iso ? String(iso).slice(0, 10) : "";
}

// Form fields are flat: `title:S:E`, `overview:S:E`, `released:S:E`. Build
// the map the API stores from the rows on screen, keep overrides for
// episodes that were not shown (other seasons), drop episodes with nothing
// set, and send null when the map ends up empty so the PATCH clears it.
export function episodesPatch(fields, shown, existing = {}) {
  const map = {};
  const shownKeys = new Set(shown.map((e) => episodeKey(e.season, e.episode)));
  for (const [key, value] of Object.entries(existing || {})) {
    if (!shownKeys.has(key)) map[key] = value;
  }
  for (const { season, episode } of shown) {
    const key = episodeKey(season, episode);
    const title = String(fields["title:" + key] ?? "").trim();
    const overview = String(fields["overview:" + key] ?? "").trim();
    const released = releasedFromDate(fields["released:" + key]);
    const value = {};
    if (title) value.title = title;
    if (overview) value.overview = overview;
    if (released) value.released = released;
    if (Object.keys(value).length) map[key] = value;
  }
  return { episodes: Object.keys(map).length ? map : null };
}

export function thumbnailSummary(status, eligible, generated) {
  if (!status) return "Thumbnails unavailable on this host.";
  if (status.running) return "Generating thumbnails…";
  if (!eligible)
    return "No episode is on disk yet. Thumbnails are grabbed from local folders and completed disk copies, never from a live torrent.";
  const parts = [
    generated +
      " of " +
      eligible +
      " on-disk episode" +
      (eligible === 1 ? " has" : "s have") +
      " a thumbnail",
  ];
  if (status.failed)
    parts.push(
      status.failed +
        " failed" +
        (status.lastError ? ": " + status.lastError : ""),
    );
  return parts.join(" · ") + ".";
}
