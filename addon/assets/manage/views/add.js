// Add Media view: magnet, .torrent, local file, and series folder sources.
// When the native app is running, local sources can be linked in place with
// a Finder picker instead of uploading a copy.
import { html, useState } from "../vendor/preact-htm.js";
import { api, headers, notify } from "../api.js";
import { setState, useStore, load } from "../store.js";
import { Shell } from "../components/shell.js";

async function upload(file, batch, path) {
  const r = await fetch(
    "/api/upload?batch=" + batch + "&path=" + encodeURIComponent(path),
    { method: "POST", headers, body: file },
  );
  if (!r.ok) throw Error("Upload failed");
}

async function submit(form, source, picked, extras = []) {
  const d = Object.fromEntries(new FormData(form));
  if (picked && (source === "local" || source === "folder")) {
    d.nativePathGrant = picked.grant;
    if (source === "folder") d.type = "series";
    delete d.media;
    delete d.folder;
  } else if (source === "torrentFile") {
    const file = form.elements.torrent.files[0];
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
  } else if (source === "local") {
    const file = form.elements.media.files[0];
    const batch = crypto.randomUUID();
    await upload(file, batch, file.name);
    d.localFilePath = "/data/media/" + batch + "/" + file.name;
    delete d.media;
  } else if (source === "folder") {
    const files = [...form.elements.folder.files].filter((x) =>
      /\.(mp4|mkv|webm|avi|mov|m4v)$/i.test(x.name),
    );
    const batch = crypto.randomUUID();
    for (const file of files)
      await upload(file, batch, file.webkitRelativePath);
    d.localFolderPath =
      "/data/media/" + batch + "/" + files[0].webkitRelativePath.split("/")[0];
    d.type = "series";
    delete d.folder;
  }
  Object.keys(d).forEach((k) => {
    if (!d[k]) delete d[k];
  });
  const extraSources = extras
    .map((extra) => ({
      magnetUri: extra.magnetUri.trim(),
      ...(extra.seasonHint !== ""
        ? { seasonHint: Number(extra.seasonHint) }
        : {}),
    }))
    .filter((extra) => extra.magnetUri);
  if (extraSources.length) {
    if (d.type !== "series")
      throw Error("Additional torrents require the Series type");
    d.extraSources = extraSources;
  }
  await api("library", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(d),
  });
}

const SOURCES = [
  ["torrent", "⌁", "Magnet link"],
  ["torrentFile", "▤", ".torrent file"],
  ["local", "▣", "Local file"],
  ["folder", "▱", "Series folder"],
];

function SourceField({ source, picked, picking, onPick, pickerReady }) {
  const pickerRow = (label) => html`
    <div class="picker-row">
      <button
        type="button"
        class="secondary"
        disabled=${picking}
        onClick=${onPick}
      >
        ${picking ? "Waiting for Finder…" : "Choose with Finder"}
      </button>
      <span class="muted">${picked ? picked.name : label}</span>
    </div>
    <p class="muted">Or upload a copy into managed storage:</p>
  `;
  if (source === "torrent")
    return html`<label>
      Magnet link
      <input name="magnetUri" required placeholder="magnet:?xt=urn:btih:…" />
    </label>`;
  if (source === "torrentFile")
    return html`<div class="drop">
      <b>Drop a .torrent file here</b>
      <p class="muted">Metadata is inspected locally.</p>
      <input name="torrent" type="file" accept=".torrent" required />
    </div>`;
  if (source === "local")
    return html`
      ${pickerReady ? pickerRow("Link a video in place — no copy is made.") : null}
      <label>
        Local media file
        <input
          name="media"
          type="file"
          accept=".mp4,.mkv,.webm,.avi,.mov,.m4v"
          required=${!picked}
        />
      </label>
    `;
  return html`
    ${
      pickerReady
        ? pickerRow("Link a series folder in place — no copy is made.")
        : null
    }
    <label>
      Series folder
      <input
        name="folder"
        type="file"
        webkitdirectory
        multiple
        required=${!picked}
      />
    </label>
  `;
}

function ExtraTorrents({ extras, setExtras }) {
  const update = (index, field, value) =>
    setExtras(
      extras.map((extra, i) =>
        i === index ? { ...extra, [field]: value } : extra,
      ),
    );
  return html`
    <div class="span2">
      <b>Additional torrents</b>
      <p class="muted">
        Series only — merge more torrents (season packs or single episodes) into
        one entry. Season applies to files whose names carry no SxxEyy
        numbering.
      </p>
      ${extras.map(
        (extra, index) => html`
          <div class="picker-row" style="margin-bottom:8px">
            <input
              style="flex:1"
              placeholder="magnet:?xt=urn:btih:…"
              value=${extra.magnetUri}
              onInput=${(e) => update(index, "magnetUri", e.target.value)}
            />
            <input
              style="width:90px"
              type="number"
              min="0"
              placeholder="Season"
              value=${extra.seasonHint}
              onInput=${(e) => update(index, "seasonHint", e.target.value)}
            />
            <button
              type="button"
              class="secondary"
              onClick=${() => setExtras(extras.filter((_, i) => i !== index))}
            >
              ✕
            </button>
          </div>
        `,
      )}
      <button
        type="button"
        class="secondary"
        onClick=${() => setExtras([...extras, { magnetUri: "", seasonHint: "" }])}
      >
        + Add another torrent
      </button>
    </div>
  `;
}

export function AddView() {
  const { status, source } = useStore();
  const [picked, setPicked] = useState(null);
  const [picking, setPicking] = useState(false);
  const [extras, setExtras] = useState([]);
  const pick = async () => {
    setPicking(true);
    try {
      setPicked(
        await api(
          "native-picker/" + (source === "folder" ? "folder" : "file"),
          { method: "POST" },
        ),
      );
    } catch (error) {
      setPicked(null);
      notify(error.message);
    } finally {
      setPicking(false);
    }
  };
  const onSubmit = async (e) => {
    e.preventDefault();
    try {
      await submit(
        e.target,
        source,
        picked,
        source === "torrent" ? extras : [],
      );
      notify("Added to library");
      await load();
      location.hash = "#/library";
    } catch (error) {
      notify(error.message);
    }
  };
  return html`
    <${Shell}
      title="Add Media"
      actions=${html`<button
        class="secondary"
        onClick=${() => (location.hash = "#/library")}
      >
        Back to library
      </button>`}
    >
      <p class="muted">Choose a source you are authorized to use.</p>
      <div class="source-cards">
        ${SOURCES.map(
          ([id, icon, name]) => html`
            <button
              class="source-card ${source === id ? "active" : ""}"
              onClick=${() => {
                setPicked(null);
                setState({ source: id });
              }}
            >
              <span>${icon}</span><b>${name}</b>
              <span class="muted">Keep media private and local</span>
            </button>
          `,
        )}
      </div>
      <form
        class="panel"
        style="margin-top:18px"
        key=${source}
        onSubmit=${onSubmit}
      >
        <div class="form-grid">
          <label>Name<input name="name" required /></label>
          <label>
            Type
            <select name="type">
              <option value="movie">Movie</option>
              <option value="series" selected=${source === "folder"}>
                Series
              </option>
            </select>
          </label>
          <label class="span2"
            >Poster URL<input name="poster" type="url"
          /></label>
          <div class="span2">
            <${SourceField}
              source=${source}
              picked=${picked}
              picking=${picking}
              onPick=${pick}
              pickerReady=${Boolean(status.nativePicker)}
            />
          </div>
          ${
            source === "torrent"
              ? html`<${ExtraTorrents}
                  extras=${extras}
                  setExtras=${setExtras}
                />`
              : null
          }
        </div>
        <button class="primary" style="margin-top:18px">Inspect and add</button>
      </form>
    <//>
  `;
}
