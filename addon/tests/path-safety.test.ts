import { win32, posix } from "node:path";
import { describe, expect, it } from "vitest";
import { containsPath, firstSegmentBelow } from "../src/path-safety.js";

describe("path containment", () => {
  it("accepts paths inside the root", () => {
    expect(containsPath("/data/media", "/data/media/batch/Show.mkv")).toBe(
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
});
