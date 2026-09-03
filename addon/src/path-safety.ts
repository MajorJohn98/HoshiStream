import { isAbsolute, relative } from "node:path";

// Containment checks used to run as `actual.startsWith(root + sep)`, which is
// both separator-sensitive and case-sensitive. `relative` handles separators
// for the current platform and compares case-insensitively on Windows, so the
// same guard behaves correctly on macOS and Windows.
export function containsPath(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
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
export function isSafeRelativePath(path: string): boolean {
  if (!path || isAbsolute(path)) return false;
  return path
    .split("/")
    .every(
      (segment) =>
        segment !== "" &&
        segment !== "." &&
        segment !== ".." &&
        !segment.includes("\\"),
    );
}
