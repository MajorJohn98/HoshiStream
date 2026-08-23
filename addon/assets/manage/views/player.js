// In-browser player view (#/play/{entryId}/{fileId}): plays the same stream
// URLs the Stremio clients receive. MP4-class sources play natively; HLS
// repair sessions play natively on Safari and through hls.js elsewhere.
// Series get an episode rail with next/previous and autoplay-next.
import { html, useEffect, useRef, useState } from "../vendor/preact-htm.js";
import { token } from "../api.js";
import { useStore } from "../store.js";
import { Shell } from "../components/shell.js";

function params() {
  const match = /^#\/play\/([^/]+)(?:\/(\d+))?/.exec(location.hash);
  return match
    ? {
        entryId: decodeURIComponent(match[1]),
        fileId: match[2] ? Number(match[2]) : undefined,
      }
    : undefined;
}

// Episodes come from the inspection cache, which the server keeps sorted by
// season/episode.
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

function EpisodeRail({ entry, activeFile, autoNext, onToggleAutoNext }) {
  const episodes = episodeList(entry);
  const seasons = [...new Set(episodes.map((episode) => episode.season))];
  const [season, setSeason] = useState(activeFile?.season ?? seasons[0]);
  useEffect(() => {
    if (activeFile) setSeason(activeFile.season);
  }, [activeFile?.id]);
  if (!episodes.length) return null;
  return html`
    <div class="panel" style="margin-top:14px">
      <div class="toolbar" style="margin-bottom:10px">
        <div class="chips">
          ${seasons.map(
            (candidate) => html`
              <button
                class="chip ${season === candidate ? "active" : ""}"
                onClick=${() => setSeason(candidate)}
              >
                Season ${candidate}
              </button>
            `,
          )}
        </div>
        <label class="muted" style="display:flex;gap:8px;align-items:center">
          <input
            type="checkbox"
            checked=${autoNext}
            onChange=${(event) => onToggleAutoNext(event.target.checked)}
          />
          Autoplay next
        </label>
      </div>
      <div class="episode-rail">
        ${episodes
          .filter((episode) => episode.season === season)
          .map(
            (episode) => html`
              <button
                class="episode ${episode.id === activeFile?.id ? "active" : ""}"
                title=${episode.path}
                onClick=${() => goEpisode(entry.id, episode.id)}
              >
                E${episode.episode}
              </button>
            `,
          )}
      </div>
    </div>
  `;
}

export function PlayerView() {
  const { entries } = useStore();
  const videoRef = useRef(null);
  const [request, setRequest] = useState(params());
  const [streams, setStreams] = useState(null);
  const [active, setActive] = useState(0);
  const [error, setError] = useState("");
  const [autoNext, setAutoNext] = useState(
    localStorage.getItem("hoshi-autonext") !== "false",
  );
  const entry = entries.find((candidate) => candidate.id === request?.entryId);
  const file = currentFile(entry, request?.fileId);
  const episodes = episodeList(entry);
  const index = episodes.findIndex((episode) => episode.id === file?.id);
  const previous = index > 0 ? episodes[index - 1] : undefined;
  const next = index >= 0 ? episodes[index + 1] : undefined;

  // Episode switches change only the hash inside this route, so the player
  // tracks hashchange itself.
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

  if (!request || !entry)
    return html`<div class="empty">
      Title not found.
      <button class="secondary" onClick=${() => (location.hash = "#/library")}>
        Back to library
      </button>
    </div>`;

  return html`
    <${Shell}
      title=${
        entry.type === "series" && file
          ? `${entry.name} · S${file.season} E${file.episode}`
          : entry.name
      }
      actions=${html`
        <div class="row">
          ${
            previous
              ? html`<button
                  class="secondary"
                  onClick=${() => goEpisode(entry.id, previous.id)}
                >
                  ⏮ E${previous.episode}
                </button>`
              : null
          }
          ${
            next
              ? html`<button
                  class="secondary"
                  onClick=${() => goEpisode(entry.id, next.id)}
                >
                  E${next.episode} ⏭
                </button>`
              : null
          }
          <button
            class="secondary"
            onClick=${() => (location.hash = "#/library")}
          >
            Back to library
          </button>
        </div>
      `}
    >
      ${
        error
          ? html`<div class="empty">
              <p class="danger">${error}</p>
              <p class="muted">
                Browsers cannot decode every codec. If direct play fails, try
                the Compatible stream, or use "Play on this Mac" from the
                title's detail view.
              </p>
            </div>`
          : null
      }
      <div class="panel" style="padding:0;overflow:hidden">
        <video
          ref=${videoRef}
          controls
          playsinline
          onEnded=${() => {
            if (autoNext && next) goEpisode(entry.id, next.id);
          }}
          style="width:100%;display:block;background:#000;aspect-ratio:16/9"
        ></video>
      </div>
      ${
        streams && streams.length > 1
          ? html`<div class="chips" style="margin-top:12px">
              ${streams.map(
                (stream, streamIndex) => html`
                  <button
                    class="chip ${active === streamIndex ? "active" : ""}"
                    onClick=${() => {
                      setError("");
                      setActive(streamIndex);
                    }}
                  >
                    ${stream.description.split("•")[0].trim()}
                  </button>
                `,
              )}
            </div>`
          : null
      }
      ${
        streams
          ? html`<p class="muted" style="margin-top:8px">
              ${streams[active]?.description}
              ${" — repaired streams show no total time until the session"}
              ${" finishes encoding."}
            </p>`
          : html`<p class="muted">Resolving stream…</p>`
      }
      <${EpisodeRail}
        entry=${entry}
        activeFile=${file}
        autoNext=${autoNext}
        onToggleAutoNext=${(value) => {
          setAutoNext(value);
          localStorage.setItem("hoshi-autonext", String(value));
        }}
      />
    <//>
  `;
}
