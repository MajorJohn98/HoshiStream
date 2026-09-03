// Detail modal: overview, source, files, storage, and playback tabs for one
// entry. Rendered by App whenever state.selected is set; closing clears it.
import { html, useEffect, useRef, useState } from "../vendor/preact-htm.js";
import { api, fmt, notify, token } from "../api.js";
import { setState, useStore, load } from "../store.js";

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

// All play actions route to the in-browser player (#/play). The external
// player handoff was removed in the 0.12 redesign.
function goWatch(entryId, fileId) {
  location.hash =
    "#/play/" +
    encodeURIComponent(entryId) +
    (fileId === undefined ? "" : "/" + fileId);
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

function shortMagnet(magnetUri) {
  const hash = /btih:([a-z0-9]+)/i.exec(magnetUri)?.[1];
  return hash
    ? "btih:" + hash.slice(0, 12) + "…"
    : magnetUri.slice(0, 40) + "…";
}

// Extra torrents merged into a series entry. Any change clears the inspection
// cache server-side, so prompt for a fresh inspection afterwards.
function ExtraSourcesPanel({ state }) {
  const entry = state.selected;
  const [magnet, setMagnet] = useState("");
  const [season, setSeason] = useState("");
  const [saving, setSaving] = useState(false);
  const extras = entry.extraSources || [];
  const save = async (extraSources) => {
    setSaving(true);
    try {
      const selected = await patch(state, { extraSources });
      setState({ selected, inspection: null });
      setMagnet("");
      setSeason("");
      notify("Sources updated — inspect again to refresh episodes");
    } catch (error) {
      notify(error.message);
    } finally {
      setSaving(false);
    }
  };
  return html`
    <div style="margin-top:16px">
      <h3>Additional torrents</h3>
      <p class="muted">
        Merged into this series' episode list. Season applies to files whose
        names carry no SxxEyy numbering; on episode conflicts the newest source
        wins.
      </p>
      ${extras.map(
        (extra, index) => html`
          <div class="picker-row" style="margin-bottom:8px">
            <span class="muted" style="flex:1">
              ${
                extra.magnetUri
                  ? shortMagnet(extra.magnetUri)
                  : extra.torrentFilePath
              }
              ${
                extra.seasonHint !== undefined
                  ? " · season " + extra.seasonHint
                  : ""
              }
            </span>
            <button
              class="secondary"
              disabled=${saving}
              onClick=${() => save(extras.filter((_, i) => i !== index))}
            >
              Remove
            </button>
          </div>
        `,
      )}
      <div class="picker-row">
        <input
          style="flex:1"
          placeholder="magnet:?xt=urn:btih:…"
          value=${magnet}
          onInput=${(e) => setMagnet(e.target.value)}
        />
        <input
          style="width:90px"
          type="number"
          min="0"
          placeholder="Season"
          value=${season}
          onInput=${(e) => setSeason(e.target.value)}
        />
        <button
          class="secondary"
          disabled=${saving || !magnet.trim().startsWith("magnet:?")}
          onClick=${() =>
            save([
              ...extras,
              {
                magnetUri: magnet.trim(),
                ...(season === "" ? {} : { seasonHint: Number(season) }),
              },
            ])}
        >
          Add
        </button>
      </div>
    </div>
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
        ${
          entry.type === "series" &&
          (entry.magnetUri || entry.torrentFilePath) &&
          !entry.localFilePath &&
          !entry.localFolderPath
            ? html`<${ExtraSourcesPanel} state=${state} />`
            : null
        }
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
                    title="Play this file"
                    onClick=${() => goWatch(state.selected.id, f.id)}
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
              onClick=${() => goWatch(state.selected.id, f?.id)}
            >
              ▶ Play this file
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

// Disk copy: keep this entry's files on a registered storage volume.
// Playback prefers the disk copy whenever the drive is connected and falls
// back to the torrent otherwise — same stream URL either way.
const FILE_STATE_ICONS = {
  complete: "✓",
  partial: "◔",
  missing: "○",
  invalid: "⚠",
};

function manifestSourceKey(cacheHash, file) {
  return (file.hash ?? cacheHash) + ":" + (file.id % 100000);
}

function episodeLabel(cache, manifestFile) {
  const selected = cache?.selectedFiles?.find(
    (file) => manifestSourceKey(cache.hash, file) === manifestFile.sourceKey,
  );
  const name = manifestFile.relativePath.split("/").pop();
  if (selected?.season !== undefined && selected?.episode !== undefined) {
    return "S" + selected.season + "E" + selected.episode + " · " + name;
  }
  return name;
}

function StorageTab({ state }) {
  const entry = state.selected;
  const diskCopy = entry.diskCopy;
  const [volumes, setVolumes] = useState(null);
  const [volumeId, setVolumeId] = useState(diskCopy?.volumeId ?? "");
  const [picking, setPicking] = useState(diskCopy?.scope === "selected");
  const [picked, setPicked] = useState(
    () =>
      new Set(
        (diskCopy?.files ?? [])
          .filter((file) => file.included)
          .map((file) => file.sourceKey),
      ),
  );
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    api("volumes")
      .then((report) => setVolumes(report.volumes))
      .catch(() => setVolumes([]));
  }, []);
  const torrentBacked =
    (entry.magnetUri || entry.torrentFilePath) &&
    !entry.localFilePath &&
    !entry.localFolderPath;
  if (!torrentBacked) {
    return html`<div class="panel">
      <p class="muted">
        Disk copies apply to torrent-backed entries — local entries already play
        from disk.
      </p>
    </div>`;
  }
  const put = async (body, message) => {
    setBusy(true);
    try {
      const updated = await api(
        "library/" + encodeURIComponent(entry.id) + "/disk-copy",
        {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        },
      );
      setState({ selected: updated });
      void load();
      if (message) notify(message);
    } catch (error) {
      notify(error.message);
    } finally {
      setBusy(false);
    }
  };
  const retry = async () => {
    setBusy(true);
    try {
      const updated = await api(
        "library/" + encodeURIComponent(entry.id) + "/disk-copy/retry",
        { method: "POST" },
      );
      setState({ selected: updated });
      void load();
      notify("Reconciled — archiving resumes");
    } catch (error) {
      notify(error.message);
    } finally {
      setBusy(false);
    }
  };
  const volume = volumes?.find(
    (candidate) => candidate.id === diskCopy?.volumeId,
  );

  if (!diskCopy) {
    return html`<div class="panel">
      <h2>Keep on disk</h2>
      <p class="muted">
        Copy this entry to a storage volume. When the drive is connected,
        playback streams from disk; when it is not, the torrent takes over
        automatically.
      </p>
      ${
        volumes === null
          ? html`<p class="muted">Loading volumes…</p>`
          : volumes.length === 0
            ? html`<p class="muted">
                No storage registered yet — add a drive or folder on the Storage
                page first.
              </p>`
            : html`<div class="row" style="gap:8px;align-items:center">
                <select
                  value=${volumeId}
                  onChange=${(event) => setVolumeId(event.target.value)}
                >
                  <option value="">Choose a volume…</option>
                  ${volumes.map(
                    (candidate) =>
                      html`<option value=${candidate.id}>
                        ${candidate.label}
                        ${candidate.state === "online" ? "" : " (offline)"}
                      </option>`,
                  )}
                </select>
                <button
                  class="primary"
                  disabled=${busy || !volumeId}
                  onClick=${() =>
                    put(
                      { enabled: true, volumeId },
                      "Keeping on disk — archiving starts now",
                    )}
                >
                  Keep on disk
                </button>
              </div>`
      }
    </div>`;
  }

  const files = diskCopy.files;
  const included = files.filter((file) => file.included);
  const complete = included.filter((file) => file.state === "complete");
  const troubled = included.filter(
    (file) => file.state === "invalid" || file.state === "missing",
  );
  const togglePicked = (key) => {
    const next = new Set(picked);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    setPicked(next);
  };
  const seasonOf = (file) => {
    const selected = entry.inspectionCache?.selectedFiles?.find(
      (candidate) =>
        manifestSourceKey(entry.inspectionCache.hash, candidate) ===
        file.sourceKey,
    );
    return selected?.season;
  };
  const seasons = [
    ...new Set(files.map(seasonOf).filter((season) => season !== undefined)),
  ].sort((a, b) => a - b);
  const toggleSeason = (season) => {
    const keys = files
      .filter((file) => seasonOf(file) === season)
      .map((file) => file.sourceKey);
    const next = new Set(picked);
    const allPicked = keys.every((key) => next.has(key));
    for (const key of keys) {
      if (allPicked) next.delete(key);
      else next.add(key);
    }
    setPicked(next);
  };
  return html`<div class="panel">
    <h2>Keep on disk</h2>
    <div class="statusbar">
      <span class="badge">
        ${
          volume
            ? volume.label +
              (volume.state === "online" ? "" : " · drive offline")
            : "Volume " + diskCopy.volumeId.slice(0, 8)
        }
      </span>
      <span class="badge">
        ${
          complete.length === included.length
            ? "On disk ✓"
            : complete.length + " of " + included.length + " files on disk"
        }
      </span>
      ${
        troubled.some((file) => file.state === "invalid")
          ? html`<span class="badge">Needs attention</span>`
          : null
      }
    </div>
    ${
      entry.type === "series" && files.length > 1
        ? html`<div style="margin-top:12px">
            <label style="display:flex;gap:6px;align-items:center">
              <input
                type="checkbox"
                checked=${picking}
                onChange=${(event) => setPicking(event.target.checked)}
              />
              Only selected episodes
            </label>
            ${
              picking
                ? html`
                    ${
                      seasons.length > 1
                        ? html`<div class="row" style="gap:6px;margin-top:8px">
                            ${seasons.map(
                              (season) =>
                                html`<button
                                  class="secondary"
                                  onClick=${() => toggleSeason(season)}
                                >
                                  Season ${season}
                                </button>`,
                            )}
                          </div>`
                        : null
                    }
                    <ul class="plain-list" style="margin-top:8px">
                      ${files.map(
                        (file) =>
                          html`<li>
                            <label
                              style="display:flex;gap:6px;align-items:center"
                            >
                              <input
                                type="checkbox"
                                checked=${picked.has(file.sourceKey)}
                                onChange=${() => togglePicked(file.sourceKey)}
                              />
                              ${FILE_STATE_ICONS[file.state]}${" "}
                              ${episodeLabel(entry.inspectionCache, file)}
                              <span class="muted">${fmt(file.length)}</span>
                            </label>
                          </li>`,
                      )}
                    </ul>
                    <button
                      class="primary"
                      disabled=${busy || picked.size === 0}
                      onClick=${() =>
                        put(
                          {
                            enabled: true,
                            volumeId: diskCopy.volumeId,
                            scope: "selected",
                            includedSourceKeys: [...picked],
                          },
                          "Selection saved",
                        )}
                    >
                      Apply selection
                    </button>
                  `
                : diskCopy.scope === "selected"
                  ? html`<button
                      class="secondary"
                      disabled=${busy}
                      onClick=${() =>
                        put(
                          {
                            enabled: true,
                            volumeId: diskCopy.volumeId,
                            scope: "all",
                          },
                          "Keeping every episode",
                        )}
                    >
                      Switch back to all episodes
                    </button>`
                  : null
            }
          </div>`
        : html`<ul class="plain-list" style="margin-top:12px">
            ${included.map(
              (file) =>
                html`<li>
                  ${FILE_STATE_ICONS[file.state]}${" "}
                  ${episodeLabel(entry.inspectionCache, file)}
                  <span class="muted">${fmt(file.length)}</span>
                </li>`,
            )}
          </ul>`
    }
    <div class="row" style="gap:8px;margin-top:14px">
      ${
        troubled.length
          ? html`<button class="secondary" disabled=${busy} onClick=${retry}>
              Retry missing files
            </button>`
          : null
      }
      <button
        class="secondary"
        disabled=${busy}
        onClick=${() => put({ enabled: false }, "Stopped — files kept")}
      >
        Stop (keep files)
      </button>
      <button
        class="secondary"
        disabled=${busy}
        onClick=${() => {
          if (
            confirm(
              "Delete the copied files from " +
                (volume?.label ?? "the drive") +
                "? The torrent source stays in your library." +
                (volume?.state === "online"
                  ? ""
                  : " The drive is offline, so deletion runs when it returns."),
            )
          )
            put(
              { enabled: false, deleteFiles: true },
              "Stopped — files will be removed",
            );
        }}
      >
        Stop and delete files
      </button>
    </div>
  </div>`;
}

// The entry sheet: a full-screen overlay media page. The hero keeps Play as
// the unmistakable primary action; admin work lives in stacked sections with
// sticky chips instead of tabs, so everything about one title is a single
// scroll. state.tab (set by HUD/System deep links) picks the initial section.
const SECTIONS = [
  ["overview", "Details", OverviewTab],
  ["storage", "Keep on disk", StorageTab],
  ["source", "Source", SourceTab],
  ["files", "Files", FilesTab],
  ["playback", "Playback check", PlaybackTab],
];

const VERDICTS = {
  direct: ["Direct play", "direct"],
  caution: ["Check device", "caution"],
  risky: ["May not play", "risky"],
};

function diskBadge(entry) {
  const diskCopy = entry.diskCopy;
  if (diskCopy?.desired !== "keep") return null;
  const included = diskCopy.files.filter((file) => file.included);
  const complete = included.filter((file) => file.state === "complete");
  return complete.length === included.length
    ? "On disk ✓"
    : "Disk " + complete.length + "/" + included.length;
}

export function DetailSheet() {
  const state = useStore();
  const entry = state.selected;
  useEffect(() => {
    if (!entry) return;
    if (state.tab && state.tab !== "overview") {
      document
        .querySelector("#section-" + state.tab)
        ?.scrollIntoView({ block: "start" });
    }
  }, [entry?.id]);
  if (!entry) return null;
  const resume =
    entry.playback?.fileId !== undefined || entry.playback?.positionSeconds;
  const verdict = entry.directPlay && VERDICTS[entry.directPlay.compatibility];
  const disk = diskBadge(entry);
  const jump = (key) => (event) => {
    event.preventDefault();
    document
      .querySelector("#section-" + key)
      ?.scrollIntoView({ behavior: "smooth", block: "start" });
  };
  return html`
    <div
      class="sheet-backdrop"
      onClick=${(e) => {
        if (e.target === e.currentTarget) closeDetail();
      }}
      onKeyDown=${(e) => {
        if (e.key === "Escape") closeDetail();
      }}
    >
      <section
        class="sheet"
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
        <header
          class="sheet-hero"
          style=${
            entry.background || entry.poster
              ? "background-image:url('" +
                encodeURI(entry.background || entry.poster) +
                "')"
              : ""
          }
        >
          <div class="sheet-hero-scrim">
            <div class="title-summary">
              ${
                entry.poster
                  ? html`<img class="poster" src=${entry.poster} alt="" />`
                  : html`<div class="poster placeholder">★</div>`
              }
              <div>
                <h1>${entry.name}</h1>
                <div class="hero-meta">
                  <span class="badge">
                    ${entry.type === "series" ? "Series" : "Movie"}
                  </span>
                  <span class="badge">
                    ${
                      entry.localFilePath || entry.localFolderPath
                        ? "Local"
                        : "Torrent"
                    }
                  </span>
                  ${
                    verdict
                      ? html`<span class="badge ${verdict[1]}">
                          ● ${verdict[0]}
                        </span>`
                      : null
                  }
                  ${disk ? html`<span class="badge disk">${disk}</span>` : null}
                </div>
                <div class="hero-cta">
                  <button
                    class="primary"
                    onClick=${() => {
                      const fileId =
                        entry.playback?.fileId ??
                        entry.inspectionCache?.selectedFiles?.[0]?.id;
                      goWatch(entry.id, fileId);
                    }}
                  >
                    ${resume ? "▶ Resume" : "▶ Watch now"}
                  </button>
                </div>
              </div>
            </div>
          </div>
        </header>
        <nav class="section-chips sheet-chips">
          ${SECTIONS.map(
            ([key, label]) => html`
              <a class="chip" href="#" onClick=${jump(key)}>${label}</a>
            `,
          )}
        </nav>
        <div class="sheet-body">
          ${SECTIONS.map(
            ([key, label, Section]) => html`
              <section class="sheet-section" id=${"section-" + key} key=${key}>
                <h2 class="section-title">${label}</h2>
                <${Section} state=${state} />
              </section>
            `,
          )}
        </div>
      </section>
    </div>
  `;
}
