// Pure helpers shared by the manual add flow, JSON import/export, deep-link
// loading gates, and source-check controllers.
export function createRequestGate() {
  let current;
  return {
    start() {
      current?.abort();
      const controller = new AbortController();
      current = controller;
      return {
        signal: controller.signal,
        isCurrent: () => current === controller && !controller.signal.aborted,
      };
    },
    cancel() {
      current?.abort();
      current = undefined;
    },
  };
}

export function manualSubmission(
  previous,
  payload,
  uuid = () => crypto.randomUUID(),
) {
  const signature = JSON.stringify(payload);
  if (previous?.signature === signature) return previous;
  return {
    signature,
    body: { ...payload, idempotencyKey: uuid() },
  };
}

export function stripServerMetadata(entry) {
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) return entry;
  const {
    managedMedia,
    searchImport,
    searchReceipts,
    sourceHash,
    sourceCheck,
    ...details
  } = entry;
  if (Array.isArray(details.extraSources))
    details.extraSources = details.extraSources.map(stripServerMetadata);
  return details;
}

export function editableSource(source) {
  return Object.fromEntries(
    [
      "magnetUri",
      "torrentFilePath",
      "seasonHint",
      "episodeHint",
      "fileOverrides",
    ]
      .filter((key) => source[key] !== undefined)
      .map((key) => [key, source[key]]),
  );
}

// Season/episode form fields for one torrent → numbering hints. Blank
// fields are omitted; they only number files without SxxEyy in their names.
export function sourceHints(season, episode) {
  const hints = {};
  const seasonText = String(season ?? "").trim();
  const episodeText = String(episode ?? "").trim();
  if (seasonText) {
    const value = Number(seasonText);
    if (!Number.isInteger(value) || value < 0)
      throw Error("Season must be a whole number starting at 0.");
    hints.seasonHint = value;
  }
  if (episodeText) {
    const value = Number(episodeText);
    if (!Number.isInteger(value) || value < 1 || value > 9999)
      throw Error("Episode must be a whole number from 1 to 9999.");
    hints.episodeHint = value;
  }
  return hints;
}

export function sourceHintLabel(source) {
  const parts = [];
  if (source?.seasonHint !== undefined)
    parts.push("Season " + source.seasonHint);
  if (source?.episodeHint !== undefined)
    parts.push(
      (source.seasonHint === undefined ? "Episode " : "episode ") +
        source.episodeHint,
    );
  return parts.length ? parts.join(", ") : "Numbered from file names";
}

export function additionalSourceImportProblems(entry) {
  if (entry.extraSources === undefined) return [];
  if (!Array.isArray(entry.extraSources))
    return ["Additional sources must be a list."];
  return entry.extraSources.flatMap((source, index) => {
    const hasLocator = [source?.magnetUri, source?.torrentFilePath].some(
      (value) => typeof value === "string" && value.trim(),
    );
    return hasLocator
      ? []
      : [
          `Additional source ${index + 1} has no importable magnet link or .torrent path. Browser JSON omits managed .torrent files; restore library.json and managed media from a full backup.`,
        ];
  });
}
