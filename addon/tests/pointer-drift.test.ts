import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PointerDriftMonitor } from "../src/pointer-drift.ts";
import type { DriftObservation, PointerClient } from "../src/pointer.ts";

function fakePointer(outcome: DriftObservation["outcome"] = "match") {
  const observeDrift = vi.fn(
    async (
      trigger: DriftObservation["trigger"],
    ): Promise<DriftObservation> => ({
      outcome,
      trigger,
      checkedAt: new Date().toISOString(),
      state: "registered",
      message: "",
    }),
  );
  return {
    pointer: { observeDrift } as unknown as PointerClient,
    observeDrift,
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("PointerDriftMonitor", () => {
  it("checks once at start and once per LAN address change, never in a loop", async () => {
    const { pointer, observeDrift } = fakePointer("remote-mismatch");
    let ip: string | undefined = "192.168.1.42";
    const monitor = new PointerDriftMonitor(pointer, {
      lanIp: () => ip,
      ipCheckIntervalMs: 1_000,
      timeoutMs: 700,
    });
    monitor.start();
    await monitor.settled();
    expect(observeDrift).toHaveBeenCalledExactlyOnceWith("start", {
      timeoutMs: 700,
    });

    // Same address: silence, however long it stays stale.
    await vi.advanceTimersByTimeAsync(10_000);
    await monitor.settled();
    expect(observeDrift).toHaveBeenCalledTimes(1);

    ip = "192.168.1.77";
    await vi.advanceTimersByTimeAsync(1_000);
    await monitor.settled();
    expect(observeDrift).toHaveBeenCalledTimes(2);
    expect(observeDrift).toHaveBeenLastCalledWith("lan-change", {
      timeoutMs: 700,
    });

    // Losing the address is not a change to report; regaining the same one
    // is not either.
    ip = undefined;
    await vi.advanceTimersByTimeAsync(1_000);
    ip = "192.168.1.77";
    await vi.advanceTimersByTimeAsync(1_000);
    await monitor.settled();
    expect(observeDrift).toHaveBeenCalledTimes(2);
    monitor.stop();
    ip = "10.0.0.5";
    await vi.advanceTimersByTimeAsync(5_000);
    expect(observeDrift).toHaveBeenCalledTimes(2);
  });

  it("waits for the first LAN address before its start check", async () => {
    const { pointer, observeDrift } = fakePointer();
    let ip: string | undefined = undefined;
    const monitor = new PointerDriftMonitor(pointer, {
      lanIp: () => ip,
      ipCheckIntervalMs: 1_000,
    });
    monitor.start();
    await monitor.settled();
    expect(observeDrift).not.toHaveBeenCalled();
    ip = "192.168.1.42";
    await vi.advanceTimersByTimeAsync(1_000);
    await monitor.settled();
    expect(observeDrift).toHaveBeenCalledExactlyOnceWith("start", {
      timeoutMs: 5_000,
    });
    monitor.stop();
  });

  it("logs the outcome without addresses and survives a failing check", async () => {
    const { pointer, observeDrift } = fakePointer("remote-mismatch");
    observeDrift.mockRejectedValueOnce(new Error("storage"));
    let ip = "192.168.1.42";
    const monitor = new PointerDriftMonitor(pointer, {
      lanIp: () => ip,
      ipCheckIntervalMs: 1_000,
    });
    monitor.start();
    await monitor.settled();
    expect(console.error).toHaveBeenCalledWith(
      JSON.stringify({
        level: "warn",
        event: "pointer_drift_check_failed",
        trigger: "start",
      }),
    );
    ip = "192.168.1.77";
    await vi.advanceTimersByTimeAsync(1_000);
    await monitor.settled();
    expect(console.log).toHaveBeenCalledWith(
      JSON.stringify({
        level: "warn",
        event: "pointer_drift_observed",
        trigger: "lan-change",
        outcome: "remote-mismatch",
      }),
    );
    monitor.stop();
  });
});
