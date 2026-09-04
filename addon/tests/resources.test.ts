import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  directorySizeBytes,
  diskUsage,
  groupProcesses,
  parsePsOutput,
  resetDiskCache,
} from "../src/resources.ts";

const PS_FIXTURE = `  PID  PPID    RSS  %CPU COMM
  100     1  10240   1.5 /usr/bin/something
  200   150  51200   4.2 node
  201   150 204800  12.0 /app/vendor/torrserver/darwin-arm64/TorrServer
  300   200  81920  55.3 /app/vendor/ffmpeg/darwin-arm64/ffmpeg
  301   200  40960  20.1 /app/vendor/ffmpeg/darwin-arm64/ffmpeg
  400     1  12345   0.5 ffmpeg
`;

describe("parsePsOutput", () => {
  it("parses pid, ppid, rss (KiB to bytes), cpu, and command", () => {
    const rows = parsePsOutput(PS_FIXTURE);
    expect(rows).toHaveLength(6);
    expect(rows[1]).toEqual({
      pid: 200,
      ppid: 150,
      rssBytes: 51200 * 1024,
      cpuPercent: 4.2,
      command: "node",
    });
  });

  it("skips malformed lines", () => {
    expect(parsePsOutput("PID\ngarbage line here\n")).toEqual([]);
  });
});

describe("groupProcesses", () => {
  const rows = parsePsOutput(PS_FIXTURE);
  const groups = groupProcesses(rows, { pid: 200, ppid: 150 });

  it("finds the add-on by its own pid", () => {
    expect(groups.addon.processes).toBe(1);
    expect(groups.addon.rssBytes).toBe(51200 * 1024);
  });

  it("finds TorrServer as a child of the add-on process", () => {
    // The supervisor imports the add-on in-process, so TorrServer's parent
    // is the add-on pid itself.
    const childRows = parsePsOutput(
      `  PID  PPID    RSS  %CPU COMM
  200   150  51200   4.2 node
  201   200 204800  12.0 /app/vendor/torrserver/darwin-arm64/TorrServer
`,
    );
    const childGroups = groupProcesses(childRows, { pid: 200, ppid: 150 });
    expect(childGroups.torrServer.processes).toBe(1);
  });

  it("finds TorrServer as a sibling under the same supervisor", () => {
    expect(groups.torrServer.processes).toBe(1);
    expect(groups.torrServer.cpuPercent).toBe(12);
  });

  it("sums only ffmpeg children of the add-on, not unrelated ffmpeg", () => {
    expect(groups.ffmpeg.processes).toBe(2);
    expect(groups.ffmpeg.cpuPercent).toBe(75.4);
    expect(groups.ffmpeg.rssBytes).toBe((81920 + 40960) * 1024);
  });
});

describe("disk usage", () => {
  let dir: string;

  afterEach(async () => {
    resetDiskCache();
    await rm(dir, { recursive: true, force: true });
  });

  it("sizes directories recursively and tolerates missing paths", async () => {
    dir = await mkdtemp(join(tmpdir(), "hoshi-res-"));
    await mkdir(join(dir, "nested"), { recursive: true });
    await writeFile(join(dir, "a.bin"), Buffer.alloc(1000));
    await writeFile(join(dir, "nested", "b.bin"), Buffer.alloc(500));
    expect(await directorySizeBytes(dir)).toBe(1500);
    expect(await directorySizeBytes(join(dir, "missing"))).toBe(0);
  });

  it("caches results between calls within the TTL", async () => {
    dir = await mkdtemp(join(tmpdir(), "hoshi-res-"));
    resetDiskCache();
    const dirs = { torrentCache: dir, transcode: dir, uploads: dir };
    const first = await diskUsage(dirs);
    await writeFile(join(dir, "later.bin"), Buffer.alloc(2000));
    const cached = await diskUsage(dirs);
    expect(cached).toEqual(first);
    const refreshed = await diskUsage(dirs, Date.now() + 60_000);
    expect(refreshed.torrentCacheBytes).toBe(2000);
  });
});
