// Detail modal: overview, source, files, and playback tabs for one entry.
import { state, api, esc, fmt, notify, token } from "../app.js";

async function inspect(technical = false) {
  const button = document.querySelector("#inspect");
  const label = button?.textContent;
  state.inspectionError = "";
  if (button) {
    button.disabled = true;
    button.textContent = technical
      ? "Analyzing playback…"
      : "Inspecting files…";
  }
  try {
    state.inspection = await api(
      "library/" +
        encodeURIComponent(state.selected.id) +
        "/inspect" +
        (technical ? "?probe=true" : ""),
      { method: "POST" },
    );
    detailView();
  } catch (error) {
    state.inspectionError = error.message;
    if (button) {
      button.disabled = false;
      button.textContent = label;
    }
    detailView();
  }
}

async function patch(d) {
  return api("library/" + encodeURIComponent(state.selected.id), {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(d),
  });
}

function titleHead() {
  return (
    '<div class="title-summary">' +
    (state.selected.poster
      ? '<img class="poster" src="' + esc(state.selected.poster) + '" alt="">'
      : '<div class="poster placeholder">★</div>') +
    "<div><h1>" +
    esc(state.selected.name) +
    '</h1><span class="badge">' +
    esc(state.selected.type) +
    '</span> <span class="badge">' +
    (state.selected.localFilePath || state.selected.localFolderPath
      ? "Local"
      : "Torrent") +
    '</span></div></div><div class="tabs">' +
    ["overview", "source", "files", "playback"]
      .map(
        (x) =>
          '<button class="tab ' +
          (state.tab === x ? "active" : "") +
          '" data-tab="' +
          x +
          '">' +
          x[0].toUpperCase() +
          x.slice(1) +
          "</button>",
      )
      .join("") +
    "</div>"
  );
}

function overview(body) {
  body.innerHTML =
    '<form id="editForm" class="panel form-grid"><label>Title<input name="name" value="' +
    esc(state.selected.name) +
    '"></label><label>Type<select name="type"><option ' +
    (state.selected.type === "movie" ? "selected" : "") +
    ' value="movie">Movie</option><option ' +
    (state.selected.type === "series" ? "selected" : "") +
    ' value="series">Series</option></select></label><label class="span2">Description<textarea name="description">' +
    esc(state.selected.description || "") +
    '</textarea></label><label>Poster URL<input name="poster" type="url" value="' +
    esc(state.selected.poster || "") +
    '"></label><label>Background URL<input name="background" type="url" value="' +
    esc(state.selected.background || "") +
    '"></label>' +
    (state.selected.magnetUri
      ? '<label class="span2">Magnet link<textarea name="magnetUri" required>' +
        esc(state.selected.magnetUri) +
        "</textarea></label>"
      : "") +
    '<div class="span2 row"><span></span><button class="primary">Save changes</button></div></form>';
  document.querySelector("#editForm").onsubmit = async (e) => {
    e.preventDefault();
    const d = Object.fromEntries(new FormData(e.target));
    ["poster", "background", "description"].forEach((k) => {
      if (!d[k]) d[k] = null;
    });
    state.selected = await api(
      "library/" + encodeURIComponent(state.selected.id),
      {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(d),
      },
    );
    notify("Changes saved");
    detailView();
  };
}

function inspectionPrompt(body, title, description, technical) {
  body.innerHTML =
    '<div class="empty"><h2>' +
    title +
    "</h2><p>" +
    description +
    "</p>" +
    (state.inspectionError
      ? '<p class="danger">' + esc(state.inspectionError) + "</p>"
      : "") +
    '<button class="primary" id="inspect">' +
    (technical ? "Analyze playback" : "Inspect source") +
    "</button></div>";
  document.querySelector("#inspect").onclick = () => inspect(technical);
}

function sourceView(body) {
  const path =
    state.selected.localFolderPath ||
    state.selected.localFilePath ||
    state.selected.torrentFilePath;
  body.innerHTML =
    '<div class="layout"><div class="panel"><h2>Source</h2><p class="muted">' +
    (state.selected.magnetUri
      ? "Authorized magnet link"
      : state.selected.localFolderPath
        ? "Linked series folder"
        : state.selected.localFilePath
          ? "Linked local file"
          : ".torrent file") +
    '</p><div class="metric"><span class="muted">Location</span><strong style="font-size:14px">' +
    esc(path || "Editable on the Overview tab") +
    "</strong></div>" +
    (state.inspectionError
      ? '<p class="danger">' + esc(state.inspectionError) + "</p>"
      : "") +
    '<div class="actions"><button class="primary" id="inspect">Inspect again</button></div></div><aside class="panel"><h3>Privacy</h3><p class="muted">Complete magnet URIs are visible only on the tokenized management page and are never written to logs.</p></aside></div>';
  document.querySelector("#inspect").onclick = () => inspect(false);
}

function filesView(body) {
  if (!state.inspection) {
    inspectionPrompt(
      body,
      "Inspect files first",
      "Load source metadata to choose files and map episodes.",
      false,
    );
    return;
  }
  const overrides = new Map(
    (state.selected.fileOverrides || []).map((x) => [x.id, x]),
  );
  body.innerHTML =
    '<div class="toolbar"><div><h2>Files & episode mapping</h2><span class="muted">' +
    state.inspection.files.length +
    ' files found</span></div><button class="secondary" id="automap">Restore automatic mapping</button></div><div class="panel tablewrap"><table class="files"><thead><tr><th>Use</th><th>File</th><th>Size</th><th>Season</th><th>Episode</th></tr></thead><tbody>' +
    state.inspection.files
      .map((f, i) => {
        const o = overrides.get(f.id);
        const s = state.inspection.selectedFiles.find((x) => x.id === f.id);
        return (
          '<tr data-file="' +
          f.id +
          '"><td><input class="include" type="checkbox" ' +
          ((o?.included ?? Boolean(s)) ? "checked" : "") +
          '></td><td class="filename">' +
          esc(f.path) +
          "</td><td>" +
          fmt(f.length) +
          '</td><td><input class="season" type="number" min="1" value="' +
          (o?.season || s?.season || 1) +
          '"></td><td><input class="episode" type="number" min="1" value="' +
          (o?.episode || s?.episode || i + 1) +
          '"></td></tr>'
        );
      })
      .join("") +
    '</tbody></table><div class="row" style="margin-top:18px"><span></span><button class="primary" id="saveMap">Save mapping</button></div></div>';
  document.querySelector("#automap").onclick = async () => {
    state.selected = await patch({ fileOverrides: [] });
    state.inspection = null;
    await inspect(false);
  };
  document.querySelector("#saveMap").onclick = async () => {
    const fileOverrides = [...document.querySelectorAll("[data-file]")].map(
      (r) => ({
        id: Number(r.dataset.file),
        included: r.querySelector(".include").checked,
        season: Number(r.querySelector(".season").value),
        episode: Number(r.querySelector(".episode").value),
      }),
    );
    state.selected = await patch({ fileOverrides });
    state.inspection = null;
    notify("Mapping saved");
    await inspect(false);
  };
}

function playback(body) {
  if (!state.inspection?.technical) {
    inspectionPrompt(
      body,
      state.inspection ? "Analyze playback" : "Inspect for playback",
      state.inspection
        ? "File metadata is ready. Analyze the selected video for compatibility and speed guidance."
        : "Inspect files and analyze the selected video.",
      true,
    );
    return;
  }
  const f = state.inspection.selectedFiles[0];
  const t = state.inspection.technical || {};
  const needed = t.recommendedMbps;
  const ready = needed && state.inspection.homeSpeedMbps >= needed;
  body.innerHTML =
    '<div class="layout"><div><div class="panel"><div class="head"><div><h2>Playback analysis</h2><p class="muted">' +
    esc(f?.path || "No selected file") +
    '</p></div><button class="secondary" id="inspect">Refresh analysis</button></div>' +
    (t.error ? '<p class="danger">' + esc(t.error) + "</p>" : "") +
    '<div class="metrics">' +
    [
      ["Size", fmt(f?.length || 0)],
      [
        "Resolution",
        t.width && t.height ? t.width + " × " + t.height : "Unknown",
      ],
      ["Video", (t.videoCodec || "Unknown").toUpperCase()],
      ["Audio", (t.audioCodec || "Unknown").toUpperCase()],
      [
        "Average bitrate",
        t.bitrateMbps ? t.bitrateMbps.toFixed(1) + " Mbps" : "Unknown",
      ],
      ["Recommended speed", needed ? needed.toFixed(1) + " Mbps" : "Unknown"],
      ["Home speed", state.inspection.homeSpeedMbps + " Mbps"],
      ["Selected files", state.inspection.selectedFiles.length],
    ]
      .map(
        (x) =>
          '<div class="metric"><span class="muted">' +
          x[0] +
          "</span><strong>" +
          esc(x[1]) +
          "</strong></div>",
      )
      .join("") +
    '</div><div class="actions"><button class="primary" id="test">Test playback</button></div></div><div class="panel route" style="margin-top:18px"><span>HoshiStream</span>→<span>' +
    (state.selected.localFilePath || state.selected.localFolderPath
      ? "Local file"
      : "TorrServer") +
    '</span>→<span>Player</span></div></div><aside class="panel"><h3>' +
    (t.error
      ? "Analysis incomplete"
      : ready
        ? "Likely to direct play"
        : needed
          ? "Connection may be too slow"
          : "Compatibility unknown") +
    '</h3><p class="muted">' +
    (ready
      ? "Your configured home speed meets the recommended 1.5× bitrate target."
      : needed
        ? "Recommended speed is above your configured home speed. Playback may buffer."
        : "A bitrate estimate was unavailable. Test playback on the target device.") +
    '</p><p class="muted">HoshiStream never transcodes; the player must support the listed codecs.</p></aside></div>';
  document.querySelector("#inspect").onclick = () => inspect(true);
  document.querySelector("#test").onclick = async () => {
    const id =
      state.selected.type === "series" && f
        ? state.selected.id + ":" + f.season + ":" + f.episode
        : state.selected.id;
    const r = await fetch(
      "/addon/" +
        encodeURIComponent(token) +
        "/stream/" +
        state.selected.type +
        "/" +
        encodeURIComponent(id) +
        ".json",
    );
    const s = (await r.json()).streams?.[0];
    if (s) window.open(s.url, "_blank");
    else notify("No playable stream");
  };
}

export function detailView() {
  document.querySelector(".modal-backdrop")?.remove();
  const backdrop = document.createElement("div");
  backdrop.className = "modal-backdrop";
  backdrop.innerHTML =
    '<section class="modal" role="dialog" aria-modal="true" aria-label="' +
    esc(state.selected.name) +
    ' details"><button class="modal-close" aria-label="Close">×</button>' +
    titleHead() +
    '<section id="tabBody"></section></section>';
  document.body.append(backdrop);
  const close = backdrop.querySelector(".modal-close");
  backdrop.onclick = (e) => {
    if (e.target === backdrop) backdrop.remove();
  };
  backdrop.onkeydown = (e) => {
    if (e.key === "Escape") backdrop.remove();
  };
  close.onclick = () => backdrop.remove();
  close.focus();
  document.querySelectorAll("[data-tab]").forEach(
    (b) =>
      (b.onclick = () => {
        state.tab = b.dataset.tab;
        detailView();
      }),
  );
  const body = document.querySelector("#tabBody");
  if (state.tab === "overview") overview(body);
  if (state.tab === "source") sourceView(body);
  if (state.tab === "files") filesView(body);
  if (state.tab === "playback") playback(body);
}
