import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { basename, dirname } from "node:path";
import type { z } from "zod";

/**
 * Durable replace: unique temp file, fsync, rename, then fsync the directory
 * so a power cut leaves either the old or the new file — never neither.
 */
export async function writeJsonFile(
  path: string,
  value: unknown,
  options: { mode?: number; directoryMode?: number } = {},
): Promise<void> {
  const directory = dirname(path);
  await mkdir(directory, {
    recursive: true,
    ...(options.directoryMode === undefined
      ? {}
      : { mode: options.directoryMode }),
  });
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    const handle = await open(temporary, "wx", options.mode ?? 0o600);
    try {
      await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporary, path);
  } catch (error) {
    await unlink(temporary).catch(() => undefined);
    throw error;
  }
  await syncDirectory(directory);
}

// Windows cannot open a directory for fsync; NTFS journals the rename itself.
async function syncDirectory(directory: string): Promise<void> {
  if (process.platform === "win32") return;
  const handle = await open(directory, "r").catch(() => undefined);
  if (!handle) return;
  try {
    await handle.sync();
  } catch {
    // Some filesystems (network, FUSE) reject directory fsync; the rename
    // already happened, so durability is best effort there.
  } finally {
    await handle.close();
  }
}

/**
 * Read and validate a JSON state file. Missing → undefined. Malformed or
 * invalid → the file is moved aside (never overwritten) and undefined is
 * returned so the caller can start from defaults. Any other I/O error is
 * rethrown: the file exists but cannot be read, so it must not be replaced.
 */
export async function readJsonFile<Schema extends z.ZodType>(
  path: string,
  schema: Schema,
): Promise<z.infer<Schema> | undefined> {
  let contents: string;
  try {
    contents = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(contents);
  } catch {
    await quarantine(path, "malformed_json");
    return undefined;
  }
  const result = schema.safeParse(parsed);
  if (!result.success) {
    await quarantine(path, "invalid_schema");
    return undefined;
  }
  return result.data;
}

async function quarantine(path: string, reason: string): Promise<void> {
  const target = `${path}.corrupt-${Date.now()}`;
  const moved = await rename(path, target).then(
    () => true,
    () => false,
  );
  console.error(
    JSON.stringify({
      level: "warn",
      event: "state_file_quarantined",
      file: basename(path),
      reason,
      ...(moved ? { movedTo: basename(target) } : { moved: false }),
    }),
  );
  // If the corrupt file could not be moved aside, refuse to continue: the
  // caller would otherwise overwrite the only copy.
  if (!moved) throw new Error(`Cannot quarantine unreadable ${basename(path)}`);
}
