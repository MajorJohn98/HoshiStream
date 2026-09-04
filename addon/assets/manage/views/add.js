// Add Media modal: magnet, .torrent, local file, and series folder sources.
// Rendered by App over the current page while state.adding is set. When the
// native app is running, local sources can be linked in place with a Finder
// picker instead of uploading a copy.
import { html, useEffect, useRef, useState } from "../vendor/preact-htm.js";
import { api, headers, notify } from "../api.js";
import { setState, useStore, load } from "../store.js";
import { TagPicker } from "../components/tag-picker.js";

export function openAdd() {
  setState({ adding: true });
}

export function closeAdd() {
  setState({ adding: false });
}

async function upload(file, batch, path) {
  const r = await fetch(
    "/api/upload?batch=" + batch + "&path=" + encodeURIComponent(path),
    { method: "POST", headers, body: file },
  );
  if (!r.ok) throw Error("Upload failed");
}

async function submit(form, source, picked, extras = [], tags = []) {
  const d = Object.fromEntries(new FormData(form));
  if (tags.length) d.tags = tags;
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
const SOURCE_HELP = {
  torrent: "Paste a magnet link you are authorized to use.",
  torrentFile: "Upload a .torrent file; metadata is inspected locally.",
  local: "Link a video on this Mac in place, or upload a copy.",
  folder: "Link a folder of episodes in place, or upload a copy.",
};

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
      <span class="field-label">Additional torrents</span>
      <p class="muted">
        Series only — merge more torrents (season packs or single episodes) into
        one entry. Season applies to files whose names carry no SxxEyy
        numbering.
      </p>
      ${extras.map(
        (extra, index) => html`
          <div class="picker-row repeater-row">
            <input
              class="grow"
              placeholder="magnet:?xt=urn:btih:…"
              value=${extra.magnetUri}
              onInput=${(e) => update(index, "magnetUri", e.target.value)}
            />
            <input
              class="input-narrow"
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

export function AddSheet() {
  const { adding, status, source } = useStore();
  const [picked, setPicked] = useState(null);
  const [picking, setPicking] = useState(false);
  const [extras, setExtras] = useState([]);
  const [tags, setTags] = useState([]);
  const closeButton = useRef(null);
  useEffect(() => {
    if (!adding) return;
    closeButton.current?.focus({ preventScroll: true });
    // Reset transient form state each time the modal opens.
    setPicked(null);
    setExtras([]);
    setTags([]);
  }, [adding]);
  if (!adding) return null;
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
        tags,
      );
      notify("Added to library");
      await load();
      closeAdd();
    } catch (error) {
      notify(error.message);
    }
  };
  return html`
    <div
      class="modal-backdrop add-backdrop"
      onClick=${(e) => {
        if (e.target === e.currentTarget) closeAdd();
      }}
      onKeyDown=${(e) => {
        if (e.key === "Escape") closeAdd();
      }}
    >
      <section
        class="modal add-modal"
        role="dialog"
        aria-modal="true"
        aria-label="Add media"
      >
        <button
          class="modal-close"
          aria-label="Close"
          ref=${closeButton}
          onClick=${closeAdd}
        >
          <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
            <path
              d="M3.5 3.5l9 9M12.5 3.5l-9 9"
              fill="none"
              stroke="currentColor"
              stroke-width="1.8"
              stroke-linecap="round"
            />
          </svg>
        </button>
        <div class="head">
          <div><h1>Add Media</h1></div>
        </div>
        <div class="segmented" role="tablist" aria-label="Source">
          ${SOURCES.map(
            ([id, icon, name]) => html`
              <button
                type="button"
                role="tab"
                aria-selected=${source === id}
                class=${source === id ? "on" : ""}
                onClick=${() => {
                  setPicked(null);
                  setState({ source: id });
                }}
              >
                <span class="glyph">${icon}</span>${name}
              </button>
            `,
          )}
        </div>
        <p class="muted source-help">${SOURCE_HELP[source]}</p>
        <form class="panel stacked" key=${source} onSubmit=${onSubmit}>
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
              <span class="field-label">Tags</span>
              <${TagPicker} value=${tags} onChange=${setTags} />
            </div>
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
          <div class="row stacked">
            <button class="primary">Inspect and add</button>
            <button type="button" class="secondary" onClick=${closeAdd}>
              Cancel
            </button>
          </div>
        </form>
      </section>
    </div>
  `;
}
