import { afterEach, describe, expect, it } from "vitest";
import {
  currentSpeed,
  homeSpeedMbps,
  measureDownloadMbps,
  resetSpeed,
  runSpeedTest,
  setConfiguredSpeed,
} from "../src/speedtest.ts";

function fakeFetch(chunkSize: number, chunks: number): typeof fetch {
  return (async (url: RequestInfo | URL) => {
    const text = String(url);
    const count = text.endsWith("bytes=1000000") ? 1 : chunks;
    let sent = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (sent >= count) return controller.close();
        sent++;
        controller.enqueue(new Uint8Array(chunkSize));
      },
    });
    return new Response(body, { status: 200 });
  }) as typeof fetch;
}

afterEach(() => {
  resetSpeed();
  setConfiguredSpeed(10);
});

describe("currentSpeed", () => {
  it("falls back to the configured value before any measurement", () => {
    setConfiguredSpeed(25);
    expect(currentSpeed()).toEqual({ mbps: 25, source: "configured" });
    expect(homeSpeedMbps()).toBe(25);
  });

  it("prefers a measurement once one exists", async () => {
    setConfiguredSpeed(10);
    await runSpeedTest(fakeFetch(1_000_000, 20));
    const speed = currentSpeed();
    expect(speed.source).toBe("measured");
    expect(speed.mbps).toBeGreaterThan(0);
    expect(speed.measuredAt).toBeTruthy();
    expect(homeSpeedMbps()).toBe(speed.mbps);
  });
});

describe("measureDownloadMbps", () => {
  it("computes Mbps from streamed bytes", async () => {
    const mbps = await measureDownloadMbps(fakeFetch(1_000_000, 10), 200);
    expect(mbps).toBeGreaterThan(0);
  });

  it("rejects on HTTP errors", async () => {
    const failing = (async () =>
      new Response(null, { status: 503 })) as unknown as typeof fetch;
    await expect(measureDownloadMbps(failing)).rejects.toThrow("503");
  });
});

describe("runSpeedTest", () => {
  it("shares one in-flight measurement between concurrent calls", async () => {
    let calls = 0;
    const counting = (async (url: RequestInfo | URL) => {
      if (!String(url).endsWith("bytes=1000000")) calls++;
      return fakeFetch(1_000_000, 5)(url as never);
    }) as typeof fetch;
    const [first, second] = await Promise.all([
      runSpeedTest(counting),
      runSpeedTest(counting),
    ]);
    expect(first.mbps).toBe(second.mbps);
    expect(calls).toBe(1);
  });
});
