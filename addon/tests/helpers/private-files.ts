import { stat } from "node:fs/promises";
import { expect } from "vitest";

// Files written with `mode: 0o600` are owner-only on POSIX. Windows has no mode
// bits: `writeFile({ mode })` is a no-op and `stat` reports 0o666. Privacy there
// comes from the directory ACL — `%LOCALAPPDATA%` is per-user by default and
// `scripts/private-files.mjs` applies an explicit owner-only ACL where the app
// creates directories outside it — so on Windows this only checks the file
// exists. Callers that ACL-restrict a specific file (the bootstrap `.env`)
// verify the ACL themselves.
export async function expectOwnerOnly(path: string): Promise<void> {
  const info = await stat(path);
  expect(info.isFile()).toBe(true);
  if (process.platform !== "win32") expect(info.mode & 0o777).toBe(0o600);
}
