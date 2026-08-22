// HoshiStream management UI entry point: preact root, hash router, and nav
// wiring. Views are preact components in ./views/; the legacy detail modal
// still consumes the re-exports at the bottom until it is migrated.
import { html, render, useEffect, useState } from "./vendor/preact-htm.js";
import { state, setState, useStore, load } from "./store.js";
import { api, esc, fmt, notify, token, headers } from "./api.js";
import { LibraryView } from "./views/library.js";
import { AddView } from "./views/add.js";
import { StatusView } from "./views/status.js";

const VIEWS = { library: LibraryView, add: AddView, status: StatusView };

function currentRoute() {
  const match = /^#\/([a-z]+)/.exec(location.hash);
  return match && VIEWS[match[1]] ? match[1] : "library";
}

export function go(next) {
  document.querySelector(".modal-backdrop")?.remove();
  location.hash = "#/" + next;
}

function syncNav(route) {
  document
    .querySelectorAll("[data-view]")
    .forEach((b) => b.classList.toggle("active", b.dataset.view === route));
}

function App() {
  const store = useStore();
  const [route, setRoute] = useState(currentRoute());
  useEffect(() => {
    const onHash = () => {
      document.querySelector(".modal-backdrop")?.remove();
      setRoute(currentRoute());
    };
    addEventListener("hashchange", onHash);
    return () => removeEventListener("hashchange", onHash);
  }, []);
  useEffect(() => syncNav(route), [route]);
  useEffect(() => {
    load().catch((e) => setState({ loadError: e.message }));
  }, []);
  if (store.loadError)
    return html`<div class="empty">
      Unable to load HoshiStream: ${store.loadError}
    </div>`;
  if (!store.loaded) return html`<div class="empty">Loading…</div>`;
  const View = VIEWS[route];
  return html`<${View} />`;
}

document
  .querySelectorAll("[data-view]")
  .forEach((b) => (b.onclick = () => go(b.dataset.view)));
render(html`<${App} />`, document.querySelector("#app"));

// Legacy re-exports for the not-yet-migrated detail modal (views/detail.js).
export { state, load, api, esc, fmt, notify, token, headers };
