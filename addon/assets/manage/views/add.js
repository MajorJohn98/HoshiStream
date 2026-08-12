// Add Media view: magnet, .torrent, local file, and series folder sources.
import { state, app, api, headers, notify, shell, load, go } from "../app.js";

async function upload(file, batch, path) {
  const r = await fetch(
    "/api/upload?batch=" + batch + "&path=" + encodeURIComponent(path),
    { method: "POST", headers, body: file },
  );
  if (!r.ok) throw Error("Upload failed");
}

async function addSubmit(e) {
  e.preventDefault();
  const f = e.target;
  const d = Object.fromEntries(new FormData(f));
  try {
    if (state.source === "torrentFile") {
      const file = f.elements.torrent.files[0];
      const batch = crypto.randomUUID();
      const r = await fetch(
        "/api/torrent-upload?batch=" +
          batch +
          "&name=" +
          encodeURIComponent(file.name),
        { method: "POST", headers, body: file },
      );
      if (!r.ok) throw Error("Torrent upload failed");
      d.torrentFilePath = (await r.json()).path;
      delete d.torrent;
    } else if (state.source === "local") {
      const file = f.elements.media.files[0];
      const batch = crypto.randomUUID();
      await upload(file, batch, file.name);
      d.localFilePath = "/data/media/" + batch + "/" + file.name;
      delete d.media;
    } else if (state.source === "folder") {
      const files = [...f.elements.folder.files].filter((x) =>
        /\.(mp4|mkv|webm|avi|mov|m4v)$/i.test(x.name),
      );
      const batch = crypto.randomUUID();
      for (const file of files)
        await upload(file, batch, file.webkitRelativePath);
      d.localFolderPath =
        "/data/media/" +
        batch +
        "/" +
        files[0].webkitRelativePath.split("/")[0];
      d.type = "series";
      delete d.folder;
    }
    Object.keys(d).forEach((k) => {
      if (!d[k]) delete d[k];
    });
    await api("library", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(d),
    });
    notify("Added to library");
    await load();
    go("library");
  } catch (x) {
    notify(x.message);
  }
}

export function addView() {
  app.innerHTML =
    shell(
      "Add Media",
      '<button class="secondary" id="back">Back to library</button>',
    ) +
    '<p class="muted">Choose a source you are authorized to use.</p><div class="source-cards">' +
    [
      ["torrent", "⌁", "Magnet link"],
      ["torrentFile", "▤", ".torrent file"],
      ["local", "▣", "Local file"],
      ["folder", "▱", "Series folder"],
    ]
      .map(
        ([id, icon, name]) =>
          '<button class="source-card ' +
          (state.source === id ? "active" : "") +
          '" data-source="' +
          id +
          '"><span>' +
          icon +
          "</span><b>" +
          name +
          '</b><span class="muted">Keep media private and local</span></button>',
      )
      .join("") +
    '</div><form id="addForm" class="panel" style="margin-top:18px"><div class="form-grid"><label>Name<input name="name" required></label><label>Type<select name="type"><option value="movie">Movie</option><option value="series">Series</option></select></label><label class="span2">Poster URL<input name="poster" type="url"></label><div class="span2" id="sourceField"></div></div><button class="primary" style="margin-top:18px">Inspect and add</button></form>';
  document.querySelector("#back").onclick = () => go("library");
  document.querySelectorAll("[data-source]").forEach(
    (b) =>
      (b.onclick = () => {
        state.source = b.dataset.source;
        addView();
      }),
  );
  const field = document.querySelector("#sourceField");
  field.innerHTML =
    state.source === "torrent"
      ? '<label>Magnet link<input name="magnetUri" required placeholder="magnet:?xt=urn:btih:…"></label>'
      : state.source === "torrentFile"
        ? '<div class="drop"><b>Drop a .torrent file here</b><p class="muted">Metadata is inspected locally.</p><input name="torrent" type="file" accept=".torrent" required></div>'
        : state.source === "local"
          ? '<label>Local media file<input name="media" type="file" accept=".mp4,.mkv,.webm,.avi,.mov,.m4v" required></label>'
          : '<label>Series folder<input name="folder" type="file" webkitdirectory multiple required></label>';
  if (state.source === "folder")
    document.querySelector('[name="type"]').value = "series";
  document.querySelector("#addForm").onsubmit = addSubmit;
}
