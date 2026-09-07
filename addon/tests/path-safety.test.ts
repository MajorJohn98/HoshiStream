import { win32, posix } from "node:path";
import { describe, expect, it } from "vitest";
import {
  containsPath,
  firstSegmentBelow,
  isSafeRelativePath,
} from "../src/path-safety.ts";

describe("path containment", () => {
  it("accepts paths inside the root", () => {
    expect(containsPath("/data/media", "/data/media/batch/Show.mkv")).toBe(
      true,
    );
    expect(containsPath("/data/media", "/data/media/..bonus/Show.mkv")).toBe(
      true,
    );
  });

  it("rejects the root itself", () => {
    expect(containsPath("/data/media", "/data/media")).toBe(false);
  });

  it("rejects traversal out of the root", () => {
    expect(containsPath("/data/media", "/data/media/../secrets")).toBe(false);
    expect(containsPath("/data/media", "/etc/passwd")).toBe(false);
  });

  it("rejects a sibling directory sharing the root's prefix", () => {
    expect(containsPath("/data/media", "/data/media-other/Show.mkv")).toBe(
      false,
    );
  });

  it("extracts the first segment below the root", () => {
    expect(
      firstSegmentBelow("/data/media", "/data/media/batch-id/Show/One.mkv"),
    ).toBe("batch-id");
  });

  it("returns undefined for a path outside the root", () => {
    expect(firstSegmentBelow("/data/media", "/elsewhere/file.mkv")).toBe(
      undefined,
    );
  });
});

// These assert the platform-specific behavior the guards rely on, which is why
// the previous `startsWith(root + sep)` and literal `/` comparisons were wrong
// on Windows.
describe("windows path semantics", () => {
  it("treats drive-letter paths case-insensitively", () => {
    const rel = win32.relative("C:\\Media", "c:\\media\\Show.mkv");
    expect(rel).toBe("Show.mkv");
    expect(rel.startsWith("..")).toBe(false);
    expect(containsPath("C:\\Media", "c:\\media\\Show.mkv", win32)).toBe(true);
    expect(containsPath("C:\\Media", "c:\\MEDIA", win32)).toBe(false);
    expect(containsPath("C:\\Media", "D:\\Media\\Show.mkv", win32)).toBe(false);
    expect(containsPath("C:\\Media", "C:\\Media\\..\\Show.mkv", win32)).toBe(
      false,
    );
    expect(containsPath("C:\\", "C:\\Films\\Show.mkv", win32)).toBe(true);
    expect(
      containsPath("C:\\Media", "C:\\Media\\..bonus\\Show.mkv", win32),
    ).toBe(true);
  });

  it("does not match a backslash path against a literal forward slash", () => {
    // The old removeManagedMedia guard was `source.startsWith(root + "/")`,
    // which never matches a Windows path and silently skipped cleanup.
    expect("C:\\data\\media\\batch".startsWith("C:\\data\\media/")).toBe(false);
  });

  it("splits segments on either separator", () => {
    expect("batch-id\\Show\\One.mkv".split(/[\\/]/)[0]).toBe("batch-id");
    expect(posix.join("batch-id", "Show").split(/[\\/]/)[0]).toBe("batch-id");
  });

  it.each([
    "C:relative.mkv",
    "D:/absolute.mkv",
    "//server/share/movie.mkv",
    "Show/CON.mkv",
    "Show/nul",
    "COM1.mkv",
    "Lpt9.txt",
    "aux.torrent",
    "Show/movie.mkv:stream",
    "Show/trailing./a.mkv",
    "Show/trailing /a.mkv",
    "Show/question?.mkv",
    "Show/\0movie.mkv",
    "Show/\u0001movie.mkv",
  ])("rejects unsafe Windows destinations: %j", (path) => {
    expect(isSafeRelativePath(path, "win32")).toBe(false);
  });

  it("keeps legitimate spaces, Unicode, long relative paths and dotted names", () => {
    for (const path of [
      "Show/Film 1.mkv",
      "M\u00e9dia/\u661f.mkv",
      "..bonus/film.mkv",
      "CON-123/film.mkv",
      `${"folder/".repeat(50)}film.mkv`,
    ])
      expect(isSafeRelativePath(path, "win32")).toBe(true);
    expect(isSafeRelativePath("film:one.mkv", "darwin")).toBe(true);
  });
});
