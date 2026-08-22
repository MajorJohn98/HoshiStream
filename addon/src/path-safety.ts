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
