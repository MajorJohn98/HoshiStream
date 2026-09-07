// Add Media modal: manual magnet, .torrent, local-file, and folder imports.
// Rendered by App over the current page while state.adding is set. When the
// native app is running, local sources can be linked in place with a native
// picker instead of uploading a copy.
import { html, useEffect, useRef, useState } from "../vendor/preact-htm.js";
import { ApiError, api, apiResponse, headers, notify } from "../api.js";
import { state, setState, useStore, load } from "../store.js";
import { TagPicker } from "../components/tag-picker.js";
import {
  SourceCheckPanel,
  pickSourceCheckFileId,
} from "../components/source-check.js";
import { manualSubmission } from "../import-state.js";
import { clearMagnetLinkRoute, magnetLinkPrefill } from "../magnet-link.js";

export function openAdd({ magnetLinkId = null } = {}) {
  if (state.adding) {
    if (magnetLinkId && magnetLinkId !== state.magnetLinkId)
      notify(
        "Finish or close the current add, then click the magnet link again.",
      );
    return;
  }
  setState({
    adding: true,
    magnetLinkId,
    ...(magnetLinkId ? { source: "torrent" } : {}),
  });
}

export function closeAdd() {
  clearMagnetLinkRoute();
  setState({ adding: false, magnetLinkId: null });
}

async function upload(file, batch, path) {
  const r = await fetch(
    "/api/upload?batch=" + batch + "&path=" + encodeURIComponent(path),
    { method: "POST", headers, body: file },
  );
  const report = await apiResponse(r);
  if (
    !report ||
    typeof report.path !== "string" ||
    !report.path ||
    typeof report.folderRoot !== "string" ||
    !report.folderRoot
  )
    throw new ApiError(
      "The upload response was incomplete. Retry the upload.",
      { code: "invalid_upload_response" },
    );
  return report;
}

const PLAYABLE_MEDIA = /\.(mp4|mkv|webm|avi|mov|m4v)$/i;

function selectedSourceState(source, picked, form) {
  if (picked && (source === "local" || source === "folder"))
    return {
      source,
      pickedGrant: picked.grant,
      pickedName: picked.name,
      files: [],
    };
  if (source === "torrentFile") {
    const file = form.elements.torrent.files[0];
    return { source, file, files: file ? [file] : [] };
  }
  if (source === "local") {
    const file = form.elements.media.files[0];
    return { source, file, files: file ? [file] : [] };
  }
  if (source === "folder") {
    const files = [...form.elements.folder.files].filter((file) =>
      PLAYABLE_MEDIA.test(file.name),
    );
    return { source, files };
  }
  return { source, files: [] };
}

function sameSelectedSource(previous, next) {
  if (!previous || previous.source !== next.source) return false;
  if (previous.pickedGrant || next.pickedGrant)
    return (
      previous.pickedGrant === next.pickedGrant &&
      previous.pickedName === next.pickedName
    );
  const previousFiles = previous.files || [];
  const nextFiles = next.files || [];
  return (
    previousFiles.length === nextFiles.length &&
    previousFiles.every((file, index) => file === nextFiles[index])
  );
}

async function prepareSource(form, source, picked, previous, remember) {
  const selected = selectedSourceState(source, picked, form);
  const prepared = sameSelectedSource(previous?.selected, selected)
    ? previous
    : {
        selected,
        fields: {},
        batch: crypto.randomUUID(),
        uploaded: new Map(),
        complete: false,
      };
  remember(prepared);
  if (prepared.complete) return prepared;
  if (picked && (source === "local" || source === "folder")) {
    prepared.fields = {
      nativePathGrant: picked.grant,
      ...(source === "folder" ? { type: "series" } : {}),
    };
    prepared.complete = true;
    return prepared;
  }
  if (source === "torrentFile") {
    const file = form.elements.torrent.files[0];
    if (!file) throw Error("Choose a .torrent file to add.");
    const r = await fetch(
      "/api/torrent-upload?batch=" +
        prepared.batch +
        "&name=" +
        encodeURIComponent(file.name),
      { method: "POST", headers, body: file },
    );
    const report = await apiResponse(r);
    if (typeof report?.path !== "string" || !report.path)
      throw new ApiError(
        "The torrent upload response was incomplete. Retry the upload.",
        { code: "invalid_upload_response" },
      );
    prepared.fields = { torrentFilePath: report.path };
    prepared.complete = true;
    return prepared;
  }
  if (source === "local") {
    const file = form.elements.media.files[0];
    if (!file)
      throw Error("Choose a local media file or link one from this computer.");
    const report =
      prepared.uploaded.get(file) ??
      (await upload(file, prepared.batch, file.name));
    prepared.uploaded.set(file, report);
    prepared.fields = { localFilePath: report.path };
    prepared.complete = true;
    return prepared;
  }
  if (source === "folder") {
    const files = [...form.elements.folder.files].filter((file) =>
      PLAYABLE_MEDIA.test(file.name),
    );
    if (!files.length)
      throw Error("Choose a folder with at least one playable video file.");
    let folderRoot = "";
    for (const file of files) {
      const report =
        prepared.uploaded.get(file) ??
        (await upload(file, prepared.batch, file.webkitRelativePath));
      prepared.uploaded.set(file, report);
      if (folderRoot && folderRoot !== report.folderRoot)
        throw new ApiError(
          "Uploaded files do not share one folder. Choose the folder again.",
        );
      folderRoot = report.folderRoot;
    }
    prepared.fields = { localFolderPath: folderRoot, type: "series" };
    prepared.complete = true;
    return prepared;
  }
  prepared.complete = true;
  return prepared;
}

function createPayload(snapshot, prepared, extras = [], tags = []) {
  const d = { ...snapshot, ...prepared.fields };
  if (tags.length) d.tags = tags;
  delete d.media;
  delete d.folder;
  delete d.torrent;
  Object.keys(d).forEach((k) => {
    if (!d[k] || d[k] instanceof File) delete d[k];
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
  return d;
}

async function submit(payload) {
  return api("library", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
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
  torrentFile:
    "Upload a .torrent file. Inspect it after adding to your library.",
  local: "Link a video on this Mac in place, or upload a copy.",
  folder: "Link a folder of episodes in place, or upload a copy.",
};

function SourceField({
  source,
  picked,
  picking,
  onPick,
  pickerReady,
  magnetUri,
}) {
  const pickerRow = (label) => html`
    <div class="picker-row">
      <button
        type="button"
        class="secondary"
        disabled=${picking}
        onClick=${onPick}
      >
        ${picking ? "Waiting for selection…" : "Choose on this computer"}
      </button>
      <span class="muted">${picked ? picked.name : label}</span>
    </div>
    <p class="muted">Or upload a copy into managed storage:</p>
  `;
  if (source === "torrent")
    return html`<label>
      Magnet link
      <input
        name="magnetUri"
        required
        defaultValue=${magnetUri ?? ""}
        placeholder="magnet:?xt=urn:btih:…"
      />
    </label>`;
  if (source === "torrentFile")
    return html`<div class="drop">
      <b>Drop a .torrent file here</b>
      <p class="muted">Inspect it after adding to your library.</p>
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
  const { adding, status, source, magnetLinkId } = useStore();
  const [prefill, setPrefill] = useState(null);
  const [prefillError, setPrefillError] = useState("");
  const [prefillAttempt, setPrefillAttempt] = useState(0);
  const [picked, setPicked] = useState(null);
  const [picking, setPicking] = useState(false);
  const [extras, setExtras] = useState([]);
  const [tags, setTags] = useState([]);
  const [checkAfterSave, setCheckAfterSave] = useState(true);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState(null);
  const pendingRef = useRef(false);
  const modal = useRef(null);
  const closeButton = useRef(null);
  const preparedRef = useRef(null);
  const submissionRef = useRef(null);
  useEffect(() => {
    if (!adding) return;
    const returnFocus = document.activeElement;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    closeButton.current?.focus({ preventScroll: true });
    const containFocus = (event) => {
      if (!modal.current?.contains(event.target))
        modal.current?.focus({ preventScroll: true });
    };
    document.addEventListener("focusin", containFocus);
    // Reset transient form state each time the modal opens.
    setPicked(null);
    setExtras([]);
    setTags([]);
    setCheckAfterSave(true);
    setError("");
    setSaved(null);
    setPrefill(null);
    setPrefillError("");
    preparedRef.current = null;
    submissionRef.current = null;
    const controller = new AbortController();
    if (magnetLinkId) {
      void api("imports/magnet-links/" + encodeURIComponent(magnetLinkId), {
        signal: AbortSignal.any([
          controller.signal,
          AbortSignal.timeout(10000),
        ]),
      })
        .then((value) => {
          if (
            !controller.signal.aborted &&
            state.adding &&
            state.magnetLinkId === magnetLinkId
          )
            setPrefill({
              id: magnetLinkId,
              ...magnetLinkPrefill(value, magnetLinkId),
            });
        })
        .catch((error) => {
          if (
            !controller.signal.aborted &&
            state.adding &&
            state.magnetLinkId === magnetLinkId
          )
            setPrefillError(error.message);
        });
    }
    return () => {
      controller.abort();
      document.body.style.overflow = previousOverflow;
      document.removeEventListener("focusin", containFocus);
      if (returnFocus?.isConnected && document.activeElement === document.body)
        returnFocus.focus({ preventScroll: true });
    };
  }, [adding, magnetLinkId, prefillAttempt]);
  if (!adding) return null;
  const incoming =
    magnetLinkId && prefill?.id === magnetLinkId ? prefill : null;
  const setBusy = (value) => {
    pendingRef.current = value;
    setPending(value);
  };
  const mayLeave = () => !pendingRef.current;
  const updateSavedEntry = (entry) => {
    setSaved((current) => (current ? { ...current, entry } : current));
    setState({
      entries: [...state.entries.filter((item) => item.id !== entry.id), entry],
      ...(state.selected?.id === entry.id ? { selected: entry } : {}),
    });
  };
  const requestClose = () => {
    if (mayLeave()) closeAdd();
  };
  const changeSource = (id) => {
    if (id === source || !mayLeave()) return;
    setPicked(null);
    setError("");
    setSaved(null);
    preparedRef.current = null;
    submissionRef.current = null;
    setState({ source: id });
  };
  const onKeyDown = (event) => {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      requestClose();
    } else if (event.key === "Tab") {
      const controls = [
        ...modal.current.querySelectorAll(
          'button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), a[href], summary, [tabindex="0"]',
        ),
      ].filter(
        (element) => element.tabIndex >= 0 && element.getClientRects().length,
      );
      const first = controls[0];
      const last = controls.at(-1);
      if (!first) {
        event.preventDefault();
        modal.current.focus();
      } else if (
        (event.shiftKey &&
          (document.activeElement === first ||
            !controls.includes(document.activeElement))) ||
        (!event.shiftKey &&
          (document.activeElement === last ||
            !controls.includes(document.activeElement)))
      ) {
        event.preventDefault();
        (event.shiftKey ? last : first).focus();
      }
    }
  };
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
  const resetSaved = () => {
    clearMagnetLinkRoute();
    setState({ magnetLinkId: null });
    setPrefill(null);
    setPicked(null);
    setExtras([]);
    setTags([]);
    setCheckAfterSave(true);
    setError("");
    setSaved(null);
    preparedRef.current = null;
    submissionRef.current = null;
  };
  const openSaved = (entry) => {
    closeAdd();
    setState({
      adding: false,
      selected: entry,
      tab: "playback",
      inspection: null,
      inspectionError: "",
    });
  };
  const onSubmit = async (e) => {
    e.preventDefault();
    if (pendingRef.current) return;
    const snapshot = Object.fromEntries(new FormData(e.target));
    setBusy(true);
    setError("");
    let saving = false;
    try {
      preparedRef.current = await prepareSource(
        e.target,
        source,
        picked,
        preparedRef.current,
        (prepared) => {
          preparedRef.current = prepared;
        },
      );
      const payload = createPayload(
        snapshot,
        preparedRef.current,
        source === "torrent" ? extras : [],
        tags,
      );
      const attempt = manualSubmission(submissionRef.current, payload);
      submissionRef.current = attempt;
      saving = true;
      const entry = await submit(attempt.body);
      const nextSaved = {
        entry,
        autoCheck: checkAfterSave && !entry.sourceCheck,
        startOptions: checkAfterSave
          ? {
              probe: true,
              ...(pickSourceCheckFileId(entry)
                ? { fileId: pickSourceCheckFileId(entry) }
                : {}),
            }
          : {},
      };
      setSaved(nextSaved);
      setState({
        entries: [
          ...state.entries.filter((item) => item.id !== entry.id),
          entry,
        ],
      });
      void load().catch(() =>
        notify("Saved. The library refresh failed; reload when connected."),
      );
    } catch (error) {
      if (
        !saving ||
        (error instanceof ApiError &&
          error.status > 0 &&
          error.status < 500 &&
          error.code !== "invalid_response")
      )
        setError(
          error.message ||
            "Upload could not finish. Retry with the same selected files.",
        );
      else
        setError(
          "Could not confirm whether the entry was saved. Retry with the same details to avoid duplicates. Change the details only if you mean to create a new request.",
        );
      return;
    } finally {
      setBusy(false);
    }
  };
  return html`
    <div
      class="modal-backdrop add-backdrop"
      onClick=${(e) => {
        if (e.target === e.currentTarget) requestClose();
      }}
      onKeyDown=${onKeyDown}
    >
      <section
        class="modal add-modal"
        role="dialog"
        aria-modal="true"
        aria-label="Add media"
        ref=${modal}
        tabindex="-1"
      >
        <button
          class="modal-close"
          aria-label="Close"
          ref=${closeButton}
          disabled=${pending}
          onClick=${requestClose}
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
                id=${"source-tab-" + id}
                aria-controls="add-source-panel"
                aria-selected=${source === id}
                tabindex=${source === id ? 0 : -1}
                disabled=${pending || Boolean(magnetLinkId && !incoming)}
                class=${source === id ? "on" : ""}
                onClick=${() => changeSource(id)}
                onKeyDown=${(event) => {
                  const index = SOURCES.findIndex(
                    ([candidate]) => candidate === source,
                  );
                  const next =
                    event.key === "ArrowRight"
                      ? (index + 1) % SOURCES.length
                      : event.key === "ArrowLeft"
                        ? (index + SOURCES.length - 1) % SOURCES.length
                        : event.key === "Home"
                          ? 0
                          : event.key === "End"
                            ? SOURCES.length - 1
                            : -1;
                  if (next < 0) return;
                  event.preventDefault();
                  const nextId = SOURCES[next][0];
                  if (nextId !== source && mayLeave()) {
                    setPicked(null);
                    setError("");
                    setSaved(null);
                    preparedRef.current = null;
                    submissionRef.current = null;
                    setState({ source: nextId });
                    document.getElementById("source-tab-" + nextId)?.focus();
                  }
                }}
              >
                ${
                  icon
                    ? html`<span class="glyph" aria-hidden="true"
                        >${icon}</span
                      >`
                    : html`<svg
                        class="glyph"
                        viewBox="0 0 16 16"
                        width="14"
                        height="14"
                        aria-hidden="true"
                      >
                        <circle
                          cx="6.5"
                          cy="6.5"
                          r="4"
                          fill="none"
                          stroke="currentColor"
                          stroke-width="1.5"
                        />
                        <path
                          d="m9.5 9.5 4 4"
                          fill="none"
                          stroke="currentColor"
                          stroke-width="1.5"
                          stroke-linecap="round"
                        />
                      </svg>`
                }${name}
              </button>
            `,
          )}
        </div>
        <div
          id="add-source-panel"
          role="tabpanel"
          aria-labelledby=${"source-tab-" + source}
        >
          <p class="muted source-help">${SOURCE_HELP[source]}</p>
          <p class="muted" role="status">
            ${
              pending
                ? "Saving… Keep this window open until the save finishes."
                : ""
            }
          </p>
          ${
            magnetLinkId && !incoming
              ? html`<div class="stacked">
                  <p
                    class=${prefillError ? "danger" : "muted"}
                    role=${prefillError ? "alert" : "status"}
                  >
                    ${prefillError || "Opening magnet link for review…"}
                  </p>
                  ${
                    prefillError
                      ? html`<div class="actions stacked">
                          <button
                            class="secondary"
                            onClick=${() => setPrefillAttempt((attempt) => attempt + 1)}
                          >
                            Try again
                          </button>
                          <button
                            class="secondary"
                            onClick=${() => {
                              clearMagnetLinkRoute();
                              setState({ magnetLinkId: null });
                            }}
                          >
                            Enter manually
                          </button>
                        </div>`
                      : null
                  }
                </div>`
              : saved
                ? html`<div class="add-saved stacked">
                    <h2 tabindex="-1">Added to library</h2>
                    <p>${saved.entry.name}</p>
                    <p class="muted" role="status">
                      ${
                        saved.autoCheck
                          ? "The entry is saved. The source check runs separately and does not affect this saved result."
                          : "The entry is saved. Playback remains unchecked until you run a source check."
                      }
                    </p>
                    <${SourceCheckPanel}
                      entry=${saved.entry}
                      onEntry=${updateSavedEntry}
                      autoStart=${saved.autoCheck}
                      startOptions=${saved.startOptions}
                      showOpenHint=${true}
                      busyLabel="Starting check…"
                    />
                    <div class="actions stacked">
                      <button
                        class="primary"
                        type="button"
                        onClick=${() => openSaved(saved.entry)}
                      >
                        Open entry
                      </button>
                      <button
                        class="secondary"
                        type="button"
                        onClick=${resetSaved}
                      >
                        Add another
                      </button>
                    </div>
                  </div>`
                : html`<form
                    class="panel stacked"
                    key=${source + ":" + (magnetLinkId ?? "manual")}
                    onSubmit=${onSubmit}
                  >
                    <fieldset class="add-form-fields" disabled=${pending}>
                      <div class="form-grid">
                        <label
                          >Name<input
                            name="name"
                            required
                            defaultValue=${incoming?.name ?? ""}
                        /></label>
                        <label>
                          Type
                          <select name="type">
                            <option value="movie">Movie</option>
                            <option
                              value="series"
                              selected=${source === "folder"}
                            >
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
                            magnetUri=${incoming?.magnetUri}
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
                        <label class="check span2 add-check-toggle">
                          <input
                            type="checkbox"
                            checked=${checkAfterSave}
                            onChange=${(event) =>
                              setCheckAfterSave(event.target.checked)}
                          />
                          <span>
                            Inspect and check after saving
                            <small class="muted block"
                              >May contact peers and read a limited media sample
                              after the entry is saved.</small
                            >
                          </span>
                        </label>
                      </div>
                      ${error ? html`<p class="danger stacked-sm">${error}</p>` : null}
                      <div class="row stacked">
                        <button class="primary">
                          ${pending ? "Adding…" : "Add to library"}
                        </button>
                        <button
                          type="button"
                          class="secondary"
                          onClick=${requestClose}
                        >
                          Cancel
                        </button>
                      </div>
                    </fieldset>
                  </form>`
          }
        </div>
      </section>
    </div>
  `;
}
