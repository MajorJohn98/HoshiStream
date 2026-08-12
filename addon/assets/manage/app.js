// HoshiStream management UI entry point: shared state, API helpers, and the
// view router. Views live in ./views/ and share state through this module.
import { libraryView } from "./views/library.js";
import { addView } from "./views/add.js";
import { detailView } from "./views/detail.js";
import { statusView } from "./views/status.js";

export const state = {
  entries: [],
  status: {},
  view: "library",
  selected: null,
  tab: "overview",
  inspection: null,
  inspectionError: "",
  source: "torrent",
  query: "",
  filter: "all",
};

export const token = decodeURIComponent(
  location.pathname.split("/").filter(Boolean).pop(),
);
export const headers = { Authorization: "Bearer " + token };

export const app = document.querySelector("#app");
const toast = document.querySelector("#toast");

export const esc = (s) =>
  String(s ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;",
      })[c],
  );

export const fmt = (n) =>
  n >= 1e9 ? (n / 1e9).toFixed(1) + " GB" : Math.round(n / 1e6) + " MB";

export const notify = (s) => {
  toast.textContent = s;
  toast.className = "toast show";
  setTimeout(() => (toast.className = "toast"), 2500);
};

export async function api(path, opt = {}) {
  const r = await fetch("/api/" + path, {
    ...opt,
    headers: { ...headers, ...opt.headers },
  });
  if (!r.ok)
    throw Error((await r.json().catch(() => ({}))).error || "Request failed");
  return r.status === 204 ? null : r.json();
}

export async function load() {
  [state.entries, state.status] = await Promise.all([
    api("library"),
    api("status"),
  ]);
  render();
}

function nav() {
  document
    .querySelectorAll("[data-view]")
    .forEach((b) =>
      b.classList.toggle("active", b.dataset.view === state.view),
    );
}

export function shell(title, action = "") {
  return (
    '<div class="head"><div><h1>' + title + "</h1></div>" + action + "</div>"
  );
}

export function render() {
  nav();
  if (state.view === "library") libraryView();
  if (state.view === "add") addView();
  if (state.view === "detail") detailView();
  if (state.view === "status") statusView();
}

export function go(next) {
  document.querySelector(".modal-backdrop")?.remove();
  state.view = next;
  render();
}

document
  .querySelectorAll("[data-view]")
  .forEach((b) => (b.onclick = () => go(b.dataset.view)));
load().catch((e) => {
  app.innerHTML =
    '<div class="empty">Unable to load HoshiStream: ' +
    esc(e.message) +
    "</div>";
});
