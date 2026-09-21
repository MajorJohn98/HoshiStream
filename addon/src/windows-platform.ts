import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createConnection } from "node:net";
import { win32 } from "node:path";
import { promisify } from "node:util";
import { z } from "zod";

const execFileAsync = promisify(execFile);
export const NATIVE_MESSAGE_MAX_BYTES = 8_192;

export class NativeBridgeError extends Error {}

/** One bounded, nonce-correlated JSON exchange with the same-user desktop. */
export function nativeBridgeRequest(
  endpoint: string,
  request: { kind: string; pid?: number },
  timeoutMs: number,
): Promise<unknown> {
  const nonce = randomUUID();
  return new Promise((resolve, reject) => {
    const socket = createConnection(endpoint);
    let received = Buffer.alloc(0);
    let settled = false;
    const finish = (error?: Error, value?: unknown) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      if (error) reject(error);
      else resolve(value);
    };
    const timer = setTimeout(
      () => finish(new NativeBridgeError("Desktop request timed out")),
      timeoutMs,
    );
    socket.once("connect", () =>
      socket.write(`${JSON.stringify({ ...request, nonce })}\n`),
    );
    socket.on("data", (chunk: Buffer) => {
      if (received.length + chunk.length > NATIVE_MESSAGE_MAX_BYTES)
        return finish(new NativeBridgeError("Invalid desktop response"));
      received = Buffer.concat([received, chunk]);
      const newline = received.indexOf(10);
      if (newline === -1) return;
      let parsed: unknown;
      try {
        parsed = JSON.parse(received.subarray(0, newline).toString("utf8"));
      } catch {
        return finish(new NativeBridgeError("Invalid desktop response"));
      }
      const response = z.object({ nonce: z.literal(nonce) }).safeParse(parsed);
      if (!response.success)
        return finish(new NativeBridgeError("Desktop response did not match"));
      finish(undefined, parsed);
    });
    socket.once("error", () =>
      finish(new NativeBridgeError("HoshiStream app is not available")),
    );
    socket.once("close", () =>
      finish(new NativeBridgeError("Desktop connection closed")),
    );
  });
}

// No media paths or other external input are interpolated into shell text.
export const WINDOWS_MOUNTS_SCRIPT = `
$ErrorActionPreference = 'Stop'
$roots = @([System.IO.DriveInfo]::GetDrives() | Where-Object {
  ($_.DriveType -eq [System.IO.DriveType]::Fixed -or
   $_.DriveType -eq [System.IO.DriveType]::Removable) -and $_.IsReady
} | ForEach-Object { $_.RootDirectory.FullName })
ConvertTo-Json -InputObject $roots -Compress
`;

export function windowsPowerShellPath(): string {
  return win32.join(
    process.env.SystemRoot ?? "C:\\Windows",
    "System32",
    "WindowsPowerShell",
    "v1.0",
    "powershell.exe",
  );
}

// Windows PowerShell 5.1 must not inherit PSModulePath from a PowerShell 7
// parent (pwsh terminals, GitHub runners): it would try to load the PS 7 module
// builds and fail with CouldNotAutoloadMatchingModule. Mirrors
// scripts/private-files.mjs, which src/ cannot import.
export function windowsPowerShellEnvironment(): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (key.toLowerCase() !== "psmodulepath") environment[key] = value;
  }
  return environment;
}

const mountRootsSchema = z.array(z.string().regex(/^[a-z]:\\$/i)).max(26);

export function parseWindowsMounts(stdout: string): string[] {
  return [
    ...new Set(
      mountRootsSchema
        .parse(JSON.parse(stdout.replace(/^\uFEFF/, "")))
        .map((root) => root.toUpperCase()),
    ),
  ];
}

export async function enumerateWindowsMounts(
  run: (
    file: string,
    args: string[],
    options: {
      timeout: number;
      maxBuffer: number;
      windowsHide: boolean;
      encoding: "utf8";
      env: NodeJS.ProcessEnv;
    },
  ) => Promise<{ stdout: string }> = execFileAsync,
): Promise<string[]> {
  const { stdout } = await run(
    windowsPowerShellPath(),
    [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      WINDOWS_MOUNTS_SCRIPT,
    ],
    {
      timeout: 5_000,
      maxBuffer: 8_192,
      windowsHide: true,
      encoding: "utf8",
      env: windowsPowerShellEnvironment(),
    },
  );
  return parseWindowsMounts(stdout);
}
