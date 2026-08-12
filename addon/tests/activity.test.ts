import { describe, expect, it } from "vitest";
import { markStreamActivity, recentStreamActivity } from "../src/activity.js";

describe("stream activity", () => {
  it("reports recent activity only within the window", () => {
    expect(recentStreamActivity(300_000, 1_000_000)).toBe(false);
    markStreamActivity(1_000_000);
    expect(recentStreamActivity(300_000, 1_100_000)).toBe(true);
    expect(recentStreamActivity(300_000, 1_400_000)).toBe(false);
  });
});
