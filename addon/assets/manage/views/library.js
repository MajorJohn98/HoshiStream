// Library view: grid of titles, search/filter, JSON import/export, and the
// Stremio catalog refresh flow.
import {
  state,
  app,
  api,
  esc,
  notify,
  shell,
  load,
  go,
  token,
} from "../app.js";
import { classifyLibraryImports } from "../classify-imports.js";
import { detailView } from "./detail.js";

function exportLibrary() {
  const library = state.entries.map(
    ({ torrentFilePath, localFilePath, localFolderPath, ...details }) => ({
      ...details,
      source: details.magnetUri
        ? "magnet"
        : torrentFilePath
          ? "torrent"
          : localFolderPath
            ? "folder"
            : "file",
    }),
  );
  const url = URL.createObjectURL(
    new Blob([JSON.stringify(library, null, 2)], { type: "application/json" }),
  );
  const link = document.createElement("a");
  link.href = url;
  link.download = "hoshistream-library.json";
  link.click();
  URL.revokeObjectURL(url);
}

async function reviewImport(file) {
  let candidates;
  try {
    candidates = classifyLibraryImports(
      JSON.parse(await file.text()),
      state.entries,
    );
  } catch (error) {
    return notify(error.message);
  }
  const backdrop = document.createElement("div");
  backdrop.className = "modal-backdrop";
  backdrop.innerHTML =
    '<section class="modal" role="dialog" aria-modal="true" aria-label="Import library"><button class="modal-close" aria-label="Close">×</button><div class="head"><div><h1>Import library</h1><p class="muted">Choose titles to add. Conflicts are unchecked by default.</p></div><button class="primary" id="confirmImport">Import selected</button></div><div class="panel tablewrap"><table class="files"><thead><tr><th>Import</th><th>Title</th><th>Type</th><th>Conflicts</th></tr></thead><tbody>' +
    candidates
      .map(
        (candidate, index) =>
          '<tr><td><input type="checkbox" data-import="' +
          index +
          '" ' +
          (!candidate.blocked && !candidate.conflicts.length ? "checked" : "") +
          " " +
          (candidate.blocked ? "disabled" : "") +
          "></td><td>" +
          esc(candidate.entry.name || "Invalid item") +
          "</td><td>" +
          esc(candidate.entry.type || "—") +
          "</td><td>" +
          (candidate.conflicts.length
            ? candidate.conflicts
                .map(
                  (conflict) =>
                    '<span class="badge warn">' + esc(conflict) + "</span>",
                )
                .join(" ")
            : '<span class="online">Ready</span>') +
          "</td></tr>",
      )
      .join("") +
    "</tbody></table></div></section>";
  document.body.append(backdrop);
  const close = () => backdrop.remove();
  backdrop.onclick = (e) => {
    if (e.target === backdrop) close();
  };
  backdrop.onkeydown = (e) => {
    if (e.key === "Escape") close();
  };
  backdrop.querySelector(".modal-close").onclick = close;
  backdrop.querySelector("#confirmImport").onclick = async () => {
    const chosen = [...backdrop.querySelectorAll("[data-import]:checked")].map(
      (input) => candidates[Number(input.dataset.import)].entry,
    );
    if (!chosen.length) return notify("Choose at least one title");
    const button = backdrop.querySelector("#confirmImport");
    button.disabled = true;
    let imported = 0;
    try {
      for (const entry of chosen) {
        const { id, createdAt, updatedAt, source, managedMedia, ...input } =
          entry;
        await api("library", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(input),
        });
        imported++;
      }
      await load();
      close();
      notify("Imported " + imported + " title" + (imported === 1 ? "" : "s"));
    } catch (error) {
      notify("Imported " + imported + " before error: " + error.message);
      button.disabled = false;
    }
  };
  backdrop.querySelector(".modal-close").focus();
}

async function refreshStremio() {
  const button = document.querySelector("#refreshStremio");
  button.disabled = true;
  button.textContent = "Validating…";
  try {
    const result = await api("stremio-refresh", { method: "POST" });
    const backdrop = document.createElement("div");
    backdrop.className = "modal-backdrop";
    backdrop.innerHTML =
      '<section class="modal" role="dialog" aria-modal="true" aria-label="Stremio catalog refresh" style="width:min(520px,100%)"><button class="modal-close" aria-label="Close">×</button><h2>Catalog ready for Stremio</h2><div class="metrics"><div class="metric"><span class="muted">Movies</span><strong>' +
      result.movies +
      '</strong></div><div class="metric"><span class="muted">Series</span><strong>' +
      result.series +
      '</strong></div></div><p class="muted">Validated just now. Stremio has been opened so it can request the current catalog.</p><div class="row"><button class="secondary" id="copyAddon">Copy add-on URL</button><button class="primary" id="openStremio">Open Stremio</button></div></section>';
    document.body.append(backdrop);
    const close = () => backdrop.remove();
    const open = () => {
      location.href = "stremio:///board";
    };
    backdrop.onclick = (e) => {
      if (e.target === backdrop) close();
    };
    backdrop.onkeydown = (e) => {
      if (e.key === "Escape") close();
    };
    backdrop.querySelector(".modal-close").onclick = close;
    backdrop.querySelector("#openStremio").onclick = open;
    backdrop.querySelector("#copyAddon").onclick = async () => {
      await navigator.clipboard.writeText(
        location.origin +
          "/addon/" +
          encodeURIComponent(token) +
          "/manifest.json",
      );
      notify("Add-on URL copied");
    };
    backdrop.querySelector(".modal-close").focus();
    open();
  } catch (error) {
    notify(error.message);
  } finally {
    button.disabled = false;
    button.textContent = "↻ Refresh Stremio";
  }
}

async function remove(id) {
  if (!confirm("Delete this title? Original linked files will remain.")) return;
  await api("library/" + encodeURIComponent(id), { method: "DELETE" });
  await load();
}

function card(e) {
  const local = e.localFilePath || e.localFolderPath;
  return (
    '<article class="card" data-id="' +
    esc(e.id) +
    '"><div class="art">' +
    (e.poster
      ? '<img src="' + esc(e.poster) + '" alt="">'
      : '<span class="placeholder">★</span>') +
    '<span class="badge">Available</span></div><div class="body"><h2>' +
    esc(e.name) +
    '</h2><div class="muted">' +
    (e.type === "series" ? "Series" : "Movie") +
    '</div><span class="badge">' +
    (local ? "Local" : "Torrent") +
    '</span><div class="actions"><button>Open details</button><button data-delete class="danger">Delete</button></div></div></article>'
  );
}

export function libraryView() {
  const visible = state.entries.filter(
    (e) =>
      (state.filter === "all" || e.type === state.filter) &&
      e.name.toLowerCase().includes(state.query.toLowerCase()),
  );
  app.innerHTML =
    shell(
      "Your Library",
      '<div class="row"><input id="importFile" type="file" accept="application/json,.json" hidden><button class="secondary" id="importLibrary">⇧ Import JSON</button><button class="secondary" id="exportLibrary">⇩ Export JSON</button><button class="secondary" id="refreshStremio">↻ Refresh Stremio</button><button class="primary" id="addTop">＋ Add Media</button></div>',
    ) +
    '<div class="statusbar"><span class="pill online">● HoshiStream online</span><span class="pill ' +
    (state.status.torrServer?.online ? "online" : "warn") +
    '">TorrServer ' +
    (state.status.torrServer?.online ? "online" : "offline") +
    '</span><span class="pill">' +
    state.entries.length +
    ' titles</span><span class="pill">Home ' +
    state.status.homeSpeedMbps +
    ' Mbps</span></div><div class="controls"><input id="search" class="field" type="search" placeholder="Search movies and series…" value="' +
    esc(state.query) +
    '"><div class="chips">' +
    ["all", "movie", "series"]
      .map(
        (x) =>
          '<button class="chip ' +
          (state.filter === x ? "active" : "") +
          '" data-filter="' +
          x +
          '">' +
          { all: "All", movie: "Movies", series: "Series" }[x] +
          "</button>",
      )
      .join("") +
    '</div></div><section class="grid">' +
    (visible.length
      ? visible.map(card).join("")
      : '<div class="empty">No matching titles.</div>') +
    "</section>";
  document.querySelector("#addTop").onclick = () => go("add");
  document.querySelector("#importLibrary").onclick = () =>
    document.querySelector("#importFile").click();
  document.querySelector("#importFile").onchange = (e) => {
    if (e.target.files[0]) reviewImport(e.target.files[0]);
  };
  document.querySelector("#exportLibrary").onclick = exportLibrary;
  document.querySelector("#refreshStremio").onclick = refreshStremio;
  document.querySelector("#search").oninput = (e) => {
    state.query = e.target.value;
    libraryView();
  };
  document.querySelectorAll("[data-filter]").forEach(
    (b) =>
      (b.onclick = () => {
        state.filter = b.dataset.filter;
        libraryView();
      }),
  );
  document.querySelectorAll("[data-id]").forEach(
    (c) =>
      (c.onclick = (e) => {
        if (e.target.closest("[data-delete]")) return remove(c.dataset.id);
        state.selected = state.entries.find((x) => x.id === c.dataset.id);
        state.tab = "overview";
        state.inspection = null;
        state.inspectionError = "";
        detailView();
      }),
  );
}
