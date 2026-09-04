import { describe, expect, it } from "vitest";
import { markStreamActivity, recentStreamActivity } from "../src/activity.ts";

describe("stream activity", () => {
  it("reports recent activity only within the window", () => {
    expect(recentStreamActivity(300_000, 1_000_000)).toBe(false);
    markStreamActivity(1_000_000);
    expect(recentStreamActivity(300_000, 1_100_000)).toBe(true);
    expect(recentStreamActivity(300_000, 1_400_000)).toBe(false);
  });
});

describe("per-entry activity", () => {
  it("distinguishes streaming from inspecting and expires each window", async () => {
    const { markInspectActivity, recentEntryActivity } =
      await import("../src/activity.ts");
    const t = 5_000_000;
    expect(recentEntryActivity("hoshi:a", t)).toBeUndefined();
    markInspectActivity("hoshi:a", t);
    expect(recentEntryActivity("hoshi:a", t + 60_000)).toBe("inspecting");
    expect(recentEntryActivity("hoshi:a", t + 130_000)).toBeUndefined();
    markStreamActivity(t, "hoshi:a");
    expect(recentEntryActivity("hoshi:a", t + 60_000)).toBe("streaming");
    expect(recentEntryActivity("hoshi:a", t + 299_000)).toBe("streaming");
    expect(recentEntryActivity("hoshi:a", t + 301_000)).toBeUndefined();
    expect(recentEntryActivity("hoshi:b", t)).toBeUndefined();
  });
});
