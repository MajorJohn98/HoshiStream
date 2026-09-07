import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  attachPlaybackSource,
  browserContainerHint,
  createPlaybackAttempt,
} from "../assets/manage/playback-attempt.js";

class Video extends EventTarget {
  currentTime = 0;
  readyState = 0;
  paused = true;
  seeking = false;
  src = "";
  error: { code: number } | null = null;
  play = vi.fn(async () => {
    this.paused = false;
    this.dispatchEvent(new Event("play"));
  });
  pause = vi.fn(() => {
    this.paused = true;
    this.dispatchEvent(new Event("pause"));
  });
  canPlayType = vi.fn(() => "");
  removeAttribute = vi.fn(() => {
    this.src = "";
  });
  load = vi.fn();
}

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

function setup() {
  const video = new Video();
  const onState = vi.fn();
  const onFailure = vi.fn();
  const onSlow = vi.fn();
  const attempt = createPlaybackAttempt(video, { onState, onFailure, onSlow });
  return { video, attempt, onState, onFailure, onSlow };
}

describe("browser playback evidence and recovery", () => {
  it("uses container capability only as a local hint and preserves demuxer uncertainty", () => {
    const video = new Video();
    expect(browserContainerHint(video, { container: "matroska" })).toBe(
      "unknown",
    );
    expect(video.canPlayType).not.toHaveBeenCalled();
    expect(browserContainerHint(video, { container: "mov" })).toBe(
      "unsupported",
    );
    expect(video.src).toBe("");
    video.canPlayType.mockReturnValue("probably");
    expect(browserContainerHint(video, { container: "mp4" })).toBe("probably");
  });
  it("reports slow startup without assuming a codec error and eventually offers recovery", async () => {
    const { attempt, onSlow, onFailure, onState } = setup();
    await vi.advanceTimersByTimeAsync(15_000);
    expect(onSlow).toHaveBeenCalledOnce();
    expect(onState).toHaveBeenLastCalledWith("slow-start");
    expect(onFailure).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(45_000);
    expect(onFailure).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "timeout" }),
    );
    expect(onState).toHaveBeenLastCalledWith("error");
    attempt.stop();
  });

  it("does not equate metadata, ready, seeked, or the play promise with playing", async () => {
    const { video, attempt, onState } = setup();
    video.dispatchEvent(new Event("loadedmetadata"));
    expect(onState).toHaveBeenLastCalledWith("metadata");
    video.dispatchEvent(new Event("canplay"));
    expect(onState).toHaveBeenLastCalledWith("ready");
    await attempt.play();
    video.dispatchEvent(new Event("seeked"));
    expect(onState).toHaveBeenLastCalledWith("buffering");
    expect(onState.mock.calls.flat()).not.toContain("playing");
    video.dispatchEvent(new Event("playing"));
    expect(onState).toHaveBeenLastCalledWith("playing");
    attempt.stop();
  });

  it("treats autoplay blocking as requiring a gesture, not unsupported media", async () => {
    const { video, attempt, onFailure, onState } = setup();
    video.play.mockRejectedValueOnce(
      Object.assign(new Error("blocked"), { name: "NotAllowedError" }),
    );
    await attempt.play();
    expect(onState).toHaveBeenLastCalledWith("awaiting-play");
    await vi.advanceTimersByTimeAsync(120_000);
    expect(onFailure).not.toHaveBeenCalled();
    await attempt.play();
    video.dispatchEvent(new Event("playing"));
    expect(onState).toHaveBeenLastCalledWith("playing");
    attempt.stop();
  });

  it("allows an explicit longer wait while retaining the current source", async () => {
    const { video, attempt, onState } = setup();
    video.src = "http://localhost/fixture.mp4";
    await vi.advanceTimersByTimeAsync(60_000);
    await attempt.play({ retry: true });
    video.dispatchEvent(new Event("playing"));
    expect(video.src).toBe("http://localhost/fixture.mp4");
    expect(onState).toHaveBeenLastCalledWith("playing");
    attempt.stop();
  });

  it("does not restart a failed source from a late attachment completion", async () => {
    const { video, attempt } = setup();
    attempt.fail({ kind: "codec", message: "Unsupported" });
    await attempt.play();
    expect(video.play).not.toHaveBeenCalled();
    attempt.stop();
  });

  it("distinguishes decode failures from network failures", () => {
    for (const [code, kind] of [
      [3, "codec"],
      [4, "codec"],
      [2, "network"],
    ] as const) {
      const { video, attempt, onFailure } = setup();
      video.error = { code };
      video.dispatchEvent(new Event("error"));
      expect(onFailure).toHaveBeenCalledWith(expect.objectContaining({ kind }));
      attempt.stop();
    }
  });

  it("ignores late media events and autoplay completion from stopped attempts", async () => {
    const { video, attempt, onState, onFailure, onSlow } = setup();
    let reject!: (error: Error) => void;
    video.play.mockImplementationOnce(
      () =>
        new Promise((_resolve, fail) => {
          reject = fail;
        }),
    );
    const pending = attempt.play();
    attempt.stop();
    onState.mockClear();
    video.dispatchEvent(new Event("playing"));
    reject(Object.assign(new Error("old"), { name: "NotAllowedError" }));
    await pending;
    await vi.advanceTimersByTimeAsync(120_000);
    expect(onState).not.toHaveBeenCalled();
    expect(onFailure).not.toHaveBeenCalled();
    expect(onSlow).not.toHaveBeenCalled();
  });
});

describe("HLS lifecycle", () => {
  class Hls {
    static Events = { ERROR: "error" };
    static ErrorTypes = {
      MEDIA_ERROR: "mediaError",
      NETWORK_ERROR: "networkError",
    };
    static isSupported() {
      return true;
    }
    static latest: Hls;
    handlers = new Map<
      string,
      (event: string, data: { fatal: boolean; type: string }) => void
    >();
    destroy = vi.fn();
    loadSource = vi.fn();
    attachMedia = vi.fn();
    on(
      name: string,
      handler: (event: string, data: { fatal: boolean; type: string }) => void,
    ) {
      this.handlers.set(name, handler);
    }
    off(name: string) {
      this.handlers.delete(name);
    }
    constructor() {
      Hls.latest = this;
    }
  }

  it("surfaces fatal HLS errors and removes listeners on abort", async () => {
    const video = new Video();
    const onFailure = vi.fn();
    const controller = new AbortController();
    const detach = await attachPlaybackSource(video, "/fixture.m3u8", {
      signal: controller.signal,
      onFailure,
      loadHls: async () => ({ default: Hls }),
    });
    const hls = Hls.latest;
    hls.handlers.get("error")?.("error", { fatal: false, type: "mediaError" });
    expect(onFailure).not.toHaveBeenCalled();
    hls.handlers.get("error")?.("error", { fatal: true, type: "mediaError" });
    expect(onFailure).toHaveBeenLastCalledWith(
      expect.objectContaining({ kind: "codec" }),
    );
    hls.handlers.get("error")?.("error", { fatal: true, type: "networkError" });
    expect(onFailure).toHaveBeenLastCalledWith(
      expect.objectContaining({ kind: "network" }),
    );
    controller.abort();
    detach();
    expect(hls.destroy).toHaveBeenCalledOnce();
    expect(hls.handlers.size).toBe(0);
  });

  it("does not attach a superseded asynchronously loaded HLS source", async () => {
    const video = new Video();
    const controller = new AbortController();
    let finish!: (value: { default: typeof Hls }) => void;
    const pending = attachPlaybackSource(video, "/fixture.m3u8", {
      signal: controller.signal,
      onFailure: vi.fn(),
      loadHls: () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    });
    controller.abort();
    finish({ default: Hls });
    await pending;
    expect(video.src).toBe("");
  });
});
