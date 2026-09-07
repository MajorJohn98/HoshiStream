import { beforeEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { probeMedia, summarizeProbe } from "../src/media-probe.ts";

const execute = vi.hoisted(() => vi.fn());
vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return {
    ...actual,
    execFile: Object.assign(vi.fn(), {
      [Symbol.for("nodejs.util.promisify.custom")]: execute,
    }),
  };
});

beforeEach(() => {
  execute.mockReset();
});

describe("media probe summary", () => {
  it("calculates a recommended speed with 50% headroom", () => {
    const summary = summarizeProbe(
      {
        format: { duration: "100", bit_rate: "4000000", format_name: "mp4" },
        streams: [
          {
            codec_type: "video",
            codec_name: "hevc",
            width: 1920,
            height: 1080,
          },
          { codec_type: "audio", codec_name: "aac" },
        ],
      },
      50_000_000,
    );
    expect(summary).toMatchObject({
      bitrateMbps: 4,
      recommendedMbps: 6,
      videoCodec: "hevc",
      audioCodec: "aac",
      width: 1920,
      height: 1080,
    });
  });

  describe("bounded frame evidence", () => {
    const file = { id: 1, length: 1000 };
    const metadata = {
      format: { format_name: "mov,mp4,m4a,3gp,3g2,mj2", duration: "2" },
      streams: [
        {
          index: 0,
          codec_type: "video",
          codec_name: "h264",
          profile: "Main",
          level: 31,
          pix_fmt: "yuv420p",
          codec_tag_string: "avc1",
          width: 160,
          height: 90,
        },
      ],
    };

    it("requires a decoded frame, not merely a codec in an MP4 header", async () => {
      execute.mockResolvedValue({ stdout: JSON.stringify(metadata) });
      await expect(
        probeMedia("http://127.0.0.1:1/fixture", file, { bounded: true }),
      ).rejects.toMatchObject({
        code: "sample_unreadable",
        technical: { videoCodec: "h264", pixelFormat: "yuv420p" },
      });
    });

    it("returns scoped frame evidence and preserves codec details", async () => {
      execute.mockResolvedValue({
        stdout: JSON.stringify({
          ...metadata,
          frames: [{ media_type: "video", stream_index: 0 }],
        }),
      });
      const signal = new AbortController().signal;
      await expect(
        probeMedia("http://127.0.0.1:1/fixture", file, {
          bounded: true,
          timeoutMs: 20_000,
          signal,
        }),
      ).resolves.toMatchObject({
        decodedVideoFrames: 1,
        containerAliases: ["mov", "mp4", "m4a", "3gp", "3g2", "mj2"],
        videoProfile: "Main",
        videoLevel: 31,
        pixelFormat: "yuv420p",
        videoTag: "avc1",
        audioTracks: 0,
      });
      const [, args, options] = execute.mock.calls[0];
      expect(args).toContain("-show_frames");
      expect(args).toContain("%+#64");
      expect(args[args.indexOf("-rw_timeout") + 1]).toBe("20000000");
      expect(options).toMatchObject({
        timeout: 20_000,
        signal,
        killSignal: "SIGKILL",
      });
    });

    it("does not count cover artwork or audio frames as sampled video", async () => {
      execute.mockResolvedValue({
        stdout: JSON.stringify({
          ...metadata,
          streams: [
            {
              index: 1,
              codec_type: "video",
              codec_name: "mjpeg",
              disposition: { attached_pic: 1 },
            },
            ...metadata.streams,
          ],
          frames: [
            { media_type: "video", stream_index: 1 },
            { media_type: "audio", stream_index: 2 },
          ],
        }),
      });
      await expect(probeMedia("fixture", file)).rejects.toMatchObject({
        code: "sample_unreadable",
        technical: { videoCodec: "h264", decodedVideoFrames: 0 },
      });
    });

    it("keeps absence of video, invalid responses and missing tooling distinct", async () => {
      execute.mockResolvedValueOnce({ stdout: "{}" });
      await expect(probeMedia("fixture", file)).rejects.toMatchObject({
        code: "no_video",
      });
      execute.mockResolvedValueOnce({ stdout: "invalid json" });
      await expect(probeMedia("fixture", file)).rejects.toMatchObject({
        code: "probe_response",
      });
      execute.mockRejectedValueOnce(
        Object.assign(new Error("private detail"), { code: "ENOENT" }),
      );
      await expect(probeMedia("fixture", file)).rejects.toMatchObject({
        code: "probe_unavailable",
      });
    });

    it("sanitizes read timeouts and does not start a cancelled probe", async () => {
      execute.mockRejectedValueOnce(
        Object.assign(new Error("private input"), {
          stderr: "private URL: Connection timed out",
        }),
      );
      await expect(probeMedia("fixture", file)).rejects.toMatchObject({
        code: "probe_timeout",
        message: "Timed out reading the video sample",
      });
      execute.mockClear();
      await expect(
        probeMedia("fixture", file, { signal: AbortSignal.abort() }),
      ).rejects.toMatchObject({ code: "cancelled" });
      expect(execute).not.toHaveBeenCalled();
    });

    it("waits for child close after an abort rejection before releasing the caller", async () => {
      const child = new EventEmitter();
      const controller = new AbortController();
      execute.mockImplementation(() => {
        controller.abort();
        return Object.assign(Promise.reject(new Error("aborted")), { child });
      });
      let settled = false;
      const pending = probeMedia("fixture", file, {
        signal: controller.signal,
      }).catch((error) => {
        settled = true;
        return error;
      });
      await Promise.resolve();
      await Promise.resolve();
      expect(settled).toBe(false);
      child.emit("close");
      await expect(pending).resolves.toMatchObject({ code: "cancelled" });
    });
  });

  it("does not publish non-finite or negative probe measurements", () => {
    const summary = summarizeProbe(
      {
        format: { duration: "Infinity", bit_rate: "Infinity" },
        streams: [{ codec_type: "video", width: 0, height: 0 }],
      },
      100,
    );
    expect(summary.durationSeconds).toBeUndefined();
    expect(summary.bitrateMbps).toBeUndefined();
    expect(summary.width).toBeUndefined();
    expect(summary.height).toBeUndefined();
  });
});
