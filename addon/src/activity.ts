// Runtime activity signals, kept in memory. A TorrServer torrent being
// "working" only says bytes are moving; these say why — a client is
// streaming, the archiver is copying, an inspection is reading metadata, or
// a pre-add stream test is measuring a torrent.

let lastStreamActivity = 0;
const streamedEntries = new Map<string, number>();
const inspectedEntries = new Map<string, number>();
const streamTests = new Map<string, number>();

export const STREAM_WINDOW_MS = 300_000;
export const INSPECT_WINDOW_MS = 120_000;

export function markStreamActivity(now = Date.now(), entryId?: string): void {
  lastStreamActivity = now;
  if (entryId) streamedEntries.set(entryId, now);
}

export function markInspectActivity(entryId: string, now = Date.now()): void {
  inspectedEntries.set(entryId, now);
}

/** When a client last streamed, in epoch milliseconds, or 0 if never. */
export function lastStreamActivityAt(): number {
  return lastStreamActivity;
}

/**
 * Marks a torrent as read by a pre-add stream test, so playback telemetry
 * does not mistake the test's reader for a viewer and the archiver yields as
 * it does to playback. Returns an idempotent function that ends the mark.
 */
export function beginStreamTest(hash: string): () => void {
  const key = hash.toLowerCase();
  streamTests.set(key, (streamTests.get(key) ?? 0) + 1);
  let ended = false;
  return () => {
    if (ended) return;
    ended = true;
    const remaining = (streamTests.get(key) ?? 1) - 1;
    if (remaining > 0) streamTests.set(key, remaining);
    else streamTests.delete(key);
  };
}

export function streamTestActive(): boolean {
  return streamTests.size > 0;
}

export function isStreamTestHash(hash: string): boolean {
  return streamTests.has(hash.toLowerCase());
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
