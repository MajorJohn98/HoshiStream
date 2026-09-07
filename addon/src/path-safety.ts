import { isAbsolute, relative, win32, posix } from "node:path";

type PathSemantics = Pick<typeof win32, "relative" | "isAbsolute">;

export function samePath(root: string, candidate: string): boolean {
  return relative(root, candidate) === "";
}

// Containment checks used to run as `actual.startsWith(root + sep)`, which is
// both separator-sensitive and case-sensitive. `relative` handles separators
// for the current platform and compares case-insensitively on Windows, so the
// same guard behaves correctly on macOS and Windows.
export function containsPath(
  root: string,
  candidate: string,
  paths: PathSemantics = { relative, isAbsolute },
): boolean {
  const rel = paths.relative(root, candidate);
  return (
    rel !== "" &&
    rel !== ".." &&
    !/^\.\.[\\/]/.test(rel) &&
    !paths.isAbsolute(rel)
  );
}

// The first path segment below `root`, or undefined when `candidate` is not
// inside `root`.
export function firstSegmentBelow(
  root: string,
  candidate: string,
): string | undefined {
  if (!containsPath(root, candidate)) return undefined;
  const [segment] = relative(root, candidate).split(/[\\/]/);
  return segment || undefined;
}

// True for a normalized, separator-forward relative path that cannot escape
// its base: no absolute paths, no empty/"."/".." segments, no backslashes.
// Torrent file paths are untrusted input and must pass this before they are
// used to build any on-disk destination.
export function isSafeRelativePath(
  path: string,
  platform = process.platform,
): boolean {
  if (
    !path ||
    posix.isAbsolute(path) ||
    win32.isAbsolute(path) ||
    /^[a-z]:/i.test(path)
  )
    return false;
  return path
    .split("/")
    .every(
      (segment) =>
        segment !== "" &&
        segment !== "." &&
        segment !== ".." &&
        !segment.includes("\\") &&
        !segment.includes("\0") &&
        (platform !== "win32" || isWindowsFilename(segment)),
    );
}

export function isWindowsFilename(name: string): boolean {
  return (
    name.length > 0 &&
    !/[<>:"/\\|?*]/.test(name) &&
    !Array.from(name).some((character) => character.charCodeAt(0) < 32) &&
    !/[. ]$/.test(name) &&
    !/^(?:con|prn|aux|nul|com[1-9\u00b9\u00b2\u00b3]|lpt[1-9\u00b9\u00b2\u00b3])(?:\.|$)/i.test(
      name,
    )
  );
}
