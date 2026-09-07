// Measured link speed (download) via Cloudflare's open speed-test endpoint —
// the same backend the open-source speedtest CLIs use, reachable with plain
// fetch and no dependencies. Runs once at startup and on demand; between
// measurements the configured HOME_SPEED_MBPS remains the fallback.
// Cloudflare caps __down at well under 100 MB; 50 MB is accepted and the
// reader cancels at the measurement window anyway.
const DOWN_URL = "https://speed.cloudflare.com/__down?bytes=50000000";
const WARMUP_URL = "https://speed.cloudflare.com/__down?bytes=1000000";
const MEASURE_MS = 8_000;
const TIMEOUT_MS = 20_000;

export interface SpeedResult {
  mbps: number;
  measuredAt: string;
}

let configured = 10;
let measured: SpeedResult | undefined;
let running: Promise<SpeedResult> | undefined;
let measurement: AbortController | undefined;

export function setConfiguredSpeed(mbps: number): void {
  configured = mbps;
}

export function currentSpeed(): {
  mbps: number;
  source: "measured" | "configured";
  measuredAt?: string;
} {
  return measured
    ? {
        mbps: measured.mbps,
        source: "measured",
        measuredAt: measured.measuredAt,
      }
    : { mbps: configured, source: "configured" };
}

export function homeSpeedMbps(): number {
  return currentSpeed().mbps;
}

// For tests.
export function resetSpeed(): void {
  measurement?.abort();
  measurement = undefined;
  measured = undefined;
  running = undefined;
}

export async function stopSpeedTest(): Promise<void> {
  const pending = running;
  const controller = measurement;
  controller?.abort();
  try {
    await pending;
  } catch (error) {
    if (!controller?.signal.aborted) throw error;
  }
}

export async function measureDownloadMbps(
  fetchImpl: typeof fetch = fetch,
  measureMs = MEASURE_MS,
  signal?: AbortSignal,
): Promise<number> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);
  const requestSignal = signal
    ? AbortSignal.any([signal, controller.signal])
    : controller.signal;
  try {
    // Small warm-up so connection setup and TLS are not billed to the run.
    await fetchImpl(WARMUP_URL, { signal: requestSignal }).then((r) =>
      r.arrayBuffer(),
    );
    const response = await fetchImpl(DOWN_URL, { signal: requestSignal });
    if (!response.ok || !response.body)
      throw new Error(`Speed test failed: ${response.status}`);
    const reader = response.body.getReader();
    const started = Date.now();
    let bytes = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value?.length ?? 0;
      if (Date.now() - started >= measureMs) {
        await reader.cancel().catch(() => undefined);
        break;
      }
    }
    const seconds = Math.max((Date.now() - started) / 1000, 0.001);
    if (!bytes) throw new Error("Speed test read no data");
    return (bytes * 8) / seconds / 1_000_000;
  } finally {
    clearTimeout(timeout);
  }
}

export async function runSpeedTest(
  fetchImpl: typeof fetch = fetch,
): Promise<SpeedResult> {
  // Concurrent requests share one in-flight measurement.
  if (running) return running;
  const controller = new AbortController();
  measurement = controller;
  const pending = (async () => {
    const mbps = Number(
      (
        await measureDownloadMbps(fetchImpl, MEASURE_MS, controller.signal)
      ).toFixed(1),
    );
    measured = { mbps, measuredAt: new Date().toISOString() };
    console.log(
      JSON.stringify({ level: "info", event: "speedtest_completed", mbps }),
    );
    return measured;
  })();
  running = pending;
  try {
    return await pending;
  } finally {
    if (running === pending) {
      running = undefined;
      measurement = undefined;
    }
  }
}
