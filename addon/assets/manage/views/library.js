// Library view: grid of titles, search/filter, JSON import/export, and the
// Stremio catalog refresh flow. The import-review and Stremio modals stay as
// body-level DOM (outside the preact root), same as the detail modal.
import { html, useEffect, useState } from "../vendor/preact-htm.js";
import { api, esc, notify, token } from "../api.js";
import { state, setState, useStore, load } from "../store.js";
import { Shell } from "../components/shell.js";
import { classifyLibraryImports } from "../classify-imports.js";
import { AnalysisPanel, unanalyzedCount } from "./analysis.js";
import { openAdd } from "./add.js";

// #/library/analysis (and the old #/system/analysis bookmark) opens the panel.
function analysisRequested() {
  return /^#\/library\/analysis/.test(location.hash);
}

// #/library/tag/<name> (from the Tags page) selects that tag as the filter.
function requestedTag() {
  const match = /^#\/library\/tag\/([^/]+)/.exec(location.hash);
  return match ? decodeURIComponent(match[1]) : undefined;
}

const tagKey = (name) => name.trim().toLocaleLowerCase();

function hasTags(entry, wanted) {
  if (!wanted.length) return true;
  const own = new Set((entry.tags ?? []).map(tagKey));
  return wanted.every((tag) => own.has(tagKey(tag)));
}

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
    '<section class="modal" role="dialog" aria-modal="true" aria-label="Import library"><button class="modal-close" aria-label="Close"><svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path d="M3.5 3.5l9 9M12.5 3.5l-9 9" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg></button><div class="head"><div><h1>Import library</h1><p class="muted">Choose titles to add. Conflicts are unchecked by default.</p></div><button class="primary" id="confirmImport">Import selected</button></div><div class="panel tablewrap"><table class="files"><thead><tr><th>Import</th><th>Title</th><th>Type</th><th>Conflicts</th></tr></thead><tbody>' +
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

function showStremioModal(result) {
  const backdrop = document.createElement("div");
  backdrop.className = "modal-backdrop";
  backdrop.innerHTML =
    '<section class="modal narrow" role="dialog" aria-modal="true" aria-label="Stremio catalog refresh"><button class="modal-close" aria-label="Close"><svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path d="M3.5 3.5l9 9M12.5 3.5l-9 9" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg></button><h2>Catalog ready for Stremio</h2><div class="stats"><div class="stat"><span class="label">Movies</span><span class="value">' +
    result.movies +
    '</span></div><div class="stat"><span class="label">Series</span><span class="value">' +
    result.series +
    '</span></div></div><p class="muted stacked-sm">Validated just now. Stremio has been opened so it can request the current catalog.</p><div class="row"><button class="secondary" id="copyAddon">Copy add-on URL</button><button class="primary" id="openStremio">Open Stremio</button></div></section>';
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
}

async function remove(id) {
  if (!confirm("Delete this title? Original linked files will remain.")) return;
  await api("library/" + encodeURIComponent(id), { method: "DELETE" });
  await load();
}

function openDetail(entry) {
  setState({
    selected: entry,
    tab: "overview",
    inspection: null,
    inspectionError: "",
  });
}

const VERDICT_TONE = { direct: "ok", caution: "warn", risky: "bad" };
const VERDICT_DOTS = {
  direct: ["Direct play", "v direct"],
  caution: ["Check device", "v caution"],
  risky: ["May not play", "v risky"],
};

function clock(seconds) {
  const s = Math.floor(seconds % 60);
  const m = Math.floor((seconds / 60) % 60);
  const h = Math.floor(seconds / 3600);
  return (
    (h ? h + ":" : "") +
    (h ? String(m).padStart(2, "0") : m) +
    ":" +
    String(s).padStart(2, "0")
  );
}

// "Resume 12:34", "Continue S1 E3", or "Continue S1 E3 · 12:34" — whatever
// the saved playback state says. Empty when there is nothing to pick up.
function resumeLabel(entry) {
  const playback = entry.playback;
  if (!playback) return "";
  const position =
    playback.positionSeconds > 15 ? clock(playback.positionSeconds) : "";
  const episode =
    entry.type === "series" && playback.fileId !== undefined
      ? entry.inspectionCache?.selectedFiles?.find(
          (file) => file.id === playback.fileId,
        )
      : undefined;
  if (episode) {
    return (
      "Continue S" +
      episode.season +
      " E" +
      episode.episode +
      (position ? " · " + position : "")
    );
  }
  return position ? "Resume " + position : "";
}

function watchNow(entry) {
  const fileId =
    entry.playback?.fileId ?? entry.inspectionCache?.selectedFiles?.[0]?.id;
  location.hash =
    "#/play/" +
    encodeURIComponent(entry.id) +
    (fileId === undefined ? "" : "/" + fileId);
}

// The hero spotlights the most recently watched or streamed title — host
// playback and streams to any device both count — falling back to the first
// entry with artwork.
function lastActivity(entry) {
  return Math.max(
    Date.parse(entry.playback?.updatedAt ?? 0) || 0,
    Date.parse(entry.lastStreamedAt ?? 0) || 0,
  );
}

function heroEntry(entries) {
  const recent = entries
    .filter((entry) => lastActivity(entry) > 0)
    .sort((a, b) => lastActivity(b) - lastActivity(a));
  return recent[0] ?? entries.find((entry) => entry.poster) ?? entries[0];
}

function Hero({ entry }) {
  if (!entry) return null;
  const verdict = entry.directPlay
    ? VERDICT_DOTS[entry.directPlay.compatibility]
    : undefined;
  const resume = Boolean(resumeLabel(entry));
  return html`
    <section class="hero">
      <div class="hero-glow"></div>
      <div class="hero-in">
        ${
          entry.poster
            ? html`<img class="hero-poster" src=${entry.poster} alt="" />`
            : html`<div class="hero-poster placeholder">★</div>`
        }
        <div>
          <div class="kicker">
            ${
              resume
                ? "Continue watching"
                : entry.lastStreamedAt
                  ? "Recently streamed"
                  : "From your library"
            }
          </div>
          <h1>${entry.name}</h1>
          <div class="meta-line">
            <span>${entry.type === "series" ? "Series" : "Movie"}</span>
            <span>
              ${
                entry.localFilePath || entry.localFolderPath
                  ? "Local"
                  : "Torrent"
              }
            </span>
            ${
              entry.tags?.length
                ? html`<span>${entry.tags.slice(0, 3).join(", ")}</span>`
                : null
            }
            ${
              verdict
                ? html`<span
                    class="status ${VERDICT_TONE[entry.directPlay.compatibility]}"
                  >
                    <i
                      class="dot ${VERDICT_TONE[entry.directPlay.compatibility]}"
                    ></i>
                    ${verdict[0]}
                  </span>`
                : null
            }
          </div>
          <div class="hero-cta">
            <button class="primary" onClick=${() => watchNow(entry)}>
              ${resume ? "▶ " + resumeLabel(entry) : "▶ Watch now"}
            </button>
            <button class="secondary" onClick=${() => openDetail(entry)}>
              Details
            </button>
          </div>
        </div>
      </div>
    </section>
  `;
}

const Card = ({ entry }) => html`
  <article class="card" onClick=${() => openDetail(entry)}>
    <div class="art">
      ${
        entry.poster
          ? html`<img src=${entry.poster} alt="" />`
          : html`<span class="placeholder">★</span>`
      }
      ${
        entry.directPlay
          ? html`<span
              class=${VERDICT_DOTS[entry.directPlay.compatibility][1]}
              title=${VERDICT_DOTS[entry.directPlay.compatibility][0]}
            ></span>`
          : null
      }
      ${
        entry.diskCopy?.desired === "keep"
          ? html`<span class="disk-flag" title="Kept on disk">⛃ disk</span>`
          : null
      }
      <div class="hover-actions">
        <button
          class="danger"
          title="Delete"
          onClick=${(e) => {
            e.stopPropagation();
            remove(entry.id).catch((error) => notify(error.message));
          }}
        >
          ✕
        </button>
      </div>
    </div>
    <h3>${entry.name}</h3>
    <p class="muted">
      ${entry.type === "series" ? "Series" : "Movie"} ·${" "}
      ${entry.localFilePath || entry.localFolderPath ? "Local" : "Torrent"}
    </p>
    ${
      entry.tags?.length
        ? html`<p class="card-tags muted" title=${entry.tags.join(", ")}>
            ${entry.tags.slice(0, 2).join(" · ")}${
              entry.tags.length > 2 ? " +" + (entry.tags.length - 2) : ""
            }
          </p>`
        : null
    }
  </article>
`;

const FILTERS = { all: "All", movie: "Movies", series: "Series" };

export function LibraryView() {
  const { entries, status, query, filter, tagFilter, tags } = useStore();
  const [refreshing, setRefreshing] = useState(false);
  const [showAnalysis, setShowAnalysis] = useState(analysisRequested());
  useEffect(() => {
    const onHash = () => {
      if (analysisRequested()) setShowAnalysis(true);
      const tag = requestedTag();
      if (tag) setState({ tagFilter: [tag] });
    };
    onHash();
    addEventListener("hashchange", onHash);
    return () => removeEventListener("hashchange", onHash);
  }, []);
  const toggleTag = (name) =>
    setState({
      tagFilter: tagFilter.some((tag) => tagKey(tag) === tagKey(name))
        ? tagFilter.filter((tag) => tagKey(tag) !== tagKey(name))
        : [...tagFilter, name],
    });
  // Only tags that are actually on some title are worth a filter chip.
  const usedTags = tags.filter((tag) => tag.count > 0);
  const unanalyzed = unanalyzedCount(entries);
  const visible = entries.filter(
    (e) =>
      (filter === "all" || e.type === filter) &&
      hasTags(e, tagFilter) &&
      e.name.toLowerCase().includes(query.toLowerCase()),
  );
  const refreshStremio = async () => {
    setRefreshing(true);
    try {
      showStremioModal(await api("stremio-refresh", { method: "POST" }));
    } catch (error) {
      notify(error.message);
    } finally {
      setRefreshing(false);
    }
  };
  return html`
    <${Hero} entry=${heroEntry(entries)} />
    <${Shell}
      title="Your Library"
      actions=${html`
        <div class="row">
          <input
            id="importFile"
            type="file"
            accept="application/json,.json"
            hidden
            onChange=${(e) => {
              if (e.target.files[0]) reviewImport(e.target.files[0]);
              e.target.value = "";
            }}
          />
          <button
            class="secondary"
            onClick=${() => document.querySelector("#importFile").click()}
          >
            ⇧ Import JSON
          </button>
          <button class="secondary" onClick=${exportLibrary}>
            ⇩ Export JSON
          </button>
          <button
            class="secondary"
            disabled=${refreshing}
            onClick=${refreshStremio}
          >
            ${refreshing ? "Validating…" : "↻ Refresh Stremio"}
          </button>
          <button
            class=${showAnalysis ? "secondary active" : "secondary"}
            aria-expanded=${showAnalysis}
            onClick=${() => setShowAnalysis(!showAnalysis)}
          >
            ◌ Analyze${unanalyzed ? " · " + unanalyzed : ""}
          </button>
          <button class="primary" onClick=${openAdd}>＋ Add Media</button>
        </div>
      `}
    >
      <div class="controls">
        <div class="row">
          <span class="status ${status.torrServer?.online ? "ok" : "bad"}">
            <i class="dot ${status.torrServer?.online ? "ok" : "bad"}"></i>
            TorrServer ${status.torrServer?.online ? "online" : "offline"}
          </span>
          <span class="inline-note">
            ${
              visible.length === entries.length
                ? entries.length + " titles"
                : visible.length + " of " + entries.length + " titles"
            }
          </span>
        </div>
        <div class="chips">
          ${Object.entries(FILTERS).map(
            ([key, label]) => html`
              <button
                class="chip ${filter === key ? "active" : ""}"
                onClick=${() => setState({ filter: key })}
              >
                ${label}
              </button>
            `,
          )}
        </div>
      </div>
      ${
        usedTags.length
          ? html`<div class="chips wrap tag-filter">
              ${
                tagFilter.length
                  ? html`<button
                      class="chip clear"
                      onClick=${() => setState({ tagFilter: [] })}
                    >
                      ✕ Clear
                    </button>`
                  : null
              }
              ${usedTags.map(
                (tag) => html`
                  <button
                    class="chip ${
                      tagFilter.some((t) => tagKey(t) === tagKey(tag.name))
                        ? "active"
                        : ""
                    }"
                    onClick=${() => toggleTag(tag.name)}
                    key=${tag.name}
                  >
                    ${tag.name} <em>${tag.count}</em>
                  </button>
                `,
              )}
            </div>`
          : null
      }
      ${showAnalysis ? html`<${AnalysisPanel} />` : null}
      <section class="grid">
        ${
          visible.length
            ? visible.map(
                (entry) => html`<${Card} key=${entry.id} entry=${entry} />`,
              )
            : html`<div class="empty">
                No matching
                titles${
                  tagFilter.length ? " with " + tagFilter.join(" + ") : ""
                }.
              </div>`
        }
      </section>
    <//>
  `;
}
