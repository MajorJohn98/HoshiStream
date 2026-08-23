// In-browser player view (#/play/{entryId}/{fileId}): plays the same stream
// URLs the Stremio clients receive. MP4-class sources play natively; HLS
// repair sessions play natively on Safari and through hls.js elsewhere.
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

function streamId(entry, fileId) {
  if (entry.type !== "series") return entry.id;
  const files = entry.inspectionCache?.selectedFiles ?? [];
  const file = files.find((candidate) => candidate.id === fileId) ?? files[0];
  return file ? `${entry.id}:${file.season}:${file.episode}` : entry.id;
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

export function PlayerView() {
  const { entries } = useStore();
  const videoRef = useRef(null);
  const [streams, setStreams] = useState(null);
  const [active, setActive] = useState(0);
  const [error, setError] = useState("");
  const request = params();
  const entry = entries.find((candidate) => candidate.id === request?.entryId);

  useEffect(() => {
    if (!entry) return;
    let alive = true;
    const id = streamId(entry, request?.fileId);
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
  }, [entry?.id, request?.fileId]);

  useEffect(() => {
    const video = videoRef.current;
    const stream = streams?.[active];
    if (!video || !stream) return;
    let cleanup;
    let alive = true;
    const key = positionKey(entry.id, request?.fileId);
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
      title=${entry.name}
      actions=${html`<button
        class="secondary"
        onClick=${() => (location.hash = "#/library")}
      >
        Back to library
      </button>`}
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
          style="width:100%;display:block;background:#000;aspect-ratio:16/9"
        ></video>
      </div>
      ${
        streams && streams.length > 1
          ? html`<div class="chips" style="margin-top:12px">
              ${streams.map(
                (stream, index) => html`
                  <button
                    class="chip ${active === index ? "active" : ""}"
                    onClick=${() => {
                      setError("");
                      setActive(index);
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
    <//>
  `;
}
