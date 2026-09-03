// HoshiStream management UI entry point: preact root, cinema-shelf layout
// with a left sidebar whose bottom half is a live activity HUD (health,
// playback, archive queue, drive warnings). Views render on the right; the
// entry sheet overlays everything when state.selected is set.
import { html, render, useEffect, useState } from "./vendor/preact-htm.js";
import { setState, useStore, load, startActivityPolling } from "./store.js";
import { LibraryView } from "./views/library.js";
import { AddView } from "./views/add.js";
import { SystemView } from "./views/system.js";
import { PlayerView } from "./views/player.js";
import { DetailSheet } from "./views/detail.js";

const VIEWS = {
  library: LibraryView,
  add: AddView,
  system: SystemView,
  play: PlayerView,
};

// Old bookmarks from the four merged pages land on their System section.
const LEGACY_ROUTES = {
  status: "system/health",
  devices: "system/devices",
  sessions: "system/repair",
  storage: "system/storage",
};

function currentRoute() {
  const match = /^#\/([a-z]+)/.exec(location.hash);
  const name = match?.[1];
  if (LEGACY_ROUTES[name]) {
    location.replace("#/" + LEGACY_ROUTES[name]);
    return "system";
  }
  return name && VIEWS[name] ? name : "library";
}

export function go(next) {
  location.hash = "#/" + next;
}

const NAV = [
  ["library", "▦", "Library"],
  ["add", "＋", "Add Media"],
  ["system", "◎", "System"],
];

function fmtBytes(n) {
  return n >= 1e9 ? (n / 1e9).toFixed(1) + " GB" : Math.round(n / 1e6) + " MB";
}

// The live HUD: every row is a glanceable fact and a link to the System
// section where it can be acted on.
function Hud() {
  const { entries, status, activity } = useStore();
  const torrOnline = Boolean(status.torrServer?.online);
  const playing = activity.playback.filter((session) => session.active);
  const repairing = activity.repair.filter(
    (session) => session.state === "running",
  );
  const keptVolumeIds = new Set(
    entries
      .filter((entry) => entry.diskCopy?.desired === "keep")
      .map((entry) => entry.diskCopy.volumeId),
  );
  const troubledDrives = activity.volumes.filter(
    (volume) => keptVolumeIds.has(volume.id) && volume.state !== "online",
  );
  const name = (entryId) =>
    entries.find((entry) => entry.id === entryId)?.name ?? "…";
  return html`
    <div class="hud">
      <a class="hud-item" href="#/system/health">
        <span class="dot ${torrOnline ? "ok" : "bad"}"></span>
        <span class="hud-text">
          ${torrOnline ? "All systems go" : "TorrServer offline"}
        </span>
      </a>
      ${playing.map(
        (session) => html`
          <a class="hud-item" href="#/system/devices" key=${session.hash}>
            <span class="dot live"></span>
            <span class="hud-text">
              <strong>Streaming</strong> ${session.title}
              <em>↓ ${fmtBytes(session.downloadSpeedBps)}/s</em>
            </span>
          </a>
        `,
      )}
      ${activity.jobs.slice(0, 3).map((job) => {
        const percent = job.file?.length
          ? Math.min(
              100,
              Math.round((job.file.received / job.file.length) * 100),
            )
          : 0;
        return html`
          <a class="hud-item" href="#/system/storage" key=${job.entryId}>
            <span class="dot ${job.status === "copying" ? "live" : "idle"}">
            </span>
            <span class="hud-text">
              <strong>
                ${
                  job.status === "copying"
                    ? "Copying " + percent + "%"
                    : job.status === "queued"
                      ? "Queued"
                      : job.reason || "Waiting"
                }
              </strong>
              ${name(job.entryId)}
              ${
                job.status === "copying"
                  ? html`<span class="hud-bar">
                      <span style=${"width:" + percent + "%"}></span>
                    </span>`
                  : null
              }
            </span>
          </a>
        `;
      })}
      ${troubledDrives.map(
        (volume) => html`
          <a class="hud-item warn" href="#/system/storage" key=${volume.id}>
            <span class="dot bad"></span>
            <span class="hud-text">
              <strong>
                ${volume.state === "offline" ? "Drive offline" : "Drive issue"}
              </strong>
              ${volume.label} — playback falls back to torrent
            </span>
          </a>
        `,
      )}
      ${
        repairing.length
          ? html`<a class="hud-item" href="#/system/repair">
              <span class="dot live"></span>
              <span class="hud-text">
                <strong>Repairing</strong> ${repairing.length}
                stream${repairing.length === 1 ? "" : "s"}
              </span>
            </a>`
          : null
      }
    </div>
  `;
}

function Sidebar({ route }) {
  const { query } = useStore();
  return html`
    <aside class="sidebar">
      <a class="brand" href="#/library" aria-label="HoshiStream">
        <img src="/assets/hoshistream-logo.png" alt="" />
        <span>Hoshi<em>Stream</em></span>
      </a>
      <input
        class="side-search"
        type="search"
        placeholder="Search library…"
        value=${query}
        onInput=${(event) => {
          setState({ query: event.target.value });
          if (currentRoute() !== "library") go("library");
        }}
      />
      <nav class="side-nav">
        ${NAV.map(
          ([key, glyph, label]) => html`
            <a class=${route === key ? "on" : ""} href=${"#/" + key}>
              <i>${glyph}</i>${label}
            </a>
          `,
        )}
      </nav>
      <${Hud} />
    </aside>
  `;
}

function App() {
  const store = useStore();
  const [route, setRoute] = useState(currentRoute());
  useEffect(() => {
    const onHash = () => {
      // Drop DOM-level modals (import review, Stremio) and the entry sheet.
      document.querySelector(".modal-backdrop")?.remove();
      setState({ selected: null });
      setRoute(currentRoute());
    };
    addEventListener("hashchange", onHash);
    return () => removeEventListener("hashchange", onHash);
  }, []);
  useEffect(() => {
    load()
      .then(() => startActivityPolling())
      .catch((error) => setState({ loadError: error.message }));
  }, []);
  const View = VIEWS[route];
  return html`
    <div class="app">
      <${Sidebar} route=${route} />
      <main class=${route === "library" ? "content wide" : "content"}>
        ${
          store.loadError
            ? html`<div class="empty">
                Unable to load HoshiStream: ${store.loadError}
              </div>`
            : !store.loaded
              ? html`<div class="empty">Loading…</div>`
              : html`<${View} />`
        }
      </main>
    </div>
    <${DetailSheet} />
  `;
}

render(html`<${App} />`, document.querySelector("#app"));
