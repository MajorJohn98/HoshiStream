import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  TranscodeBusyError,
  TranscodeManager,
  ffmpegArgs,
  repairDescription,
  repairTier,
} from "../src/transcode.ts";

describe("repairTier", () => {
  it("chooses the audio tier for risky audio codecs", () => {
    expect(repairTier({ audioCodec: "dts" })).toBe("audio");
    expect(repairTier({ audioCodec: "TrueHD", container: "matroska" })).toBe(
      "audio",
    );
  });

  it("chooses a remux for TV-hostile containers with fine codecs", () => {
    expect(repairTier({ container: "matroska", audioCodec: "aac" })).toBe(
      "remux",
    );
    expect(repairTier({ container: "avi" })).toBe("remux");
  });

  it("returns no tier for direct-playable media or missing verdicts", () => {
    expect(repairTier({ container: "mov", audioCodec: "aac" })).toBeUndefined();
    expect(repairTier(undefined)).toBeUndefined();
  });
});

describe("ffmpegArgs", () => {
  it("copies both streams for a remux", () => {
    const args = ffmpegArgs("remux", "http://127.0.0.1:8090/play/x/1");
    expect(args).toContain("copy");
    expect(args).not.toContain("ac3");
    expect(args.join(" ")).toContain("-f hls");
    expect(args.join(" ")).toContain("-hls_segment_type fmp4");
  });

  it("re-encodes only the audio for the audio tier", () => {
    const args = ffmpegArgs("audio", "/media/movie.mkv").join(" ");
    expect(args).toContain("-c:v copy");
    expect(args).toContain("-c:a ac3");
  });

  it("emits only session-relative output paths", () => {
    const args = ffmpegArgs("remux", "/media/movie.mkv");
    expect(args.at(-1)).toBe("index.m3u8");
    expect(args).toContain("init.mp4");
    expect(args).toContain("seg-%d.m4s");
  });
});

describe("repairDescription", () => {
  it("labels both tiers", () => {
    expect(repairDescription("audio")).toContain("AC3");
    expect(repairDescription("remux")).toContain("container");
  });
});

class FakeProcess extends EventEmitter {
  killed: string | undefined;
  kill(signal?: string) {
    this.killed = signal ?? "SIGTERM";
    return true;
  }
}

describe("TranscodeManager", () => {
  let dir: string;
  let spawned: Array<{ command: string; args: string[]; cwd: string }>;
  let processes: FakeProcess[];
  let manager: TranscodeManager;

  const makeManager = (maxSessions = 2) =>
    new TranscodeManager({
      dir,
      ffmpegPath: "/vendor/ffmpeg",
      maxSessions,
      spawnFn: (command, args, options) => {
        spawned.push({ command, args, cwd: options.cwd });
        const child = new FakeProcess();
        processes.push(child);
        return child as unknown as ChildProcess;
      },
    });

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "hoshi-transcode-"));
    spawned = [];
    processes = [];
    manager = makeManager();
    await manager.start();
  });

  afterEach(async () => {
    await manager.close();
    await rm(dir, { recursive: true, force: true });
  });

  it("sweeps leftover session directories at startup", async () => {
    await manager.close();
    await writeFile(join(dir, "stale.m4s"), "x");
    manager = makeManager();
    await manager.start();
    expect(await readdir(dir)).toEqual([]);
  });

  it("spawns ffmpeg once per entry/file and reuses the session", async () => {
    const first = await manager.ensure({
      entryId: "hoshi:one",
      fileId: 1,
      variant: "auto",
      tier: "remux",
      input: "http://127.0.0.1:8090/play/h/1",
    });
    const again = await manager.ensure({
      entryId: "hoshi:one",
      fileId: 1,
      variant: "auto",
      tier: "remux",
      input: "http://127.0.0.1:8090/play/h/1",
    });
    expect(again.id).toBe(first.id);
    expect(spawned).toHaveLength(1);
    expect(spawned[0].command).toBe("/vendor/ffmpeg");
    expect(spawned[0].cwd).toBe(first.dir);
    expect(manager.get("hoshi:one", 1)?.id).toBe(first.id);
  });

  it("enforces the session cap", async () => {
    await manager.ensure({
      entryId: "a",
      fileId: 0,
      variant: "auto",
      tier: "remux",
      input: "x",
    });
    await manager.ensure({
      entryId: "b",
      fileId: 0,
      variant: "auto",
      tier: "remux",
      input: "x",
    });
    await expect(
      manager.ensure({
        entryId: "c",
        fileId: 0,
        variant: "auto",
        tier: "remux",
        input: "x",
      }),
    ).rejects.toBeInstanceOf(TranscodeBusyError);
  });

  it("serves playlist and segments only from the allowlist", async () => {
    const session = await manager.ensure({
      entryId: "a",
      fileId: 0,
      variant: "auto",
      tier: "remux",
      input: "x",
    });
    await writeFile(join(session.dir, "index.m3u8"), "#EXTM3U");
    await writeFile(join(session.dir, "init.mp4"), "init");
    expect(String(await manager.readAsset(session, "index.m3u8"))).toBe(
      "#EXTM3U",
    );
    expect(
      await manager.readAsset(session, "../../etc/passwd"),
    ).toBeUndefined();
    expect(await manager.readAsset(session, "seg-0.m4s")).toBeUndefined();
  });

  it("waits for the playlist and init segment to appear", async () => {
    const session = await manager.ensure({
      entryId: "a",
      fileId: 0,
      variant: "auto",
      tier: "remux",
      input: "x",
    });
    const wait = manager.waitForPlaylist(session, 2_000);
    await writeFile(join(session.dir, "index.m3u8"), "#EXTM3U");
    await writeFile(join(session.dir, "init.mp4"), "init");
    await expect(wait).resolves.toBeUndefined();
  });

  it("fails the wait when ffmpeg exits with an error", async () => {
    const session = await manager.ensure({
      entryId: "a",
      fileId: 0,
      variant: "auto",
      tier: "remux",
      input: "x",
    });
    const wait = manager.waitForPlaylist(session, 5_000);
    processes[0].emit("exit", 1);
    await expect(wait).rejects.toThrow("failed to start");
    // A later request replaces the failed session with a fresh one.
    const retry = await manager.ensure({
      entryId: "a",
      fileId: 0,
      variant: "auto",
      tier: "remux",
      input: "x",
    });
    expect(retry.id).not.toBe(session.id);
    expect(spawned).toHaveLength(2);
  });

  it("reaps idle sessions, kills ffmpeg, and deletes the directory", async () => {
    const session = await manager.ensure({
      entryId: "a",
      fileId: 0,
      variant: "auto",
      tier: "remux",
      input: "x",
    });
    await manager.reap(Date.now() + 120_000);
    expect(processes[0].killed).toBe("SIGTERM");
    expect(manager.get("a", 0)).toBeUndefined();
    expect(await readdir(dir)).toEqual([]);
    expect(session.dir).toContain(dir);
  });

  it("keeps recently touched sessions alive", async () => {
    const session = await manager.ensure({
      entryId: "a",
      fileId: 0,
      variant: "auto",
      tier: "remux",
      input: "x",
    });
    manager.touch(session);
    await manager.reap(Date.now() + 30_000);
    expect(manager.get("a", 0)).toBeDefined();
  });
});

describe("video tier", () => {
  it("repairTier prefers a video re-encode for undecodable codecs", () => {
    expect(repairTier({ videoCodec: "av1", audioCodec: "dts" })).toBe("video");
    expect(repairTier({ videoCodec: "vc1" })).toBe("video");
    expect(repairTier({ videoCodec: "h264", audioCodec: "dts" })).toBe("audio");
  });

  it("ffmpegArgs uses the hardware encoder and AAC audio", () => {
    const args = ffmpegArgs("video", "/media/movie.mkv", {
      encoder: "h264_videotoolbox",
      bitrateMbps: 8,
    }).join(" ");
    expect(args).toContain("-c:v h264_videotoolbox");
    expect(args).toContain("-b:v 8000k");
    expect(args).toContain("-c:a aac");
    expect(args).not.toContain("libx264");
  });

  it("repairDescription labels the video tier", () => {
    expect(repairDescription("video")).toContain("re-encoded");
  });
});

describe("video sessions", () => {
  it("refuses tier V without a hardware encoder and allows it with one", async () => {
    const dir = await mkdtemp(join(tmpdir(), "hoshi-videotier-"));
    const spawnFn = () => new FakeProcess() as unknown as ChildProcess;
    const without = new TranscodeManager({
      dir,
      ffmpegPath: "ffmpeg",
      maxSessions: 4,
      spawnFn,
    });
    await without.start();
    await expect(
      without.ensure({
        entryId: "a",
        fileId: 0,
        variant: "video",
        tier: "video",
        input: "x",
      }),
    ).rejects.toThrow("video encoder");
    await without.close();

    const withEncoder = new TranscodeManager({
      dir,
      ffmpegPath: "ffmpeg",
      maxSessions: 4,
      videoEncoder: "h264_videotoolbox",
      spawnFn,
    });
    await withEncoder.start();
    const auto = await withEncoder.ensure({
      entryId: "a",
      fileId: 0,
      variant: "auto",
      tier: "remux",
      input: "x",
    });
    const video = await withEncoder.ensure({
      entryId: "a",
      fileId: 0,
      variant: "video",
      tier: "video",
      input: "x",
    });
    // Same entry/file, separate sessions per variant.
    expect(video.id).not.toBe(auto.id);
    expect(withEncoder.get("a", 0, "video")?.id).toBe(video.id);
    expect(await withEncoder.removeAll("a", 0)).toBe(2);
    await withEncoder.close();
    await rm(dir, { recursive: true, force: true });
  });
});
