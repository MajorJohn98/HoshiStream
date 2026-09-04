import { mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  ArchiveSchedule,
  describeWindow,
  formatTime,
  parseTime,
  withinWindow,
} from "../src/archive-schedule.ts";

const temporary: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporary
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

function at(hours: number, minutes = 0): Date {
  return new Date(2026, 0, 1, hours, minutes);
}

describe("archive window", () => {
  it("parses and formats HH:MM times", () => {
    expect(parseTime("01:30")).toBe(90);
    expect(formatTime(90)).toBe("01:30");
    expect(() => parseTime("24:00")).toThrow(SyntaxError);
    expect(() => parseTime("1:00")).toThrow(SyntaxError);
    expect(describeWindow({ startMinute: 60, endMinute: 420 })).toBe(
      "01:00–07:00",
    );
  });

  it("evaluates same-day windows", () => {
    const window = {
      startMinute: parseTime("01:00"),
      endMinute: parseTime("07:00"),
    };
    expect(withinWindow(window, at(0, 59))).toBe(false);
    expect(withinWindow(window, at(1, 0))).toBe(true);
    expect(withinWindow(window, at(6, 59))).toBe(true);
    expect(withinWindow(window, at(7, 0))).toBe(false);
  });

  it("evaluates overnight windows and degenerate cases", () => {
    const overnight = {
      startMinute: parseTime("23:00"),
      endMinute: parseTime("06:00"),
    };
    expect(withinWindow(overnight, at(23, 30))).toBe(true);
    expect(withinWindow(overnight, at(2, 0))).toBe(true);
    expect(withinWindow(overnight, at(12, 0))).toBe(false);
    // No window and a zero-length window both mean "always allowed".
    expect(withinWindow(undefined, at(12, 0))).toBe(true);
    expect(withinWindow({ startMinute: 60, endMinute: 60 }, at(12, 0))).toBe(
      true,
    );
  });

  it("persists the window across instances", async () => {
    const base = await realpath(
      await mkdtemp(join(tmpdir(), "hoshistream-schedule-")),
    );
    temporary.push(base);
    const path = join(base, "disk-schedule.json");
    const schedule = new ArchiveSchedule(path);
    await expect(schedule.window()).resolves.toBeUndefined();

    await schedule.set({ startMinute: 60, endMinute: 420 });
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual({
      window: { startMinute: 60, endMinute: 420 },
    });
    const reopened = new ArchiveSchedule(path);
    await expect(reopened.window()).resolves.toEqual({
      startMinute: 60,
      endMinute: 420,
    });

    await schedule.set(undefined);
    await expect(new ArchiveSchedule(path).window()).resolves.toBeUndefined();
  });
});
