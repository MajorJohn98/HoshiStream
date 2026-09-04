// HoshiStream management UI entry point: preact root, cinema-shelf layout
// with a left sidebar whose bottom half is a live activity HUD (health,
// playback, archive queue, drive warnings). Views render on the right; the
// entry sheet overlays everything when state.selected is set, and the Add
// Media modal when state.adding is set.
import { html, render, useEffect, useState } from "./vendor/preact-htm.js";
import { setState, useStore, load, startActivityPolling } from "./store.js";
import { LibraryView } from "./views/library.js";
import { AddSheet, openAdd } from "./views/add.js";
import { StatusView } from "./views/status.js";
import { ActivityView } from "./views/activity.js";
import { StorageView } from "./views/storage.js";
import { TagsView } from "./views/tags.js";
import { PlayerView } from "./views/player.js";
import { DetailSheet } from "./views/detail.js";

const VIEWS = {
  library: LibraryView,
  status: StatusView,
  activity: ActivityView,
  storage: StorageView,
  tags: TagsView,
  play: PlayerView,
};

// Bookmarks and HUD links from the merged System page (0.12.0–0.12.2), and
// the pre-0.12 Devices/Sessions pages, land on their new home.
const LEGACY_ROUTES = {
  system: "status",
  "system/health": "status",
  "system/analysis": "library/analysis",
  "system/storage": "storage",
  "system/devices": "activity",
  "system/repair": "activity/repair",
  devices: "activity",
  sessions: "activity/repair",
};

function currentRoute() {
  const match = /^#\/([a-z]+)(\/[a-z]+)?/.exec(location.hash);
  const name = match?.[1];
  // Add Media is a modal over the Library; old #/add bookmarks open it.
  if (name === "add") {
    openAdd();
    location.replace("#/library");
    return "library";
  }
  const legacy =
    LEGACY_ROUTES[name + (match?.[2] ?? "")] ?? LEGACY_ROUTES[name];
  if (legacy) {
    location.replace("#/" + legacy);
    return legacy.split("/")[0];
  }
  return name && VIEWS[name] ? name : "library";
}

export function go(next) {
  location.hash = "#/" + next;
}

const NAV = [
  ["library", "▦", "Library"],
  ["status", "◎", "Status"],
  ["activity", "◔", "Activity"],
  ["storage", "▤", "Storage"],
  ["tags", "⌗", "Tags"],
];

function fmtBytes(n) {
  return n >= 1e9 ? (n / 1e9).toFixed(1) + " GB" : Math.round(n / 1e6) + " MB";
}

// The live HUD: every row is a glanceable fact and a link to the page where
// it can be acted on — health to Status, anything moving to Activity, drives
// and copies to Storage.
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
      <a class="hud-item" href="#/status">
        <span class="dot ${torrOnline ? "ok" : "bad"}"></span>
        <span class="hud-text">
          ${torrOnline ? "All systems go" : "TorrServer offline"}
        </span>
      </a>
      ${playing.map(
        (session) => html`
          <a class="hud-item" href="#/activity" key=${session.hash}>
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
          <a class="hud-item" href="#/storage" key=${job.entryId}>
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
                      <span
                        style=${"transform:scaleX(" + percent / 100 + ")"}
                      ></span>
                    </span>`
                  : null
              }
            </span>
          </a>
        `;
      })}
      ${troubledDrives.map(
        (volume) => html`
          <a class="hud-item warn" href="#/storage" key=${volume.id}>
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
          ? html`<a class="hud-item" href="#/activity/repair">
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
      // The Add Media modal is preact-managed and closes through state.
      document.querySelector(".modal-backdrop:not(.add-backdrop)")?.remove();
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
    <${AddSheet} />
  `;
}

render(html`<${App} />`, document.querySelector("#app"));
