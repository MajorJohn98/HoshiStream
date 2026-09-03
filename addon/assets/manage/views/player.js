// In-browser player (#/play/{entryId}/{fileId}) with custom cinema chrome:
// top bar (back, title, quality + audio/subtitles menus), bottom scrubber
// with time, transport controls, episode popover for series, fullscreen, and
// auto-hiding controls. Plays the same stream URLs Stremio clients receive:
// MP4-class sources natively, HLS repair sessions via hls.js when needed.
import { html, useEffect, useRef, useState } from "../vendor/preact-htm.js";
import { token } from "../api.js";
import { useStore } from "../store.js";

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

function Menu({ label, icon, open, onToggle, children }) {
  return html`
    <div class="pl-menu-wrap">
      <button class="pl-menu-btn ${open ? "on" : ""}" onClick=${onToggle}>
        <span class="pl-ico">${icon}</span>${label}
      </button>
      ${open ? html`<div class="pl-menu">${children}</div>` : null}
    </div>
  `;
}

export function PlayerView() {
  const { entries } = useStore();
  const videoRef = useRef(null);
  const stageRef = useRef(null);
  const hideTimer = useRef(null);
  const [request, setRequest] = useState(params());
  const [streams, setStreams] = useState(null);
  const [active, setActive] = useState(0);
  const [error, setError] = useState("");
  const [paused, setPaused] = useState(true);
  const [time, setTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [buffered, setBuffered] = useState(0);
  const [volume, setVolume] = useState(1);
  const [muted, setMuted] = useState(false);
  const [chrome, setChrome] = useState(true);
  const [menu, setMenu] = useState(null); // "quality" | "tracks" | "episodes"
  const [tracks, setTracks] = useState({ audio: [], text: [] });
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
      if (video && !video.paused) {
        setChrome(false);
        setMenu(null);
      }
    }, 3000);
  };

  useEffect(() => {
    const onHash = () => {
      const nextRequest = params();
      if (nextRequest) {
        setStreams(null);
        setActive(0);
        setError("");
        setRequest(nextRequest);
      }
    };
    addEventListener("hashchange", onHash);
    return () => removeEventListener("hashchange", onHash);
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
        if (!data.streams?.length) setError("No playable stream");
        else setStreams(data.streams);
      })
      .catch((requestError) => alive && setError(requestError.message));
    return () => {
      alive = false;
    };
  }, [entry?.id, file?.id]);

  // Attach the active stream and persist the resume position.
  useEffect(() => {
    const video = videoRef.current;
    const stream = streams?.[active];
    if (!video || !stream) return;
    let cleanup;
    let alive = true;
    const key = positionKey(entry.id, file?.id);
    attachSource(video, stream.url)
      .then((detach) => {
        if (!alive) return detach();
        cleanup = detach;
        const saved = Number(localStorage.getItem(key));
        if (saved > 10) video.currentTime = saved;
        return video.play().catch(() => undefined);
      })
      .catch((sourceError) => alive && setError(sourceError.message));
    const save = () => {
      if (video.currentTime > 10 && !video.ended)
        localStorage.setItem(key, String(Math.floor(video.currentTime)));
      if (video.ended) localStorage.removeItem(key);
    };
    const timer = setInterval(save, 5_000);
    video.addEventListener("ended", save);
    return () => {
      alive = false;
      save();
      clearInterval(timer);
      video.removeEventListener("ended", save);
      cleanup?.();
    };
  }, [streams, active]);

  // Mirror element state into the chrome.
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    const sync = () => {
      setPaused(video.paused);
      setTime(video.currentTime);
      setDuration(video.duration || 0);
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
    const events = [
      "play",
      "pause",
      "timeupdate",
      "durationchange",
      "volumechange",
      "progress",
      "loadedmetadata",
    ];
    for (const name of events) video.addEventListener(name, sync);
    sync();
    return () => {
      for (const name of events) video.removeEventListener(name, sync);
    };
  }, [streams, active]);

  // Keyboard transport.
  useEffect(() => {
    const onKey = (event) => {
      const video = videoRef.current;
      if (!video || event.target.tagName === "INPUT") return;
      showChrome();
      if (event.key === " " || event.key === "k") {
        event.preventDefault();
        if (video.paused) void video.play();
        else video.pause();
      } else if (event.key === "ArrowLeft") video.currentTime -= 10;
      else if (event.key === "ArrowRight") video.currentTime += 10;
      else if (event.key === "m") video.muted = !video.muted;
      else if (event.key === "f") toggleFullscreen();
    };
    addEventListener("keydown", onKey);
    return () => removeEventListener("keydown", onKey);
  }, []);

  useEffect(() => () => clearTimeout(hideTimer.current), []);

  const toggleFullscreen = () => {
    const stage = stageRef.current;
    if (!stage) return;
    if (document.fullscreenElement) void document.exitFullscreen();
    else void stage.requestFullscreen?.();
  };

  const seekTo = (event) => {
    const video = videoRef.current;
    if (!video || !duration) return;
    const bar = event.currentTarget.getBoundingClientRect();
    const ratio = Math.min(
      1,
      Math.max(0, (event.clientX - bar.left) / bar.width),
    );
    video.currentTime = ratio * duration;
  };

  if (!request || !entry)
    return html`<div class="empty">
      Title not found.
      <button class="secondary" onClick=${() => (location.hash = "#/library")}>
        Back to library
      </button>
    </div>`;

  const video = videoRef.current;
  const subtitle =
    entry.type === "series" && file
      ? "S" + file.season + " E" + file.episode + " · " + runtime(duration)
      : runtime(duration);
  const seasons = [...new Set(episodes.map((episode) => episode.season))];

  return html`
    <div
      ref=${stageRef}
      class="player-stage ${chrome ? "" : "hide-chrome"}"
      onMouseMove=${showChrome}
      onClick=${() => setMenu(null)}
    >
      <video
        ref=${videoRef}
        playsinline
        onClick=${(event) => {
          event.stopPropagation();
          setMenu(null);
          if (video?.paused) void video.play();
          else video?.pause();
        }}
        onEnded=${() => {
          if (autoNext && next) goEpisode(entry.id, next.id);
        }}
      ></video>

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

      <header class="pl-top">
        <button
          class="pl-icon-btn"
          aria-label="Back to library"
          onClick=${(event) => {
            event.stopPropagation();
            location.hash = "#/library";
          }}
        >
          ←
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
                  icon="▸"
                  open=${menu === "quality"}
                  onToggle=${() =>
                    setMenu(menu === "quality" ? null : "quality")}
                >
                  ${streams.map(
                    (stream, streamIndex) => html`
                      <button
                        class="pl-menu-item ${
                          active === streamIndex ? "on" : ""
                        }"
                        onClick=${() => {
                          setError("");
                          setActive(streamIndex);
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
            label="Audio & Subtitles"
            icon="◨"
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
          <div class="pl-seek" onClick=${seekTo}>
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
          </div>
          <span class="pl-time">${clock(time)} / ${clock(duration)}</span>
        </div>
        <div class="pl-controls">
          <button
            class="pl-icon-btn"
            aria-label=${paused ? "Play" : "Pause"}
            onClick=${() => {
              if (video?.paused) void video.play();
              else video?.pause();
            }}
          >
            ${paused ? "▶" : "⏸"}
          </button>
          <button
            class="pl-icon-btn"
            aria-label="Back 10 seconds"
            onClick=${() => video && (video.currentTime -= 10)}
          >
            ↺10
          </button>
          <button
            class="pl-icon-btn"
            aria-label="Forward 10 seconds"
            onClick=${() => video && (video.currentTime += 10)}
          >
            ↻10
          </button>
          <button
            class="pl-icon-btn"
            aria-label=${muted ? "Unmute" : "Mute"}
            onClick=${() => video && (video.muted = !video.muted)}
          >
            ${muted || volume === 0 ? "🔇" : "🔊"}
          </button>
          <input
            class="pl-volume"
            type="range"
            min="0"
            max="1"
            step="0.05"
            value=${muted ? 0 : volume}
            onInput=${(event) => {
              if (!video) return;
              video.volume = Number(event.target.value);
              video.muted = video.volume === 0;
            }}
          />
          <div class="pl-spacer"></div>
          ${
            episodes.length
              ? html`<${Menu}
                  label="Episodes"
                  icon="▦"
                  open=${menu === "episodes"}
                  onToggle=${() =>
                    setMenu(menu === "episodes" ? null : "episodes")}
                >
                  <label class="pl-menu-item" style="cursor:pointer">
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
                    Autoplay next
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
                                title=${episode.path}
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
          <button
            class="pl-icon-btn"
            aria-label="Fullscreen"
            onClick=${toggleFullscreen}
          >
            ⛶
          </button>
        </div>
      </footer>
    </div>
  `;
}
