// Detail modal: overview, source, files, and playback tabs for one entry.
// Rendered by App whenever state.selected is set; closing clears it.
import { html, useRef, useState } from "../vendor/preact-htm.js";
import { api, fmt, notify, token, headers } from "../api.js";
import { setState, useStore } from "../store.js";

function agoLabel(iso) {
  const minutes = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 6e4));
  if (minutes < 1) return "just now";
  if (minutes < 60) return minutes + " min ago";
  const hours = Math.round(minutes / 60);
  if (hours < 48) return hours + " h ago";
  return Math.round(hours / 24) + " days ago";
}

function closeDetail() {
  setState({ selected: null, inspection: null, inspectionError: "" });
}

async function inspect(state, technical = false) {
  setState({ inspectionError: "" });
  try {
    const inspection = await api(
      "library/" +
        encodeURIComponent(state.selected.id) +
        "/inspect" +
        (technical ? "?probe=true" : ""),
      { method: "POST" },
    );
    setState({ inspection });
  } catch (error) {
    setState({ inspectionError: error.message });
  }
}

async function patch(state, d) {
  return api("library/" + encodeURIComponent(state.selected.id), {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(d),
  });
}

async function playHere(state, fileId) {
  const r = await fetch("/api/player/play", {
    method: "POST",
    headers: { ...headers, "content-type": "application/json" },
    body: JSON.stringify({
      entryId: state.selected.id,
      ...(fileId === undefined ? {} : { fileId }),
    }),
  });
  const d = await r.json();
  if (!r.ok) throw new Error(d.error || "Playback failed");
  const queued = d.queued
    ? " · " +
      d.queued +
      " more episode" +
      (d.queued === 1 ? "" : "s") +
      " queued"
    : "";
  notify(
    d.mode === "system"
      ? "Opened " + d.title + " in your player"
      : (d.resumedAt
          ? "Resumed " + d.title + " at " + Math.round(d.resumedAt) + "s"
          : "Playing " + d.title) + queued,
  );
}

function usePlayHere(state) {
  const [playing, setPlaying] = useState(false);
  const play = async (fileId) => {
    setPlaying(true);
    try {
      await playHere(state, fileId);
    } catch (error) {
      notify(error.message);
    } finally {
      setPlaying(false);
    }
  };
  return [playing, play];
}

function useInspect(state) {
  const [busy, setBusy] = useState(false);
  const run = async (technical) => {
    setBusy(true);
    try {
      await inspect(state, technical);
    } finally {
      setBusy(false);
    }
  };
  return [busy, run];
}

function InspectionPrompt({ state, title, description, technical }) {
  const [busy, run] = useInspect(state);
  return html`
    <div class="empty">
      <h2>${title}</h2>
      <p>${description}</p>
      ${
        state.inspectionError
          ? html`<p class="danger">${state.inspectionError}</p>`
          : null
      }
      <button class="primary" disabled=${busy} onClick=${() => run(technical)}>
        ${
          busy
            ? technical
              ? "Analyzing playback…"
              : "Inspecting files…"
            : technical
              ? "Analyze playback"
              : "Inspect source"
        }
      </button>
    </div>
  `;
}

function OverviewTab({ state }) {
  const entry = state.selected;
  const onSubmit = async (e) => {
    e.preventDefault();
    const d = Object.fromEntries(new FormData(e.target));
    ["poster", "background", "description"].forEach((k) => {
      if (!d[k]) d[k] = null;
    });
    try {
      setState({ selected: await patch(state, d) });
      notify("Changes saved");
    } catch (error) {
      notify(error.message);
    }
  };
  return html`
    <form class="panel form-grid" key=${entry.id} onSubmit=${onSubmit}>
      <label>Title<input name="name" value=${entry.name} /></label>
      <label>
        Type
        <select name="type">
          <option value="movie" selected=${entry.type === "movie"}>
            Movie
          </option>
          <option value="series" selected=${entry.type === "series"}>
            Series
          </option>
        </select>
      </label>
      <label class="span2">
        Description
        <textarea name="description">${entry.description || ""}</textarea>
      </label>
      <label>
        Poster URL<input name="poster" type="url" value=${entry.poster || ""} />
      </label>
      <label>
        Background URL
        <input name="background" type="url" value=${entry.background || ""} />
      </label>
      ${
        entry.magnetUri
          ? html`<label class="span2">
              Magnet link
              <textarea name="magnetUri" required>${entry.magnetUri}</textarea>
            </label>`
          : null
      }
      <div class="span2 row">
        <span></span>
        <button class="primary">Save changes</button>
      </div>
    </form>
  `;
}

function SourceTab({ state }) {
  const entry = state.selected;
  const [busy, run] = useInspect(state);
  const [relinking, setRelinking] = useState(false);
  const path =
    entry.localFolderPath || entry.localFilePath || entry.torrentFilePath;
  const relinkable =
    Boolean(entry.localFilePath || entry.localFolderPath) &&
    Boolean(state.status.nativePicker);
  const cache = entry.inspectionCache;
  const relink = async () => {
    setRelinking(true);
    try {
      const selected = await api(
        "library/" + encodeURIComponent(entry.id) + "/relink",
        { method: "POST" },
      );
      setState({ selected, inspection: null });
      notify("Source relinked");
    } catch (error) {
      notify(error.message);
    } finally {
      setRelinking(false);
    }
  };
  return html`
    <div class="layout">
      <div class="panel">
        <h2>Source</h2>
        <p class="muted">
          ${
            entry.magnetUri
              ? "Authorized magnet link"
              : entry.localFolderPath
                ? "Linked series folder"
                : entry.localFilePath
                  ? "Linked local file"
                  : ".torrent file"
          }
        </p>
        <div class="metric">
          <span class="muted">Location</span>
          <strong style="font-size:14px">
            ${path || "Editable on the Overview tab"}
          </strong>
        </div>
        ${
          cache
            ? html`<div class="metric" style="margin-top:12px">
                <span class="muted">Last inspected</span>
                <strong style="font-size:14px">
                  ${agoLabel(cache.inspectedAt)} · ${cache.selectedFiles.length}
                  ${" file" + (cache.selectedFiles.length === 1 ? "" : "s")}
                  ${" selected"}
                </strong>
              </div>`
            : null
        }
        ${
          state.inspectionError
            ? html`<p class="danger">${state.inspectionError}</p>`
            : null
        }
        <div class="actions">
          <button class="primary" disabled=${busy} onClick=${() => run(false)}>
            ${busy ? "Inspecting files…" : "Inspect again"}
          </button>
          ${
            relinkable
              ? html`<button
                  class="secondary"
                  disabled=${relinking}
                  onClick=${relink}
                >
                  ${relinking ? "Waiting for Finder…" : "Relink in Finder"}
                </button>`
              : null
          }
        </div>
      </div>
      <aside class="panel">
        <h3>Privacy</h3>
        <p class="muted">
          Complete magnet URIs are visible only on the tokenized management page
          and are never written to logs.
        </p>
      </aside>
    </div>
  `;
}

function CachedFilesTable({ state, cache }) {
  const [busy, run] = useInspect(state);
  const [, play] = usePlayHere(state);
  return html`
    <div class="toolbar">
      <div>
        <h2>Selected files</h2>
        <span class="muted">
          From the last inspection, ${agoLabel(cache.inspectedAt)}
        </span>
      </div>
      <button class="primary" disabled=${busy} onClick=${() => run(false)}>
        ${busy ? "Inspecting files…" : "Inspect to edit"}
      </button>
    </div>
    ${
      state.inspectionError
        ? html`<p class="danger">${state.inspectionError}</p>`
        : null
    }
    <div class="panel tablewrap">
      <table class="files">
        <thead>
          <tr>
            <th>File</th>
            <th>Size</th>
            <th>Season</th>
            <th>Episode</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          ${cache.selectedFiles.map(
            (f) => html`
              <tr key=${f.id}>
                <td class="filename">${f.path}</td>
                <td>${fmt(f.length)}</td>
                <td>${f.season ?? "—"}</td>
                <td>${f.episode ?? "—"}</td>
                <td>
                  <button
                    class="secondary"
                    title="Play this file on this Mac"
                    onClick=${() => play(f.id)}
                  >
                    ▶
                  </button>
                </td>
              </tr>
            `,
          )}
        </tbody>
      </table>
      <p class="muted" style="margin-bottom:0">
        Inspect again to change which files are used or remap episodes.
      </p>
    </div>
  `;
}

function MappingTable({ state }) {
  const tableRef = useRef(null);
  const [busy, run] = useInspect(state);
  const overrides = new Map(
    (state.selected.fileOverrides || []).map((x) => [x.id, x]),
  );
  const automap = async () => {
    setState({
      selected: await patch(state, { fileOverrides: [] }),
      inspection: null,
    });
    await run(false);
  };
  const saveMap = async () => {
    const fileOverrides = [
      ...tableRef.current.querySelectorAll("[data-file]"),
    ].map((r) => ({
      id: Number(r.dataset.file),
      included: r.querySelector(".include").checked,
      season: Number(r.querySelector(".season").value),
      episode: Number(r.querySelector(".episode").value),
    }));
    setState({
      selected: await patch(state, { fileOverrides }),
      inspection: null,
    });
    notify("Mapping saved");
    await run(false);
  };
  return html`
    <div class="toolbar">
      <div>
        <h2>Files & episode mapping</h2>
        <span class="muted">${state.inspection.files.length} files found</span>
      </div>
      <button class="secondary" disabled=${busy} onClick=${automap}>
        Restore automatic mapping
      </button>
    </div>
    <div class="panel tablewrap">
      <table class="files" ref=${tableRef}>
        <thead>
          <tr>
            <th>Use</th>
            <th>File</th>
            <th>Size</th>
            <th>Season</th>
            <th>Episode</th>
          </tr>
        </thead>
        <tbody>
          ${state.inspection.files.map((f, i) => {
            const o = overrides.get(f.id);
            const s = state.inspection.selectedFiles.find((x) => x.id === f.id);
            return html`
              <tr key=${f.id} data-file=${f.id}>
                <td>
                  <input
                    class="include"
                    type="checkbox"
                    checked=${o?.included ?? Boolean(s)}
                  />
                </td>
                <td class="filename">${f.path}</td>
                <td>${fmt(f.length)}</td>
                <td>
                  <input
                    class="season"
                    type="number"
                    min="1"
                    value=${o?.season || s?.season || 1}
                  />
                </td>
                <td>
                  <input
                    class="episode"
                    type="number"
                    min="1"
                    value=${o?.episode || s?.episode || i + 1}
                  />
                </td>
              </tr>
            `;
          })}
        </tbody>
      </table>
      <div class="row" style="margin-top:18px">
        <span></span>
        <button class="primary" disabled=${busy} onClick=${saveMap}>
          Save mapping
        </button>
      </div>
    </div>
  `;
}

function FilesTab({ state }) {
  if (state.inspection) return html`<${MappingTable} state=${state} />`;
  const cache = state.selected.inspectionCache;
  if (cache) return html`<${CachedFilesTable} state=${state} cache=${cache} />`;
  return html`<${InspectionPrompt}
    state=${state}
    title="Inspect files first"
    description="Load source metadata to choose files and map episodes."
    technical=${false}
  />`;
}

const DIRECT_PLAY_TEXT = {
  direct: "Supported",
  caution: "Check device",
  risky: "May stutter",
};

function verdictTitle(t, dp, ready, needed) {
  if (t.error) return "Analysis incomplete";
  if (dp?.compatibility === "risky") return "May not direct play";
  if (dp?.compatibility === "caution") return "Check compatibility";
  if (ready) return "Likely to direct play";
  if (needed) return "Connection may be too slow";
  return "Compatibility unknown";
}

function verdictBody(t, dp, ready, needed) {
  if (dp?.warnings?.length)
    return html`<ul class="muted">
      ${dp.warnings.map((w) => html`<li>${w}</li>`)}
    </ul>`;
  return html`<p class="muted">
    ${
      ready
        ? "Your configured home speed meets the recommended 1.5× bitrate target."
        : needed
          ? "Recommended speed is above your configured home speed. Playback may buffer."
          : "A bitrate estimate was unavailable. Test playback on the target device."
    }
  </p>`;
}

async function testPlayback(state) {
  const f = state.inspection.selectedFiles[0];
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
}

function PlaybackTab({ state }) {
  const [busy, run] = useInspect(state);
  const [playing, play] = usePlayHere(state);
  if (!state.inspection?.technical)
    return html`<${InspectionPrompt}
      state=${state}
      title=${state.inspection ? "Analyze playback" : "Inspect for playback"}
      description=${
        state.inspection
          ? "File metadata is ready. Analyze the selected video for compatibility and speed guidance."
          : "Inspect files and analyze the selected video."
      }
      technical
    />`;
  const f = state.inspection.selectedFiles[0];
  const t = state.inspection.technical || {};
  const dp = state.inspection.directPlay;
  const needed = t.recommendedMbps;
  const ready = needed && state.inspection.homeSpeedMbps >= needed;
  const metrics = [
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
    [
      "Direct play",
      dp ? DIRECT_PLAY_TEXT[dp.compatibility] || "Unknown" : "Unknown",
    ],
    ["Selected files", state.inspection.selectedFiles.length],
  ];
  return html`
    <div class="layout">
      <div>
        <div class="panel">
          <div class="head">
            <div>
              <h2>Playback analysis</h2>
              <p class="muted">${f?.path || "No selected file"}</p>
            </div>
            <button
              class="secondary"
              disabled=${busy}
              onClick=${() => run(true)}
            >
              ${busy ? "Analyzing playback…" : "Refresh analysis"}
            </button>
          </div>
          ${t.error ? html`<p class="danger">${t.error}</p>` : null}
          <div class="metrics">
            ${metrics.map(
              ([label, value]) => html`
                <div class="metric">
                  <span class="muted">${label}</span>
                  <strong>${value}</strong>
                </div>
              `,
            )}
          </div>
          <div class="actions">
            <button
              class="primary"
              disabled=${playing}
              onClick=${() => play(f?.id)}
            >
              ${playing ? "Starting…" : "▶ Play this file"}
            </button>
            <button class="secondary" onClick=${() => testPlayback(state)}>
              Test playback
            </button>
          </div>
        </div>
        <div class="panel route" style="margin-top:18px">
          <span>HoshiStream</span>→<span>
            ${
              state.selected.localFilePath || state.selected.localFolderPath
                ? "Local file"
                : "TorrServer"
            } </span
          >→<span>Player</span>
        </div>
      </div>
      <aside class="panel">
        <h3>${verdictTitle(t, dp, ready, needed)}</h3>
        ${verdictBody(t, dp, ready, needed)}
        <p class="muted">
          Direct play needs the player to support the listed codecs. When stream
          repair is enabled, incompatible entries also get a "Compatible" stream
          in Stremio.
        </p>
        ${
          state.status.transcode?.enabled
            ? html`<label class="picker-row" style="margin-top:8px">
                <input
                  type="checkbox"
                  checked=${Boolean(state.selected.forceTranscode)}
                  onChange=${async (e) => {
                    try {
                      setState({
                        selected: await patch(state, {
                          forceTranscode: e.target.checked,
                        }),
                      });
                      notify(
                        e.target.checked
                          ? "Compatible stream always offered"
                          : "Compatible stream only on predicted failure",
                      );
                    } catch (error) {
                      notify(error.message);
                    }
                  }}
                />
                <span class="muted">Always offer the Compatible stream</span>
              </label>`
            : null
        }
      </aside>
    </div>
  `;
}

const TABS = {
  overview: OverviewTab,
  source: SourceTab,
  files: FilesTab,
  playback: PlaybackTab,
};

export function DetailModal() {
  const state = useStore();
  const entry = state.selected;
  const [playing, play] = usePlayHere(state);
  if (!entry) return null;
  const Tab = TABS[state.tab] || OverviewTab;
  const resume =
    entry.playback?.fileId !== undefined || entry.playback?.positionSeconds;
  return html`
    <div
      class="modal-backdrop"
      onClick=${(e) => {
        if (e.target === e.currentTarget) closeDetail();
      }}
      onKeyDown=${(e) => {
        if (e.key === "Escape") closeDetail();
      }}
    >
      <section
        class="modal"
        role="dialog"
        aria-modal="true"
        aria-label=${entry.name + " details"}
      >
        <button
          class="modal-close"
          aria-label="Close"
          ref=${(el) => el?.focus()}
          onClick=${closeDetail}
        >
          ×
        </button>
        <div class="title-row">
          <div class="title-summary">
            ${
              entry.poster
                ? html`<img class="poster" src=${entry.poster} alt="" />`
                : html`<div class="poster placeholder">★</div>`
            }
            <div>
              <h1>${entry.name}</h1>
              <span class="badge">${entry.type}</span>${" "}
              <span class="badge">
                ${
                  entry.localFilePath || entry.localFolderPath
                    ? "Local"
                    : "Torrent"
                }
              </span>
            </div>
          </div>
          <div class="head-actions">
            <button
              class="secondary"
              onClick=${() => {
                const fileId =
                  entry.inspectionCache?.selectedFiles?.[0]?.id ?? 0;
                location.hash =
                  "#/play/" + encodeURIComponent(entry.id) + "/" + fileId;
              }}
            >
              ▶ Watch in browser
            </button>
            <button class="primary" disabled=${playing} onClick=${() => play()}>
              ${
                playing
                  ? "Starting…"
                  : resume
                    ? "▶ Resume on this Mac"
                    : "▶ Play on this Mac"
              }
            </button>
          </div>
        </div>
        <div class="tabs">
          ${Object.keys(TABS).map(
            (tab) => html`
              <button
                class="tab ${state.tab === tab ? "active" : ""}"
                onClick=${() => setState({ tab })}
              >
                ${tab[0].toUpperCase() + tab.slice(1)}
              </button>
            `,
          )}
        </div>
        <section><${Tab} state=${state} /></section>
      </section>
    </div>
  `;
}
