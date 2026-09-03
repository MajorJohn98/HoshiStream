// HoshiStream management UI entry point: preact root, glass top bar, and the
// hash router. Views are preact components in ./views/; the detail modal
// renders whenever state.selected is set.
import { html, render, useEffect, useState } from "./vendor/preact-htm.js";
import { setState, useStore, load } from "./store.js";
import { LibraryView } from "./views/library.js";
import { AddView } from "./views/add.js";
import { StatusView } from "./views/status.js";
import { SessionsView } from "./views/sessions.js";
import { DevicesView } from "./views/devices.js";
import { StorageView } from "./views/storage.js";
import { PlayerView } from "./views/player.js";
import { DetailModal } from "./views/detail.js";

const VIEWS = {
  library: LibraryView,
  add: AddView,
  sessions: SessionsView,
  devices: DevicesView,
  storage: StorageView,
  status: StatusView,
  play: PlayerView,
};

const NAV = [
  ["library", "Library"],
  ["add", "Add Media"],
  ["storage", "Storage"],
  ["sessions", "Stream Repair"],
  ["devices", "Devices"],
  ["status", "Status"],
];

function currentRoute() {
  const match = /^#\/([a-z]+)/.exec(location.hash);
  return match && VIEWS[match[1]] ? match[1] : "library";
}

export function go(next) {
  location.hash = "#/" + next;
}

function TopBar({ route }) {
  const { query } = useStore();
  return html`
    <header class="bar">
      <a class="brand" href="#/library" aria-label="HoshiStream">
        <img src="/assets/hoshistream-logo.png" alt="" />
        <span>Hoshi<em>Stream</em></span>
      </a>
      <nav class="bar-nav">
        ${NAV.map(
          ([key, label]) => html`
            <a class=${route === key ? "on" : ""} href=${"#/" + key}>
              ${label}
            </a>
          `,
        )}
      </nav>
      <input
        class="bar-search"
        type="search"
        placeholder="Search movies and series…"
        value=${query}
        onInput=${(event) => {
          setState({ query: event.target.value });
          if (currentRoute() !== "library") go("library");
        }}
      />
    </header>
  `;
}

function App() {
  const store = useStore();
  const [route, setRoute] = useState(currentRoute());
  useEffect(() => {
    const onHash = () => {
      // Drop DOM-level modals (import review, Stremio) and the detail modal.
      document.querySelector(".modal-backdrop")?.remove();
      setState({ selected: null });
      setRoute(currentRoute());
    };
    addEventListener("hashchange", onHash);
    return () => removeEventListener("hashchange", onHash);
  }, []);
  useEffect(() => {
    load().catch((error) => setState({ loadError: error.message }));
  }, []);
  const View = VIEWS[route];
  return html`
    <${TopBar} route=${route} />
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
    <${DetailModal} />
  `;
}

render(html`<${App} />`, document.querySelector("#app"));
