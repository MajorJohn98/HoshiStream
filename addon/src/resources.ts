// Resource usage for the status page (ADR 0004 trusted-LAN surface): CPU and
// memory of the add-on, TorrServer, and active ffmpeg repair sessions via a
// single `ps` call, plus cache directory sizes. No new dependencies; on
// Windows uses the same-user tray's owned-process collector, never a system-wide
// command-line scan. Terminal launches report process statistics unavailable.
import { execFile } from "node:child_process";
import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { z } from "zod";
import { nativeBridgeRequest } from "./windows-platform.ts";

const execFileAsync = promisify(execFile);

export interface ProcessStats {
  cpuPercent: number;
  rssBytes: number;
  processes: number;
}

export interface ProcessRow {
  pid: number;
  ppid: number;
  rssBytes: number;
  cpuPercent: number;
  command: string;
}

export function parsePsOutput(stdout: string): ProcessRow[] {
  return stdout
    .split("\n")
    .slice(1)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const match = /^(\d+)\s+(\d+)\s+(\d+)\s+([\d.]+)\s+(.+)$/.exec(line);
      if (!match) return undefined;
      return {
        pid: Number(match[1]),
        ppid: Number(match[2]),
        rssBytes: Number(match[3]) * 1024,
        cpuPercent: Number(match[4]),
        command: match[5],
      };
    })
    .filter((row): row is ProcessRow => row !== undefined);
}

function sum(rows: ProcessRow[]): ProcessStats {
  return {
    cpuPercent: Number(
      rows.reduce((total, row) => total + row.cpuPercent, 0).toFixed(1),
    ),
    rssBytes: rows.reduce((total, row) => total + row.rssBytes, 0),
    processes: rows.length,
  };
}

// Groups the process table into the three things HoshiStream runs: this
// add-on process, TorrServer (a child when the supervisor imports the add-on
// in-process, a sibling in older layouts), and any ffmpeg repair sessions
// spawned by the add-on.
export function groupProcesses(
  rows: ProcessRow[],
  self: { pid: number; ppid: number },
): { addon: ProcessStats; torrServer: ProcessStats; ffmpeg: ProcessStats } {
  const addon = rows.filter((row) => row.pid === self.pid);
  const torrServer = rows.filter(
    (row) =>
      row.command.includes("TorrServer") &&
      (row.ppid === self.pid || row.ppid === self.ppid || self.ppid <= 1),
  );
  const ffmpeg = rows.filter(
    (row) => row.ppid === self.pid && row.command.includes("ffmpeg"),
  );
  return {
    addon: sum(addon),
    torrServer: sum(torrServer),
    ffmpeg: sum(ffmpeg),
  };
}

const processStatsSchema = z.object({
  cpuPercent: z.number().nonnegative(),
  rssBytes: z.number().int().nonnegative(),
  processes: z.number().int().nonnegative(),
});
const windowsResourcesSchema = z.object({
  processes: z.discriminatedUnion("available", [
    z.object({
      available: z.literal(true),
      addon: processStatsSchema.extend({
        processes: z.number().int().positive(),
      }),
      torrServer: processStatsSchema,
      ffmpeg: processStatsSchema,
    }),
    z.object({ available: z.literal(false) }),
  ]),
});

export async function processStats(
  options: {
    platform?: NodeJS.Platform;
    endpoint?: string;
    timeoutMs?: number;
  } = {},
): Promise<
  | { available: true; groups: ReturnType<typeof groupProcesses> }
  | { available: false }
> {
  if ((options.platform ?? process.platform) === "win32") {
    const endpoint = options.endpoint ?? process.env.NATIVE_PICKER_SOCKET;
    if (!endpoint) return { available: false };
    try {
      const raw = await nativeBridgeRequest(
        endpoint,
        { kind: "resources", pid: process.pid },
        options.timeoutMs ?? 2_000,
      );
      const response = windowsResourcesSchema.safeParse(raw);
      if (!response.success || !response.data.processes.available)
        return { available: false };
      const { available, ...groups } = response.data.processes;
      return { available, groups };
    } catch {
      // Explicit unavailable, not a fabricated zero-valued success.
      return { available: false };
    }
  }
  try {
    const { stdout } = await execFileAsync(
      "ps",
      ["-axo", "pid,ppid,rss,pcpu,comm"],
      { timeout: 5_000, maxBuffer: 5_000_000 },
    );
    return {
      available: true,
      groups: groupProcesses(parsePsOutput(stdout), {
        pid: process.pid,
        ppid: process.ppid,
      }),
    };
  } catch {
    return { available: false };
  }
}

export async function directorySizeBytes(root: string): Promise<number> {
  let total = 0;
  const pending = [root];
  while (pending.length) {
    const dir = pending.pop() as string;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) pending.push(path);
      else if (entry.isFile()) {
        try {
          total += (await stat(path)).size;
        } catch {
          // removed mid-walk
        }
      }
    }
  }
  return total;
}

export interface ResourceDirs {
  torrentCache: string;
  transcode: string;
  uploads: string;
}

interface DiskUsage {
  torrentCacheBytes: number;
  transcodeBytes: number;
  uploadsBytes: number;
}

// Directory walks are cheap for these trees but not free; refresh at most
// every 15 seconds.
let diskCache: { value: DiskUsage; expiresAt: number } | undefined;

export async function diskUsage(
  dirs: ResourceDirs,
  now = Date.now(),
): Promise<DiskUsage> {
  if (diskCache && diskCache.expiresAt > now) return diskCache.value;
  const [torrentCacheBytes, transcodeBytes, uploadsBytes] = await Promise.all([
    directorySizeBytes(dirs.torrentCache),
    directorySizeBytes(dirs.transcode),
    directorySizeBytes(dirs.uploads),
  ]);
  diskCache = {
    value: { torrentCacheBytes, transcodeBytes, uploadsBytes },
    expiresAt: now + 15_000,
  };
  return diskCache.value;
}

export function resetDiskCache(): void {
  diskCache = undefined;
}

export async function resourceReport(dirs: ResourceDirs) {
  const [stats, disk] = await Promise.all([processStats(), diskUsage(dirs)]);
  return {
    processes: stats.available
      ? { available: true, ...stats.groups }
      : { available: false },
    disk,
  };
}
