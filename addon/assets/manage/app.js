// HoshiStream management UI entry point: preact root, hash router, and nav
// wiring. Views are preact components in ./views/; the detail modal renders
// whenever state.selected is set.
import { html, render, useEffect, useState } from "./vendor/preact-htm.js";
import { setState, useStore, load } from "./store.js";
import { LibraryView } from "./views/library.js";
import { AddView } from "./views/add.js";
import { StatusView } from "./views/status.js";
import { DetailModal } from "./views/detail.js";

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
      // Drop DOM-level modals (import review, Stremio) and the detail modal.
      document.querySelector(".modal-backdrop")?.remove();
      setState({ selected: null });
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
  return html`<${View} /><${DetailModal} />`;
}

document
  .querySelectorAll("[data-view]")
  .forEach((b) => (b.onclick = () => go(b.dataset.view)));
render(html`<${App} />`, document.querySelector("#app"));
