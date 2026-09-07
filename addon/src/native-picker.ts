import { randomBytes } from "node:crypto";
import { access, realpath, readdir, stat } from "node:fs/promises";
import { basename, join } from "node:path";
import { z } from "zod";
import { isPlayablePath } from "./media-file-selection.ts";
import { NativeBridgeError, nativeBridgeRequest } from "./windows-platform.ts";

export type PickerKind = "file" | "folder";

export class PickerUnavailableError extends Error {}
export class PickerCancelledError extends Error {}

async function containsVideo(directory: string): Promise<boolean> {
  for (const item of await readdir(directory, { withFileTypes: true })) {
    if (item.isFile() && isPlayablePath(item.name)) return true;
    if (item.isDirectory() && (await containsVideo(join(directory, item.name))))
      return true;
  }
  return false;
}

export async function validateNativePath(
  path: string,
  kind: PickerKind,
): Promise<string> {
  const actual = await realpath(path);
  const info = await stat(actual);
  if (kind === "file" && (!info.isFile() || !isPlayablePath(actual)))
    throw new SyntaxError("Choose a supported video file");
  if (
    kind === "folder" &&
    (!info.isDirectory() || !(await containsVideo(actual)))
  )
    throw new SyntaxError("Choose a folder containing supported video files");
  return actual;
}

type Grant = { expiresAt: number; kind: PickerKind; path: string };

export class NativePicker {
  private readonly grants = new Map<string, Grant>();

  private readonly socketPath: string;
  private readonly platform: NodeJS.Platform;

  constructor(socketPath: string, platform = process.platform) {
    this.socketPath = socketPath;
    this.platform = platform;
  }

  /** Windows pipes are not filesystem entries; probe the live desktop bridge. */
  async available(): Promise<boolean> {
    try {
      if (this.platform === "win32") {
        const response = await nativeBridgeRequest(
          this.socketPath,
          { kind: "ping" },
          2_000,
        );
        return z.object({ available: z.literal(true) }).safeParse(response)
          .success;
      }
      await access(this.socketPath);
      return true;
    } catch {
      return false;
    }
  }

  async issue(kind: PickerKind) {
    const path = await this.select(kind);
    for (const [value, grant] of this.grants)
      if (grant.expiresAt <= Date.now()) this.grants.delete(value);
    const grant = randomBytes(24).toString("base64url");
    this.grants.set(grant, {
      expiresAt: Date.now() + 60_000,
      kind,
      path,
    });
    return { grant, name: basename(path) };
  }

  redeem(value: string): { kind: PickerKind; path: string } {
    const grant = this.grants.get(value);
    this.grants.delete(value);
    if (!grant || grant.expiresAt <= Date.now())
      throw new SyntaxError("Selection expired; choose it again");
    return { kind: grant.kind, path: grant.path };
  }

  async select(kind: PickerKind): Promise<string> {
    return validateNativePath(await this.request(kind), kind);
  }

  /**
   * Pick a storage folder for the volume registry. Uses the same native
   * folder dialog but only requires a directory — a fresh drive folder has
   * no video files yet.
   */
  async selectStorage(): Promise<string> {
    const path = await this.request("folder");
    const actual = await realpath(path);
    if (!(await stat(actual)).isDirectory())
      throw new SyntaxError("Choose a folder to use as storage");
    return actual;
  }

  private async request(kind: PickerKind): Promise<string> {
    let raw: unknown;
    try {
      raw = await nativeBridgeRequest(this.socketPath, { kind }, 120_000);
    } catch (error) {
      if (error instanceof NativeBridgeError)
        throw new PickerUnavailableError(error.message);
      throw error;
    }
    const response = z
      .union([
        z.object({ cancelled: z.literal(true), path: z.never().optional() }),
        z.object({
          path: z.string().min(1),
          cancelled: z.literal(false).optional(),
        }),
      ])
      .safeParse(raw);
    if (!response.success)
      throw new PickerUnavailableError("Invalid desktop selection");
    if (response.data.cancelled)
      throw new PickerCancelledError("Selection cancelled");
    return response.data.path;
  }
}
