let lastStreamActivity = 0;

export function markStreamActivity(now = Date.now()): void {
  lastStreamActivity = now;
}

export function recentStreamActivity(
  windowMs = 300_000,
  now = Date.now(),
): boolean {
  return lastStreamActivity > 0 && now - lastStreamActivity < windowMs;
}
