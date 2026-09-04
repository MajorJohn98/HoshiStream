// Runtime activity signals, kept in memory. A TorrServer torrent being
// "working" only says bytes are moving; these say why — a client is
// streaming, the archiver is copying, or an inspection is reading metadata.

let lastStreamActivity = 0;
const streamedEntries = new Map<string, number>();
const inspectedEntries = new Map<string, number>();

export const STREAM_WINDOW_MS = 300_000;
export const INSPECT_WINDOW_MS = 120_000;

export function markStreamActivity(now = Date.now(), entryId?: string): void {
  lastStreamActivity = now;
  if (entryId) streamedEntries.set(entryId, now);
}

export function markInspectActivity(entryId: string, now = Date.now()): void {
  inspectedEntries.set(entryId, now);
}

export function recentStreamActivity(
  windowMs = STREAM_WINDOW_MS,
  now = Date.now(),
): boolean {
  return lastStreamActivity > 0 && now - lastStreamActivity < windowMs;
}

export type EntryActivity = "streaming" | "inspecting";

/** What this entry was last doing, if anything recent enough to matter. */
export function recentEntryActivity(
  entryId: string,
  now = Date.now(),
): EntryActivity | undefined {
  const streamed = streamedEntries.get(entryId) ?? 0;
  if (now - streamed < STREAM_WINDOW_MS) return "streaming";
  const inspected = inspectedEntries.get(entryId) ?? 0;
  if (now - inspected < INSPECT_WINDOW_MS) return "inspecting";
  return undefined;
}
