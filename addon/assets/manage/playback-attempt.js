export const STARTUP_SLOW_MS = 15_000;
export const PLAYBACK_WAIT_MS = 60_000;

export function browserContainerHint(video, technical) {
  const type = {
    mov: "video/mp4",
    mp4: "video/mp4",
    webm: "video/webm",
  }[technical?.container];
  // A shared Matroska/WebM demuxer name is not enough to choose a MIME type.
  return type ? video.canPlayType(type) || "unsupported" : "unknown";
}

export function playbackFailure(code) {
  if (code === 3 || code === 4)
    return {
      kind: "codec",
      message: "This browser could not decode the stream.",
    };
  if (code === 2)
    return {
      kind: "network",
      message:
        "The media request failed. Check this browser's connection to the stream.",
    };
  return { kind: "request", message: "The playback request was interrupted." };
}

export async function attachPlaybackSource(
  video,
  url,
  { signal, onFailure, loadHls = () => import("./vendor/hls.js") } = {},
) {
  if (signal?.aborted) return () => {};
  if (
    url.includes(".m3u8") &&
    !video.canPlayType("application/vnd.apple.mpegurl")
  ) {
    const { default: Hls } = await loadHls();
    if (signal?.aborted) return () => {};
    if (!Hls.isSupported())
      throw Object.assign(
        new Error("HLS playback is unavailable in this browser."),
        { kind: "codec" },
      );
    const hls = new Hls();
    let stopped = false;
    const onError = (_event, data) => {
      if (signal?.aborted || !data.fatal) return;
      onFailure(
        data.type === Hls.ErrorTypes.MEDIA_ERROR
          ? playbackFailure(3)
          : playbackFailure(2),
      );
    };
    hls.on(Hls.Events.ERROR, onError);
    const destroy = () => {
      if (stopped) return;
      stopped = true;
      signal?.removeEventListener("abort", destroy);
      hls.off(Hls.Events.ERROR, onError);
      hls.destroy();
    };
    signal?.addEventListener("abort", destroy, { once: true });
    try {
      hls.loadSource(url);
      hls.attachMedia(video);
    } catch (error) {
      destroy();
      throw error;
    }
    return destroy;
  }
  video.src = url;
  let stopped = false;
  const detach = () => {
    if (stopped) return;
    stopped = true;
    signal?.removeEventListener("abort", detach);
    video.removeAttribute("src");
    video.load();
  };
  signal?.addEventListener("abort", detach, { once: true });
  return detach;
}

export function createPlaybackAttempt(
  video,
  {
    onState,
    onFailure,
    onSlow,
    isCurrent = () => true,
    slowMs = STARTUP_SLOW_MS,
    waitMs = PLAYBACK_WAIT_MS,
    schedule = setTimeout,
    clear = clearTimeout,
  },
) {
  let stopped = false;
  let failed = false;
  let played = false;
  let blocked = false;
  let slowTimer;
  let deadline;
  const active = () => !stopped && isCurrent();
  const clearTimers = () => {
    clear(slowTimer);
    clear(deadline);
    slowTimer = deadline = undefined;
  };
  const state = (next) => {
    if (active() && !failed) onState(next);
  };
  const fail = (error) => {
    if (!active() || failed) return;
    failed = true;
    clearTimers();
    video.pause();
    onState("error");
    onFailure(error);
  };
  const arm = () => {
    if (!active() || failed || deadline !== undefined || blocked) return;
    slowTimer = schedule(() => {
      if (!active() || failed || blocked) return;
      if (!played) state("slow-start");
      onSlow();
    }, slowMs);
    deadline = schedule(
      () =>
        fail({
          kind: "timeout",
          message:
            "The stream did not become ready within this attempt's waiting limit. Its availability is still uncertain.",
        }),
      waitMs,
    );
  };
  const playing = () => {
    if (!active() || video.paused || video.seeking) return;
    played = true;
    blocked = false;
    clearTimers();
    state("playing");
  };
  const ready = () => {
    clearTimers();
    state(blocked ? "awaiting-play" : video.paused ? "ready" : "buffering");
    if (!video.paused) arm();
  };
  const listeners = {
    loadedmetadata: () => state("metadata"),
    canplay: ready,
    seeked: ready,
    playing,
    pause: () => {
      clearTimers();
      state(blocked ? "awaiting-play" : "paused");
    },
    play: () => {
      blocked = false;
      state("buffering");
      arm();
    },
    waiting: () => {
      state("buffering");
      arm();
    },
    seeking: () => {
      state("buffering");
      arm();
    },
    error: () => fail(playbackFailure(video.error?.code)),
  };
  for (const [name, listener] of Object.entries(listeners))
    video.addEventListener(name, listener);
  state("loading-media");
  arm();
  return {
    fail,
    async play({ retry = false } = {}) {
      if (!active() || (failed && !retry)) return;
      failed = false;
      blocked = false;
      arm();
      try {
        await video.play();
      } catch (error) {
        if (!active() || error.name === "AbortError") return;
        if (error.name === "NotAllowedError") {
          blocked = true;
          clearTimers();
          state("awaiting-play");
        } else {
          fail(
            error.name === "NotSupportedError"
              ? playbackFailure(4)
              : playbackFailure(2),
          );
        }
      }
    },
    stop() {
      stopped = true;
      clearTimers();
      for (const [name, listener] of Object.entries(listeners))
        video.removeEventListener(name, listener);
    },
  };
}
