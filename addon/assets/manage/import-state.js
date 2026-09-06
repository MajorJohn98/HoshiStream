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
    ["magnetUri", "torrentFilePath", "seasonHint", "fileOverrides"]
      .filter((key) => source[key] !== undefined)
      .map((key) => [key, source[key]]),
  );
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
