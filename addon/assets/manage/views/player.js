// In-browser player (#/play/{entryId}/{fileId}) with custom cinema chrome:
// top bar (back, title, quality / speed / audio & subtitles menus), a
// draggable scrubber with hover time, transport controls, next-episode and
// episode picker for series, picture-in-picture, fullscreen, keyboard
// shortcuts, and auto-hiding controls. Plays the same stream URLs Stremio
// clients receive: MP4-class sources natively, HLS repair sessions via hls.js.
//
// Resume position lives on the server (entry.playback) so any browser or the
// host player continues where the last one stopped; localStorage is only a
// fallback for the seconds between saves.
import { html, useEffect, useRef, useState } from "../vendor/preact-htm.js";
import { api, token } from "../api.js";
import { load, useStore } from "../store.js";

const SAVE_INTERVAL_MS = 10_000;
const RESUME_MIN_SECONDS = 15;
// Within this many seconds of the end, the title counts as finished.
const FINISHED_TAIL_SECONDS = 45;
const UP_NEXT_SECONDS = 30;
// A source that has produced no metadata after this long is treated as
// undecodable and the next quality is tried.
const STALL_MS = 15_000;
const SPEEDS = [0.75, 1, 1.25, 1.5, 2];

function params() {
  const match = /^#\/play\/([^/]+)(?:\/(\d+))?/.exec(location.hash);
  return match
    ? {
        entryId: decodeURIComponent(match[1]),
        fileId: match[2] ? Number(match[2]) : undefined,
      }
    : undefined;
}

function episodeList(entry) {
  if (entry?.type !== "series") return [];
  return entry.inspectionCache?.selectedFiles ?? [];
}

function currentFile(entry, fileId) {
  const episodes = episodeList(entry);
  if (!episodes.length) return undefined;
  return (
    episodes.find((candidate) => candidate.id === fileId) ??
    episodes.find((candidate) => candidate.id === entry.playback?.fileId) ??
    episodes[0]
  );
}

function goEpisode(entryId, fileId) {
  location.hash = "#/play/" + encodeURIComponent(entryId) + "/" + fileId;
}

const positionKey = (entryId, fileId) =>
  `hoshi-position-${entryId}-${fileId ?? "auto"}`;
// The quality the viewer last picked for this title (e.g. "Compatible"),
// re-applied to every episode of it.
const qualityKey = (entryId) => `hoshi-quality-${entryId}`;

function episodeName(file) {
  if (!file) return "";
  const base = file.path
    .split("/")
    .pop()
    .replace(/\.[a-z0-9]+$/i, "");
  // "Show - S01E02 - Title (1080p ...)" → "Title"
  const match = /S\d+E\d+\s*[-–.]\s*([^([]+)/i.exec(base);
  return match ? match[1].replace(/[._]/g, " ").trim() : "";
}

function attachSource(video, url) {
  if (
    url.includes(".m3u8") &&
    !video.canPlayType("application/vnd.apple.mpegurl")
  ) {
    return import("../vendor/hls.js").then(({ default: Hls }) => {
      if (!Hls.isSupported()) throw new Error("HLS is not supported here");
      const hls = new Hls();
      hls.loadSource(url);
      hls.attachMedia(video);
      return () => hls.destroy();
    });
  }
  video.src = url;
  return Promise.resolve(() => {
    video.removeAttribute("src");
    video.load();
  });
}

// HLS repair sessions report an infinite duration while ffmpeg is still
// writing; the seekable range is the honest length so far.
function effectiveDuration(video) {
  if (Number.isFinite(video.duration) && video.duration > 0)
    return video.duration;
  const ranges = video.seekable;
  return ranges.length ? ranges.end(ranges.length - 1) : 0;
}

function clock(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return "–:––";
  const s = Math.floor(seconds % 60);
  const m = Math.floor((seconds / 60) % 60);
  const h = Math.floor(seconds / 3600);
  const mm = h ? String(m).padStart(2, "0") : String(m);
  return (h ? h + ":" : "") + mm + ":" + String(s).padStart(2, "0");
}

function runtime(seconds) {
  if (!Number.isFinite(seconds) || seconds <= 0) return "";
  const h = Math.floor(seconds / 3600);
  const m = Math.round((seconds % 3600) / 60);
  return h ? h + "h " + m + "m" : m + "m";
}

// Quality menu entries come from the stream variants the server offers
// (Direct / Compatible repair / Lower bitrate).
function qualityLabel(stream) {
  return stream.description.split("•")[0].trim();
}

// One consistent stroke icon set instead of glyphs and emoji.
const ICONS = {
  back: "M15 5l-7 7 7 7",
  play: "M7 4.5v15l12-7.5z",
  pause: "M7 5h3.5v14H7zM13.5 5H17v14h-3.5z",
  replay: "M12 5a7 7 0 1 0 7 7M12 5L9 2.5M12 5 9 7.5",
  forward: "M12 5a7 7 0 1 1-7 7M12 5l3-2.5M12 5l3 2.5",
  next: "M6 5l9 7-9 7zM17 5h2v14h-2z",
  volume:
    "M4 9.5v5h3l4 3.5v-12l-4 3.5zM15 9a4 4 0 0 1 0 6M17.5 6.5a7.5 7.5 0 0 1 0 11",
  muted: "M4 9.5v5h3l4 3.5v-12l-4 3.5zM15 9.5l5 5M20 9.5l-5 5",
  fullscreen: "M4 9V4h5M15 4h5v5M20 15v5h-5M9 20H4v-5",
  exitFullscreen: "M9 4v5H4M20 9h-5V4M15 20v-5h5M4 15h5v5",
  pip: "M3 5h18v14H3zM11 11h8v6h-8z",
  episodes: "M4 6h16M4 12h16M4 18h16",
  settings:
    "M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8zm8 4l-2.2-.7-.5-1.6 1.1-2-1.9-1.9-2 1.1-1.6-.5L12 4l-.7 2.2-1.6.5-2-1.1-1.9 1.9 1.1 2-.5 1.6L4 12l2.2.7.5 1.6-1.1 2 1.9 1.9 2-1.1 1.6.5L12 20l.7-2.2 1.6-.5 2 1.1 1.9-1.9-1.1-2 .5-1.6z",
  tracks: "M4 6h16v12H4zM7 14h6M7 10h10",
  speed: "M12 4a8 8 0 0 0-8 8h3M12 4a8 8 0 0 1 8 8h-3M12 12l4-4",
};
const FILLED = new Set(["play", "pause", "next"]);

function Icon({ name, size = 22 }) {
  return html`<svg
    viewBox="0 0 24 24"
    width=${size}
    height=${size}
    aria-hidden="true"
    fill=${FILLED.has(name) ? "currentColor" : "none"}
    stroke="currentColor"
    stroke-width="1.8"
    stroke-linecap="round"
    stroke-linejoin="round"
  >
    <path d=${ICONS[name]} />
  </svg>`;
}

function Menu({ label, icon, open, onToggle, children }) {
  return html`
    <div class="pl-menu-wrap">
      <button
        class="pl-menu-btn ${open ? "on" : ""}"
        aria-expanded=${open}
        aria-label=${label}
        title=${label}
        onClick=${onToggle}
      >
        <${Icon} name=${icon} size="19" />
        <span>${label}</span>
      </button>
      ${open ? html`<div class="pl-menu">${children}</div>` : null}
    </div>
  `;
}

function savePosition(entryId, body) {
  return api("library/" + encodeURIComponent(entryId) + "/playback", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  }).catch(() => undefined);
}

export function PlayerView() {
  const { entries } = useStore();
  const videoRef = useRef(null);
  const stageRef = useRef(null);
  const seekRef = useRef(null);
  const hideTimer = useRef(null);
  const [request, setRequest] = useState(params());
  const [streams, setStreams] = useState(null);
  const [active, setActive] = useState(0);
  const [error, setError] = useState("");
  const [paused, setPaused] = useState(true);
  const [waiting, setWaiting] = useState(false);
  const [time, setTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [buffered, setBuffered] = useState(0);
  const [volume, setVolume] = useState(
    Number(localStorage.getItem("hoshi-volume") ?? 1),
  );
  const [muted, setMuted] = useState(
    localStorage.getItem("hoshi-muted") === "true",
  );
  const [speed, setSpeed] = useState(1);
  const [chrome, setChrome] = useState(true);
  const [fullscreen, setFullscreen] = useState(false);
  const [menu, setMenu] = useState(null); // quality | speed | tracks | episodes
  const [tracks, setTracks] = useState({ audio: [], text: [] });
  const [hover, setHover] = useState(null); // { ratio }
  const [scrubbing, setScrubbing] = useState(false);
  const [resumedFrom, setResumedFrom] = useState(0);
  const [notice, setNotice] = useState("");
  const [upNextDismissed, setUpNextDismissed] = useState(false);
  const [autoNext, setAutoNext] = useState(
    localStorage.getItem("hoshi-autonext") !== "false",
  );
  const entry = entries.find((candidate) => candidate.id === request?.entryId);
  const file = currentFile(entry, request?.fileId);
  const episodes = episodeList(entry);
  const index = episodes.findIndex((episode) => episode.id === file?.id);
  const next = index >= 0 ? episodes[index + 1] : undefined;

  const showChrome = () => {
    setChrome(true);
    clearTimeout(hideTimer.current);
    hideTimer.current = setTimeout(() => {
      const video = videoRef.current;
      if (video && !video.paused && !menu) setChrome(false);
    }, 3000);
  };

  useEffect(() => {
    const onHash = () => {
      const nextRequest = params();
      if (nextRequest) {
        setStreams(null);
        setActive(0);
        setError("");
        setResumedFrom(0);
        setUpNextDismissed(false);
        setRequest(nextRequest);
      }
    };
    addEventListener("hashchange", onHash);
    return () => removeEventListener("hashchange", onHash);
  }, []);

  useEffect(() => {
    const onFullscreen = () =>
      setFullscreen(Boolean(document.fullscreenElement));
    document.addEventListener("fullscreenchange", onFullscreen);
    return () => document.removeEventListener("fullscreenchange", onFullscreen);
  }, []);

  // Resolve streams for the requested title/episode.
  useEffect(() => {
    if (!entry) return;
    let alive = true;
    const id =
      entry.type === "series" && file
        ? `${entry.id}:${file.season}:${file.episode}`
        : entry.id;
    fetch(
      "/addon/" +
        encodeURIComponent(token) +
        "/stream/" +
        entry.type +
        "/" +
        encodeURIComponent(id) +
        ".json",
    )
      .then((response) => response.json())
      .then((data) => {
        if (!alive) return;
        if (!data.streams?.length) return setError("No playable stream");
        const preferred = localStorage.getItem(qualityKey(entry.id));
        const at = data.streams.findIndex(
          (stream) => qualityLabel(stream) === preferred,
        );
        setActive(at === -1 ? 0 : at);
        setStreams(data.streams);
      })
      .catch((requestError) => alive && setError(requestError.message));
    return () => {
      alive = false;
    };
  }, [entry?.id, file?.id]);

  // Attach the active stream, resume, and keep the server's position current.
  useEffect(() => {
    const video = videoRef.current;
    const stream = streams?.[active];
    if (!video || !stream) return;
    let cleanup;
    let alive = true;
    const entryId = entry.id;
    const fileId = file?.id;
    const key = positionKey(entryId, fileId);
    // Server position wins when it belongs to this file; localStorage covers
    // the seconds since the last server save.
    const server =
      entry.playback &&
      (fileId === undefined || entry.playback.fileId === fileId)
        ? entry.playback.positionSeconds
        : 0;
    const local = Number(localStorage.getItem(key)) || 0;
    const start = Math.max(server, local);
    video.volume = volume;
    video.muted = muted;
    video.playbackRate = speed;
    attachSource(video, stream.url)
      .then((detach) => {
        if (!alive) return detach();
        cleanup = detach;
        if (start > RESUME_MIN_SECONDS) {
          video.currentTime = start;
          setResumedFrom(start);
          setTimeout(() => alive && setResumedFrom(0), 4000);
        }
        return video.play().catch(() => undefined);
      })
      .catch((sourceError) => alive && setError(sourceError.message));

    let lastSaved = -1;
    const save = () => {
      const position = Math.floor(video.currentTime);
      const total = Number.isFinite(video.duration) ? video.duration : 0;
      const finished =
        video.ended ||
        (total > 0 && total - video.currentTime < FINISHED_TAIL_SECONDS);
      if (finished) {
        localStorage.removeItem(key);
        // A finished episode points the resume at the next one; a finished
        // movie clears the resume point so the hero stops offering it.
        if (lastSaved === -2) return;
        lastSaved = -2;
        if (next)
          void savePosition(entryId, { positionSeconds: 0, fileId: next.id });
        else
          void api("library/" + encodeURIComponent(entryId) + "/playback", {
            method: "DELETE",
          }).catch(() => undefined);
        return;
      }
      if (position <= RESUME_MIN_SECONDS) return;
      localStorage.setItem(key, String(position));
      if (Math.abs(position - lastSaved) < 5) return;
      lastSaved = position;
      void savePosition(entryId, {
        positionSeconds: position,
        ...(fileId === undefined ? {} : { fileId }),
      });
    };
    const stall = setTimeout(() => {
      if (!alive || video.readyState > 0 || video.error) return;
      if (active + 1 < streams.length) {
        setNotice(
          qualityLabel(stream) +
            " isn't starting — switched to " +
            qualityLabel(streams[active + 1]),
        );
        setActive(active + 1);
      }
    }, STALL_MS);
    const timer = setInterval(save, SAVE_INTERVAL_MS);
    const onHide = () => {
      if (document.hidden) save();
    };
    video.addEventListener("pause", save);
    video.addEventListener("ended", save);
    document.addEventListener("visibilitychange", onHide);
    addEventListener("pagehide", save);
    return () => {
      alive = false;
      save();
      clearTimeout(stall);
      clearInterval(timer);
      video.removeEventListener("pause", save);
      video.removeEventListener("ended", save);
      document.removeEventListener("visibilitychange", onHide);
      removeEventListener("pagehide", save);
      cleanup?.();
      // The Library hero and cards read entry.playback; refresh them.
      void load();
    };
  }, [streams, active]);

  // Mirror element state into the chrome.
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    const sync = () => {
      setPaused(video.paused);
      if (!scrubbing) setTime(video.currentTime);
      setDuration(effectiveDuration(video));
      setVolume(video.volume);
      setMuted(video.muted);
      const ranges = video.buffered;
      setBuffered(ranges.length ? ranges.end(ranges.length - 1) : 0);
      const audio = video.audioTracks
        ? [...video.audioTracks].map((track, i) => ({
            id: i,
            label: track.label || track.language || "Track " + (i + 1),
            enabled: track.enabled,
          }))
        : [];
      const text = video.textTracks
        ? [...video.textTracks].map((track, i) => ({
            id: i,
            label: track.label || track.language || "Subtitle " + (i + 1),
            enabled: track.mode === "showing",
          }))
        : [];
      setTracks({ audio, text });
    };
    const onWaiting = () => setWaiting(true);
    const onPlaying = () => setWaiting(false);
    // A source the browser cannot decode: try the next quality (usually the
    // repaired "Compatible" stream) before giving up.
    const onError = () => {
      const code = video.error?.code;
      if (code !== 3 && code !== 4) return;
      if (streams && active + 1 < streams.length) {
        setNotice(
          qualityLabel(streams[active]) +
            " won't play here — switched to " +
            qualityLabel(streams[active + 1]),
        );
        setActive(active + 1);
      } else {
        setError("This browser cannot decode the stream");
      }
    };
    const events = [
      "play",
      "pause",
      "timeupdate",
      "durationchange",
      "volumechange",
      "progress",
      "loadedmetadata",
      "ratechange",
    ];
    for (const name of events) video.addEventListener(name, sync);
    for (const name of ["waiting", "seeking"])
      video.addEventListener(name, onWaiting);
    for (const name of ["playing", "seeked", "canplay"])
      video.addEventListener(name, onPlaying);
    video.addEventListener("error", onError);
    sync();
    return () => {
      video.removeEventListener("error", onError);
      for (const name of events) video.removeEventListener(name, sync);
      for (const name of ["waiting", "seeking"])
        video.removeEventListener(name, onWaiting);
      for (const name of ["playing", "seeked", "canplay"])
        video.removeEventListener(name, onPlaying);
    };
  }, [streams, active, scrubbing]);

  // Keyboard transport.
  useEffect(() => {
    const onKey = (event) => {
      const video = videoRef.current;
      if (
        !video ||
        ["INPUT", "SELECT", "TEXTAREA"].includes(event.target.tagName)
      )
        return;
      const key = event.key;
      if (key === "Escape") {
        if (menu) return setMenu(null);
        if (document.fullscreenElement) return void document.exitFullscreen();
        location.hash = "#/library";
        return;
      }
      showChrome();
      if (key === " " || key === "k") {
        event.preventDefault();
        if (video.paused) void video.play();
        else video.pause();
      } else if (key === "ArrowLeft" || key === "j") video.currentTime -= 10;
      else if (key === "ArrowRight" || key === "l") video.currentTime += 10;
      else if (key === "ArrowUp") {
        event.preventDefault();
        setVol(Math.min(1, video.volume + 0.05));
      } else if (key === "ArrowDown") {
        event.preventDefault();
        setVol(Math.max(0, video.volume - 0.05));
      } else if (key === "m") {
        video.muted = !video.muted;
        localStorage.setItem("hoshi-muted", String(video.muted));
      } else if (key === "f") toggleFullscreen();
      else if (key === "p") void togglePip();
      else if (key === "n" && next) goEpisode(entry.id, next.id);
      else if (key === "<" || key === ">") {
        const at = SPEEDS.indexOf(video.playbackRate);
        const to =
          SPEEDS[
            Math.min(
              SPEEDS.length - 1,
              Math.max(0, at + (key === ">" ? 1 : -1)),
            )
          ];
        video.playbackRate = to;
        setSpeed(to);
      } else if (/^[0-9]$/.test(key)) {
        const total = effectiveDuration(video);
        if (total) video.currentTime = (Number(key) / 10) * total;
      }
    };
    addEventListener("keydown", onKey);
    return () => removeEventListener("keydown", onKey);
  }, [menu, next, entry?.id]);

  useEffect(() => () => clearTimeout(hideTimer.current), []);

  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(""), 5000);
    return () => clearTimeout(timer);
  }, [notice]);

  const toggleFullscreen = () => {
    const stage = stageRef.current;
    if (!stage) return;
    if (document.fullscreenElement) void document.exitFullscreen();
    else void stage.requestFullscreen?.();
  };

  const togglePip = async () => {
    const video = videoRef.current;
    if (!video || !document.pictureInPictureEnabled) return;
    try {
      if (document.pictureInPictureElement)
        await document.exitPictureInPicture();
      else await video.requestPictureInPicture();
    } catch {
      // unsupported for this stream; ignore
    }
  };

  const ratioAt = (clientX) => {
    const bar = seekRef.current?.getBoundingClientRect();
    if (!bar || !bar.width) return 0;
    return Math.min(1, Math.max(0, (clientX - bar.left) / bar.width));
  };

  const beginScrub = (event) => {
    const video = videoRef.current;
    if (!video || !duration) return;
    event.preventDefault();
    setScrubbing(true);
    const apply = (clientX, commit) => {
      const ratio = ratioAt(clientX);
      setTime(ratio * duration);
      setHover({ ratio });
      if (commit) video.currentTime = ratio * duration;
    };
    apply(event.clientX, false);
    const onMove = (move) => apply(move.clientX, false);
    const onUp = (up) => {
      apply(up.clientX, true);
      setScrubbing(false);
      setHover(null);
      removeEventListener("pointermove", onMove);
      removeEventListener("pointerup", onUp);
      removeEventListener("pointercancel", onUp);
    };
    addEventListener("pointermove", onMove);
    addEventListener("pointerup", onUp);
    addEventListener("pointercancel", onUp);
  };

  const setVol = (value) => {
    const video = videoRef.current;
    if (!video) return;
    video.volume = value;
    video.muted = value === 0;
    localStorage.setItem("hoshi-volume", String(value));
    localStorage.setItem("hoshi-muted", String(video.muted));
  };

  if (!request || !entry)
    return html`<div class="empty">
      Title not found.
      <button class="secondary" onClick=${() => (location.hash = "#/library")}>
        Back to library
      </button>
    </div>`;

  const video = videoRef.current;
  const name = episodeName(file);
  const subtitle =
    entry.type === "series" && file
      ? "S" +
        file.season +
        " E" +
        file.episode +
        (name ? " · " + name : "") +
        (duration ? " · " + runtime(duration) : "")
      : runtime(duration);
  const seasons = [...new Set(episodes.map((episode) => episode.season))];
  const remaining = duration ? duration - time : Infinity;
  const showUpNext =
    Boolean(next) &&
    !upNextDismissed &&
    duration > 0 &&
    remaining <= UP_NEXT_SECONDS &&
    remaining > 0;
  const pipAvailable = Boolean(document.pictureInPictureEnabled);

  return html`
    <div
      ref=${stageRef}
      class="player-stage ${chrome ? "" : "hide-chrome"} ${
        scrubbing ? "scrubbing" : ""
      }"
      onMouseMove=${showChrome}
      onClick=${() => setMenu(null)}
    >
      <video
        ref=${videoRef}
        playsinline
        poster=${entry.background || entry.poster || ""}
        onClick=${(event) => {
          event.stopPropagation();
          if (menu) return setMenu(null);
          if (video?.paused) void video.play();
          else video?.pause();
        }}
        onDblClick=${toggleFullscreen}
        onEnded=${() => {
          if (autoNext && next) goEpisode(entry.id, next.id);
        }}
      ></video>

      ${
        waiting && !paused && !error
          ? html`<div class="pl-spinner" aria-label="Buffering"></div>`
          : null
      }
      ${
        paused && streams && !error && !waiting
          ? html`<button
              class="pl-bigplay"
              aria-label="Play"
              onClick=${(event) => {
                event.stopPropagation();
                void video?.play();
              }}
            >
              <${Icon} name="play" size="34" />
            </button>`
          : null
      }
      ${
        notice || resumedFrom
          ? html`<div class="pl-toast">
              ${notice || "Resumed from " + clock(resumedFrom)}
            </div>`
          : null
      }
      ${
        error
          ? html`<div class="pl-error">
              <p class="danger">${error}</p>
              <p class="muted">
                Browsers cannot decode every codec — try the Compatible quality
                if one is offered.
              </p>
            </div>`
          : !streams
            ? html`<div class="pl-error"><p class="muted">Loading…</p></div>`
            : null
      }
      ${
        showUpNext
          ? html`<div
              class="pl-upnext"
              onClick=${(event) => event.stopPropagation()}
            >
              <span class="pl-upnext-label">
                ${autoNext ? "Up next in " + Math.ceil(remaining) + "s" : "Up next"}
              </span>
              <strong>
                S${next.season}
                E${next.episode}${
                  episodeName(next) ? " · " + episodeName(next) : ""
                }
              </strong>
              <div class="row tight">
                <button
                  class="primary"
                  onClick=${() => goEpisode(entry.id, next.id)}
                >
                  Play now
                </button>
                <button
                  class="secondary"
                  onClick=${() => setUpNextDismissed(true)}
                >
                  ${autoNext ? "Cancel" : "Dismiss"}
                </button>
              </div>
            </div>`
          : null
      }

      <header class="pl-top">
        <button
          class="pl-icon-btn"
          aria-label="Back to library"
          onClick=${(event) => {
            event.stopPropagation();
            location.hash = "#/library";
          }}
        >
          <${Icon} name="back" />
        </button>
        <div class="pl-title">
          <strong>${entry.name}</strong>
          <span>${subtitle}</span>
        </div>
        <div class="pl-top-right" onClick=${(event) => event.stopPropagation()}>
          ${
            streams && streams.length > 1
              ? html`<${Menu}
                  label="Quality"
                  icon="settings"
                  open=${menu === "quality"}
                  onToggle=${() =>
                    setMenu(menu === "quality" ? null : "quality")}
                >
                  <div class="pl-menu-head">Quality</div>
                  ${streams.map(
                    (stream, streamIndex) => html`
                      <button
                        class="pl-menu-item ${
                          active === streamIndex ? "on" : ""
                        }"
                        onClick=${() => {
                          setError("");
                          setActive(streamIndex);
                          localStorage.setItem(
                            qualityKey(entry.id),
                            qualityLabel(stream),
                          );
                          setMenu(null);
                        }}
                      >
                        ${qualityLabel(stream)}
                      </button>
                    `,
                  )}
                <//>`
              : null
          }
          <${Menu}
            label="Speed"
            icon="speed"
            open=${menu === "speed"}
            onToggle=${() => setMenu(menu === "speed" ? null : "speed")}
          >
            <div class="pl-menu-head">Playback speed</div>
            ${SPEEDS.map(
              (rate) => html`
                <button
                  class="pl-menu-item ${speed === rate ? "on" : ""}"
                  onClick=${() => {
                    if (video) video.playbackRate = rate;
                    setSpeed(rate);
                    setMenu(null);
                  }}
                >
                  ${rate === 1 ? "Normal" : rate + "×"}
                </button>
              `,
            )}
          <//>
          <${Menu}
            label="Audio & Subtitles"
            icon="tracks"
            open=${menu === "tracks"}
            onToggle=${() => setMenu(menu === "tracks" ? null : "tracks")}
          >
            <div class="pl-menu-head">Audio</div>
            ${
              tracks.audio.length
                ? tracks.audio.map(
                    (track) => html`
                      <button
                        class="pl-menu-item ${track.enabled ? "on" : ""}"
                        onClick=${() => {
                          const list = videoRef.current?.audioTracks;
                          if (!list) return;
                          for (let i = 0; i < list.length; i++)
                            list[i].enabled = i === track.id;
                          setMenu(null);
                        }}
                      >
                        ${track.label}
                      </button>
                    `,
                  )
                : html`<div class="pl-menu-item muted-item">Default</div>`
            }
            <div class="pl-menu-head">Subtitles</div>
            ${
              tracks.text.length
                ? html`
                    <button
                      class="pl-menu-item ${
                        tracks.text.some((track) => track.enabled) ? "" : "on"
                      }"
                      onClick=${() => {
                        const list = videoRef.current?.textTracks;
                        if (!list) return;
                        for (const track of list) track.mode = "hidden";
                        setMenu(null);
                      }}
                    >
                      Off
                    </button>
                    ${tracks.text.map(
                      (track) => html`
                        <button
                          class="pl-menu-item ${track.enabled ? "on" : ""}"
                          onClick=${() => {
                            const list = videoRef.current?.textTracks;
                            if (!list) return;
                            for (let i = 0; i < list.length; i++)
                              list[i].mode =
                                i === track.id ? "showing" : "hidden";
                            setMenu(null);
                          }}
                        >
                          ${track.label}
                        </button>
                      `,
                    )}
                  `
                : html`<div class="pl-menu-item muted-item">
                    None in this stream
                  </div>`
            }
          <//>
        </div>
      </header>

      <footer class="pl-bottom" onClick=${(event) => event.stopPropagation()}>
        <div class="pl-seek-row">
          <div
            class="pl-seek"
            ref=${seekRef}
            role="slider"
            aria-label="Seek"
            aria-valuemin="0"
            aria-valuemax=${Math.floor(duration)}
            aria-valuenow=${Math.floor(time)}
            aria-valuetext=${clock(time)}
            onPointerDown=${beginScrub}
            onPointerMove=${(event) =>
              !scrubbing && setHover({ ratio: ratioAt(event.clientX) })}
            onPointerLeave=${() => !scrubbing && setHover(null)}
          >
            <div
              class="pl-seek-buffer"
              style=${
                "width:" + (duration ? (buffered / duration) * 100 : 0) + "%"
              }
            ></div>
            <div
              class="pl-seek-fill"
              style=${"width:" + (duration ? (time / duration) * 100 : 0) + "%"}
            >
              <span class="pl-seek-knob"></span>
            </div>
            ${
              hover && duration
                ? html`<div
                    class="pl-seek-tip"
                    style=${"left:" + hover.ratio * 100 + "%"}
                  >
                    ${clock(hover.ratio * duration)}
                  </div>`
                : null
            }
          </div>
          <span class="pl-time">
            ${clock(time)}
            <em>/ ${clock(duration)}</em>
          </span>
        </div>
        <div class="pl-controls">
          <button
            class="pl-icon-btn"
            aria-label=${paused ? "Play" : "Pause"}
            title=${paused ? "Play (Space)" : "Pause (Space)"}
            onClick=${() => {
              if (video?.paused) void video.play();
              else video?.pause();
            }}
          >
            <${Icon} name=${paused ? "play" : "pause"} />
          </button>
          <button
            class="pl-icon-btn"
            aria-label="Back 10 seconds"
            title="Back 10 s (J)"
            onClick=${() => video && (video.currentTime -= 10)}
          >
            <${Icon} name="replay" />
          </button>
          <button
            class="pl-icon-btn"
            aria-label="Forward 10 seconds"
            title="Forward 10 s (L)"
            onClick=${() => video && (video.currentTime += 10)}
          >
            <${Icon} name="forward" />
          </button>
          ${
            next
              ? html`<button
                  class="pl-icon-btn"
                  aria-label="Next episode"
                  title=${
                    "Next: S" + next.season + " E" + next.episode + " (N)"
                  }
                  onClick=${() => goEpisode(entry.id, next.id)}
                >
                  <${Icon} name="next" />
                </button>`
              : null
          }
          <div class="pl-volume-wrap">
            <button
              class="pl-icon-btn"
              aria-label=${muted ? "Unmute" : "Mute"}
              title="Mute (M)"
              onClick=${() => {
                if (!video) return;
                video.muted = !video.muted;
                localStorage.setItem("hoshi-muted", String(video.muted));
              }}
            >
              <${Icon} name=${muted || volume === 0 ? "muted" : "volume"} />
            </button>
            <input
              class="pl-volume"
              type="range"
              min="0"
              max="1"
              step="0.05"
              aria-label="Volume"
              value=${muted ? 0 : volume}
              onInput=${(event) => setVol(Number(event.target.value))}
            />
          </div>
          <div class="pl-spacer"></div>
          ${
            episodes.length
              ? html`<${Menu}
                  label="Episodes"
                  icon="episodes"
                  open=${menu === "episodes"}
                  onToggle=${() =>
                    setMenu(menu === "episodes" ? null : "episodes")}
                >
                  <label class="pl-menu-item pl-menu-check">
                    <input
                      type="checkbox"
                      checked=${autoNext}
                      onChange=${(event) => {
                        setAutoNext(event.target.checked);
                        localStorage.setItem(
                          "hoshi-autonext",
                          String(event.target.checked),
                        );
                      }}
                    />
                    Autoplay next episode
                  </label>
                  ${seasons.map(
                    (season) => html`
                      <div class="pl-menu-head">Season ${season}</div>
                      <div class="pl-menu-episodes">
                        ${episodes
                          .filter((episode) => episode.season === season)
                          .map(
                            (episode) => html`
                              <button
                                class="episode ${
                                  episode.id === file?.id ? "active" : ""
                                }"
                                title=${episode.path.split("/").pop()}
                                onClick=${() => {
                                  setMenu(null);
                                  goEpisode(entry.id, episode.id);
                                }}
                              >
                                E${episode.episode}
                              </button>
                            `,
                          )}
                      </div>
                    `,
                  )}
                <//>`
              : null
          }
          ${
            pipAvailable
              ? html`<button
                  class="pl-icon-btn"
                  aria-label="Picture in picture"
                  title="Picture in picture (P)"
                  onClick=${togglePip}
                >
                  <${Icon} name="pip" />
                </button>`
              : null
          }
          <button
            class="pl-icon-btn"
            aria-label=${fullscreen ? "Exit fullscreen" : "Fullscreen"}
            title="Fullscreen (F)"
            onClick=${toggleFullscreen}
          >
            <${Icon} name=${fullscreen ? "exitFullscreen" : "fullscreen"} />
          </button>
        </div>
      </footer>
    </div>
  `;
}
