import { randomBytes, randomUUID } from "node:crypto";
import { access, realpath, readdir, stat } from "node:fs/promises";
import { createConnection } from "node:net";
import { basename, join } from "node:path";
import { isPlayablePath } from "./media-file-selection.js";

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

  constructor(private readonly socketPath: string) {}

  /** True when the supervisor socket exists, so Finder pickers can work. */
  async available(): Promise<boolean> {
    try {
      await access(this.socketPath);
      return true;
    } catch {
      return false;
    }
  }

  async issue(kind: PickerKind) {
    const path = await this.select(kind);
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
    if (!grant || grant.expiresAt < Date.now())
      throw new SyntaxError("Finder selection expired; choose it again");
    return { kind: grant.kind, path: grant.path };
  }

  async select(kind: PickerKind): Promise<string> {
    const nonce = randomUUID();
    const path = await new Promise<string>((resolve, reject) => {
      const socket = createConnection(this.socketPath);
      let settled = false;
      let received = "";
      const finish = (error?: Error, value?: string) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        socket.destroy();
        if (error) reject(error);
        else resolve(value!);
      };
      const timer = setTimeout(
        () => finish(new PickerUnavailableError("Finder request timed out")),
        120_000,
      );
      socket.once("connect", () =>
        socket.write(`${JSON.stringify({ kind, nonce })}\n`),
      );
      socket.on("data", (chunk) => {
        received += chunk.toString("utf8");
        if (received.length > 8_192)
          return finish(new PickerUnavailableError("Invalid Finder response"));
        const newline = received.indexOf("\n");
        if (newline === -1) return;
        try {
          const response = JSON.parse(received.slice(0, newline)) as {
            cancelled?: boolean;
            nonce?: string;
            path?: string;
          };
          if (response.nonce !== nonce)
            return finish(
              new PickerUnavailableError("Finder response did not match"),
            );
          if (response.cancelled)
            return finish(new PickerCancelledError("Selection cancelled"));
          if (!response.path)
            return finish(
              new PickerUnavailableError("Finder returned no selection"),
            );
          finish(undefined, response.path);
        } catch {
          finish(new PickerUnavailableError("Invalid Finder response"));
        }
      });
      socket.once("error", () =>
        finish(new PickerUnavailableError("HoshiStream app is not available")),
      );
      socket.once("end", () =>
        finish(new PickerUnavailableError("Finder connection closed")),
      );
    });
    return validateNativePath(path, kind);
  }
}
