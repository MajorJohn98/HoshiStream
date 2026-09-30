import { afterEach, describe, expect, it, vi } from "vitest";
import { AnalysisSlot } from "../src/analysis-slot.ts";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("AnalysisSlot", () => {
  it("grants a free slot synchronously and hands it over in request order", () => {
    const slot = new AnalysisSlot();
    const order: string[] = [];
    let releaseCheck!: () => void;
    slot.request("source-check", (release) => {
      order.push("check");
      releaseCheck = release;
    });
    expect(slot.holder()).toBe("source-check");
    slot.request("stream-test", () => order.push("test"));
    slot.request("source-check", () => order.push("second check"));
    expect(order).toEqual(["check"]);

    releaseCheck();
    expect(order).toEqual(["check", "test"]);
    expect(slot.holder()).toBe("stream-test");
  });

  it("skips withdrawn requests and ignores a withdraw after the grant", () => {
    const slot = new AnalysisSlot();
    let release!: () => void;
    const withdrawFirst = slot.request("stream-test", (done) => {
      release = done;
    });
    const skipped = vi.fn();
    const withdraw = slot.request("source-check", skipped);
    const next = vi.fn();
    slot.request("source-check", next);

    withdraw();
    withdrawFirst();
    expect(slot.holder()).toBe("stream-test");
    release();
    expect(skipped).not.toHaveBeenCalled();
    expect(next).toHaveBeenCalledOnce();
  });

  it("treats release as idempotent", () => {
    const slot = new AnalysisSlot();
    let release!: () => void;
    slot.request("stream-test", (done) => {
      release = done;
    });
    let secondRelease!: () => void;
    slot.request("source-check", (done) => {
      secondRelease = done;
    });
    const third = vi.fn();
    slot.request("stream-test", third);

    release();
    release();
    expect(slot.holder()).toBe("source-check");
    expect(third).not.toHaveBeenCalled();
    secondRelease();
    expect(third).toHaveBeenCalledOnce();
  });

  it("releases the slot when a holder throws while starting", () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const slot = new AnalysisSlot();
    slot.request("stream-test", () => {
      throw new Error("boom");
    });
    const next = vi.fn();
    slot.request("source-check", next);
    expect(next).toHaveBeenCalledOnce();
    expect(error).toHaveBeenCalledWith(
      expect.stringContaining("analysis_slot_start_failed"),
    );
  });
});
