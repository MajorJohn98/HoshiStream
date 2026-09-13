// Text for a disk-copy rolling window (Phase 8), shared by the entry sheet
// and the Storage page. Mirrors describePolicy() in src/disk-policy.ts.
export function policySummary(policy) {
  const ahead = policy?.keepAhead ?? 0;
  if (!ahead && !policy?.evictWatched) return "";
  return [
    ahead ? "next " + ahead + " ahead" : "",
    policy?.evictWatched ? "removes watched" : "",
  ]
    .filter(Boolean)
    .join(" · ");
}
