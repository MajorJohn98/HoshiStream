// Detail modal: overview, source, files, storage, and playback tabs for one
// entry. Rendered by App whenever state.selected is set; closing clears it.
import { html, useEffect, useRef, useState } from "../vendor/preact-htm.js";
import { api, fmt, notify, token } from "../api.js";
import { closeDetailRoute } from "../entry-route.js";
import { state, setState, useStore, load } from "../store.js";
import { TagPicker } from "../components/tag-picker.js";
import { editableSource } from "../import-state.js";
import {
  describeGaps,
  mappingIssues,
  mappingPatch,
  mappingRows,
  shiftEpisodes,
} from "./episode-mapping.js";
import {
  POSTER_SHAPES,
  joinNameList,
  joinTrailers,
  metadataPatch,
} from "./title-metadata.js";
import { policySummary } from "./disk-policy.js";
import {
  dateFromReleased,
  episodeKey,
  episodesPatch,
  thumbnailSummary,
} from "./episodes.js";
import {
  SourceCheckPanel,
  pickSourceCheckFileId,
  sourceCheckBadge,
} from "../components/source-check.js";

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
  const next = closeDetailRoute();
  if (next !== location.hash) location.replace(next);
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

function syncSelectedEntry(entry) {
  setState({
    selected: entry,
    entries: state.entries.map((item) => (item.id === entry.id ? entry : item)),
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

// One section of the sheet: small-caps title, optional note and status on the
// left, the section's primary action on the right — same head the pages use.
function Section({ id, title, note, aside, action, children }) {
  return html`
    <section class="sheet-section" id=${"section-" + id}>
      <div class="section-head">
        <div>
          <h2 class="section-title">${title}</h2>
          ${note ? html`<p class="muted">${note}</p>` : null}
        </div>
        <div class="row">${aside}${action}</div>
      </div>
      ${children}
    </section>
  `;
}

function InspectButton({ state, technical, primary = true }) {
  const [busy, run] = useInspect(state);
  const label = busy
    ? technical
      ? "Analyzing…"
      : "Inspecting…"
    : technical
      ? "Analyze playback"
      : "Inspect source";
  return html`<button
    class=${primary ? "primary" : "secondary"}
    disabled=${busy}
    onClick=${() => run(technical)}
  >
    ${label}
  </button>`;
}

function NotYet({ state, children }) {
  return html`
    <p class="empty quiet">${children}</p>
    ${
      state.inspectionError
        ? html`<p class="danger">${state.inspectionError}</p>`
        : null
    }
  `;
}

// "from Cinemeta" hint for fields enrichment wrote; viewer edits drop the hint.
function fetchedHint(entry, field) {
  return entry.metadata?.owned?.includes(field)
    ? html`<span class="meta">from Cinemeta</span>`
    : null;
}

function candidateLabel(candidate) {
  return candidate.releaseInfo
    ? candidate.name + " (" + candidate.releaseInfo + ")"
    : candidate.name;
}

function MatchCard({ state }) {
  const entry = state.selected;
  const meta = entry.metadata;
  const [settings, setSettings] = useState(null);
  const [busy, setBusy] = useState(false);
  const [searching, setSearching] = useState(false);
  const [results, setResults] = useState(null);
  const [query, setQuery] = useState("");
  useEffect(() => {
    api("metadata/settings").then(setSettings, () => setSettings(null));
  }, []);
  useEffect(() => {
    setSearching(false);
    setResults(null);
    setQuery("");
  }, [entry.id]);
  const enabled = Boolean(settings?.enabled);
  const base = "library/" + encodeURIComponent(entry.id) + "/metadata";
  const refetchEntry = async () =>
    syncSelectedEntry(await api("library/" + encodeURIComponent(entry.id)));
  // A freshly added title is usually mid-fetch; poll briefly for the result.
  const pending =
    enabled &&
    !meta &&
    Boolean(settings.autoOnAdd) &&
    Date.now() - Date.parse(entry.createdAt) < 60_000;
  useEffect(() => {
    if (!pending) return undefined;
    const timer = setInterval(() => void refetchEntry().catch(() => {}), 2000);
    return () => clearInterval(timer);
  }, [pending, entry.id]);
  if (!enabled) return null;

  const run = async (fn, message) => {
    setBusy(true);
    try {
      await fn();
      await refetchEntry();
      if (message) notify(message);
    } catch (error) {
      notify(error.message);
    } finally {
      setBusy(false);
    }
  };
  const post = (path, body) =>
    api(path, {
      method: "POST",
      headers: body ? { "content-type": "application/json" } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
  const apply = (imdbId) =>
    run(async () => {
      const outcome = await post(base + "/apply", { imdbId });
      setSearching(false);
      setResults(null);
      return outcome;
    }, "Details fetched");
  const refresh = () => run(() => post(base + "/refresh"), "Details refreshed");
  const unlink = () =>
    run(() => api(base, { method: "DELETE" }), "Fetched details removed");
  const fetchNow = () => run(() => post(base + "/refresh"));
  const search = async (event) => {
    event?.preventDefault();
    setBusy(true);
    try {
      const q = query.trim();
      setResults(
        await api(base + "/search" + (q ? "?q=" + encodeURIComponent(q) : "")),
      );
    } catch (error) {
      notify(error.message);
    } finally {
      setBusy(false);
    }
  };

  const candidates = results?.candidates ?? meta?.candidates ?? [];
  const showPicker = searching || meta?.status === "needs-review";
  const status = () => {
    if (pending) return html`<span>Fetching details…</span>`;
    if (!meta) return html`<span>Not fetched yet.</span>`;
    switch (meta.status) {
      case "matched":
        return html`<span>
          IMDb <span class="mono">${meta.imdbId}</span>
          ${meta.fetchedAt ? " · fetched " + agoLabel(meta.fetchedAt) : ""}
        </span>`;
      case "needs-review":
        return html`<span
          >Several titles matched — pick the right one below.</span
        >`;
      case "unavailable":
        return html`<span
          >Cinemeta could not be
          reached${
            meta.imdbId ? "; keeping the last fetched details" : ""
          }.</span
        >`;
      default:
        return html`<span>No match found for “${meta.query?.title}”.</span>`;
    }
  };

  return html`
    <div class="stacked-sm" id="match-card">
      <div class="row between">
        <div class="stacked-xs">
          <span class="field-label">Match</span>
          <span class="muted">${status()}</span>
        </div>
        <div class="row tight">
          ${
            meta?.imdbId
              ? html`
                  <button
                    type="button"
                    class="secondary"
                    disabled=${busy}
                    onClick=${refresh}
                  >
                    ${busy ? "Working…" : "Refresh"}
                  </button>
                  <button
                    type="button"
                    class="secondary"
                    disabled=${busy}
                    onClick=${() => {
                      setSearching(true);
                      void search();
                    }}
                  >
                    Change match
                  </button>
                  <button
                    type="button"
                    class="secondary danger"
                    disabled=${busy}
                    onClick=${unlink}
                    title="Remove fetched details; anything you typed stays"
                  >
                    Unlink
                  </button>
                `
              : html`
                  <button
                    type="button"
                    class="secondary"
                    disabled=${busy}
                    onClick=${fetchNow}
                  >
                    ${busy ? "Fetching…" : "Fetch details"}
                  </button>
                  <button
                    type="button"
                    class="secondary"
                    disabled=${busy}
                    onClick=${() => {
                      setSearching(true);
                      void search();
                    }}
                  >
                    Search…
                  </button>
                `
          }
        </div>
      </div>
      ${
        showPicker
          ? html`
              <form class="picker-row" onSubmit=${search}>
                <input
                  class="grow"
                  placeholder=${"Search Cinemeta for " + entry.type + "s…"}
                  value=${query}
                  onInput=${(e) => setQuery(e.target.value)}
                />
                <button class="secondary" disabled=${busy}>Search</button>
                <button
                  type="button"
                  class="secondary"
                  onClick=${() => {
                    setSearching(false);
                    setResults(null);
                  }}
                >
                  Close
                </button>
              </form>
              ${
                candidates.length
                  ? html`<ul class="rows compact">
                      ${candidates.map(
                        (c) => html`
                          <li class="rowitem no-lead" key=${c.imdbId}>
                            <span class="main">
                              <strong>${candidateLabel(c)}</strong>
                              <span class="meta mono">${c.imdbId}</span>
                            </span>
                            <span class="trail">
                              <button
                                type="button"
                                class="primary"
                                disabled=${busy}
                                onClick=${() => apply(c.imdbId)}
                              >
                                Use this
                              </button>
                            </span>
                          </li>
                        `,
                      )}
                    </ul>`
                  : results
                    ? html`<p class="muted">
                        No titles found. Try another spelling.
                      </p>`
                    : null
              }
            `
          : null
      }
    </div>
  `;
}

function OverviewTab({ state }) {
  const entry = state.selected;
  const [tags, setTags] = useState(entry.tags ?? []);
  useEffect(() => setTags(entry.tags ?? []), [entry.id]);
  const onSubmit = async (e) => {
    e.preventDefault();
    const d = Object.fromEntries(new FormData(e.target));
    ["poster", "background", "description"].forEach((k) => {
      if (!d[k]) d[k] = null;
    });
    d.tags = tags.length ? tags : null;
    try {
      setState({ selected: await patch(state, d) });
      notify("Changes saved");
      // Tags may have been created inline; refresh the grid and registry.
      void load();
    } catch (error) {
      notify(error.message);
    }
  };
  // Uncontrolled fields use defaultValue: the sheet re-renders on every
  // activity poll, and preact re-syncs a `value` prop to the DOM each time,
  // which would wipe whatever the user is typing.
  return html`
    <${Section}
      id="overview"
      title="Details"
      note="Title, artwork, description, and tags as Stremio sees them."
    >
      <${MatchCard} state=${state} />
      <form class="form-grid" key=${entry.id} onSubmit=${onSubmit}>
        <label> Title<input name="name" defaultValue=${entry.name} /> </label>
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
          Description ${fetchedHint(entry, "description")}
          <textarea name="description">${entry.description || ""}</textarea>
        </label>
        <label>
          Poster URL ${fetchedHint(entry, "poster")}
          <input name="poster" type="url" defaultValue=${entry.poster || ""} />
        </label>
        <label>
          Background URL ${fetchedHint(entry, "background")}
          <input
            name="background"
            type="url"
            defaultValue=${entry.background || ""}
          />
        </label>
        <div class="span2">
          <span class="field-label">Tags ${fetchedHint(entry, "tags")}</span>
          <${TagPicker} value=${tags} onChange=${setTags} />
        </div>
        ${
          entry.magnetUri
            ? html`<label class="span2">
                Magnet link
                <textarea name="magnetUri" required>
${entry.magnetUri}</textarea>
              </label>`
            : null
        }
        <div class="span2 row between">
          <span class="inline-note"
            >Changes apply to Stremio on its next catalog refresh.</span
          >
          <button class="primary">Save changes</button>
        </div>
      </form>
    <//>
  `;
}

function MetadataTab({ state }) {
  const entry = state.selected;
  const onSubmit = async (e) => {
    e.preventDefault();
    try {
      const d = metadataPatch(Object.fromEntries(new FormData(e.target)));
      syncSelectedEntry(await patch(state, d));
      notify("Metadata saved");
    } catch (error) {
      notify(error.message);
    }
  };
  // Uncontrolled fields, for the same reason as OverviewTab.
  return html`
    <${Section}
      id="metadata"
      title="Metadata"
      note="Extra details Stremio shows on the title page. Everything is optional; blanks clear a field."
    >
      <form class="form-grid" key=${entry.id} onSubmit=${onSubmit}>
        <label>
          Year or range ${fetchedHint(entry, "releaseInfo")}
          <input
            name="releaseInfo"
            placeholder="2019 or 2019-2021"
            defaultValue=${entry.releaseInfo || ""}
          />
        </label>
        <label>
          Runtime ${fetchedHint(entry, "runtime")}
          <input
            name="runtime"
            placeholder=${entry.type === "movie" ? "From the probe when blank" : "e.g. 45m"}
            defaultValue=${entry.runtime || ""}
          />
        </label>
        <label>
          Rating (0–10) ${fetchedHint(entry, "imdbRating")}
          <input
            name="imdbRating"
            inputmode="decimal"
            placeholder="7.8"
            defaultValue=${entry.imdbRating || ""}
          />
        </label>
        <label>
          Poster shape
          <select name="posterShape">
            ${POSTER_SHAPES.map(
              ([value, label]) => html`
                <option
                  value=${value}
                  selected=${(entry.posterShape || "poster") === value}
                >
                  ${label}
                </option>
              `,
            )}
          </select>
        </label>
        <label class="span2">
          Cast ${fetchedHint(entry, "cast")}
          <input
            name="cast"
            placeholder="Comma-separated names"
            defaultValue=${joinNameList(entry.cast)}
          />
        </label>
        <label>
          Director ${fetchedHint(entry, "director")}
          <input
            name="director"
            placeholder="Comma-separated"
            defaultValue=${joinNameList(entry.director)}
          />
        </label>
        <label>
          Writer ${fetchedHint(entry, "writer")}
          <input
            name="writer"
            placeholder="Comma-separated"
            defaultValue=${joinNameList(entry.writer)}
          />
        </label>
        <label>
          Country ${fetchedHint(entry, "country")}
          <input name="country" defaultValue=${entry.country || ""} />
        </label>
        <label>
          Language ${fetchedHint(entry, "language")}
          <input name="language" defaultValue=${entry.language || ""} />
        </label>
        <label class="span2">
          Logo URL ${fetchedHint(entry, "logo")}
          <input name="logo" type="url" defaultValue=${entry.logo || ""} />
        </label>
        <label class="span2">
          Awards ${fetchedHint(entry, "awards")}
          <input name="awards" defaultValue=${entry.awards || ""} />
        </label>
        <label class="span2">
          Trailers ${fetchedHint(entry, "trailers")}
          <textarea
            name="trailers"
            placeholder="One YouTube link or id per line"
          >
${joinTrailers(entry.trailers)}</textarea>
        </label>
        <div class="span2 row between">
          <span class="inline-note"
            >Cast and tags become tappable search links in Stremio.</span
          >
          <button class="primary">Save metadata</button>
        </div>
      </form>
    <//>
  `;
}

function shortMagnet(magnetUri) {
  const hash = /btih:([a-z0-9]+)/i.exec(magnetUri)?.[1];
  return hash
    ? "btih:" + hash.slice(0, 12) + "…"
    : magnetUri.slice(0, 40) + "…";
}

// Extra torrents merged into a series entry. Any change clears the inspection
// cache server-side; the server refills it in the background, and Inspect
// joins that run rather than starting another.
function ExtraSourcesPanel({ state }) {
  const entry = state.selected;
  const [magnet, setMagnet] = useState("");
  const [season, setSeason] = useState("");
  const [saving, setSaving] = useState(false);
  const extras = entry.extraSources || [];
  const save = async (extraSources) => {
    setSaving(true);
    try {
      const selected = await patch(state, {
        extraSources: extraSources.map(editableSource),
      });
      setState({ selected, inspection: null });
      setMagnet("");
      setSeason("");
      notify("Sources updated — episodes are refreshing in the background");
    } catch (error) {
      notify(error.message);
    } finally {
      setSaving(false);
    }
  };
  return html`
    <div class="stacked">
      <span class="field-label">Additional torrents</span>
      <p class="muted">
        Merged into this series' episode list. Season applies to files whose
        names carry no SxxEyy numbering; on episode conflicts the newest source
        wins.
      </p>
      ${
        extras.length
          ? html`<ul class="rows compact">
              ${extras.map(
                (extra, index) => html`
                  <li class="rowitem no-lead" key=${index}>
                    <span class="main">
                      <strong class="mono">
                        ${
                          extra.magnetUri
                            ? shortMagnet(extra.magnetUri)
                            : extra.torrentFilePath
                        }
                      </strong>
                      <span class="meta">
                        ${
                          extra.seasonHint !== undefined
                            ? "Season " + extra.seasonHint
                            : "Season from file names"
                        }
                      </span>
                    </span>
                    <span class="trail">
                      <button
                        class="secondary"
                        disabled=${saving}
                        onClick=${() =>
                          save(extras.filter((_, i) => i !== index))}
                      >
                        Remove
                      </button>
                    </span>
                  </li>
                `,
              )}
            </ul>`
          : null
      }
      <div class="picker-row stacked-sm">
        <input
          class="grow"
          placeholder="magnet:?xt=urn:btih:…"
          value=${magnet}
          onInput=${(e) => setMagnet(e.target.value)}
        />
        <input
          class="input-narrow"
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
  const check = entry.sourceCheck;
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
  const kind = entry.magnetUri
    ? "Authorized magnet link"
    : entry.localFolderPath
      ? "Linked series folder"
      : entry.localFilePath
        ? "Linked local file"
        : ".torrent file";
  return html`
    <${Section}
      id="source"
      title="Source"
      note="Where this title's media comes from."
      action=${html`
        <button class="secondary" disabled=${busy} onClick=${() => run(false)}>
          ${busy ? "Inspecting…" : "Inspect again"}
        </button>
        ${
          relinkable
            ? html`<button
                class="secondary"
                disabled=${relinking}
                onClick=${relink}
              >
                ${relinking ? "Waiting for selection…" : "Relink on this computer"}
              </button>`
            : null
        }
      `}
    >
      <dl class="kv">
        <div>
          <dt>Kind</dt>
          <dd>${kind}</dd>
        </div>
        <div>
          <dt>Location</dt>
          <dd>${path || "Editable in Details"}</dd>
        </div>
        ${
          cache
            ? html`<div>
                <dt>Last inspected</dt>
                <dd>
                  ${agoLabel(cache.inspectedAt)} · ${cache.selectedFiles.length}
                  ${" file" + (cache.selectedFiles.length === 1 ? "" : "s")}
                  ${" selected"}
                </dd>
              </div>`
            : null
        }
        <div>
          <dt>Source check</dt>
          <dd>${sourceCheckBadge(check).label}</dd>
        </div>
      </dl>
      ${
        state.inspectionError
          ? html`<p class="danger">${state.inspectionError}</p>`
          : null
      }
      <p class="inline-note stacked-sm">
        Complete magnet URIs are visible only on this tokenized page and are
        never written to logs.
      </p>
      ${
        entry.type === "series" &&
        (entry.magnetUri || entry.torrentFilePath) &&
        !entry.localFilePath &&
        !entry.localFolderPath
          ? html`<${ExtraSourcesPanel} state=${state} />`
          : null
      }
    <//>
  `;
}

// Group files by season for the season tabs. Files without a season (movies,
// unparsed names) show in one list with no tabs.
function seasonsOf(files, seasonOf) {
  const set = new Set();
  for (const file of files) {
    const season = seasonOf(file);
    if (season !== undefined && season !== null) set.add(season);
  }
  return [...set].sort((a, b) => a - b);
}

function useSeasonTabs(files, seasonOf) {
  const seasons = seasonsOf(files, seasonOf);
  const [season, setSeason] = useState(seasons[0]);
  const current = seasons.includes(season) ? season : seasons[0];
  const visible = (file) => seasons.length < 2 || seasonOf(file) === current;
  return { seasons, season: current, setSeason, visible };
}

function SeasonTabs({ seasons, season, onChange, counts }) {
  if (seasons.length < 2) return null;
  return html`
    <div class="subtabs" role="tablist" aria-label="Seasons">
      ${seasons.map(
        (candidate) => html`
          <button
            type="button"
            role="tab"
            aria-selected=${candidate === season}
            class=${candidate === season ? "on" : ""}
            onClick=${() => onChange(candidate)}
            key=${candidate}
          >
            Season ${candidate}
            ${counts ? html`<em>· ${counts(candidate)}</em>` : null}
          </button>
        `,
      )}
    </div>
  `;
}

function baseName(path) {
  return path.split("/").pop();
}

// Watched marks come from observed playback (server side) or this toggle.
// Clearing a mark also forgets a "started" (in-progress) mark.
function useWatchToggle(state) {
  const [pending, setPending] = useState(null);
  const toggle = async (fileId, watched) => {
    setPending(fileId);
    const id = encodeURIComponent(state.selected.id);
    try {
      if (watched) {
        await api("library/" + id + "/watch/" + fileId, { method: "DELETE" });
      } else {
        await api("library/" + id + "/watch", {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ fileId, state: "watched" }),
        });
      }
      const entry = await api("library/" + id);
      syncSelectedEntry(entry);
    } catch (e) {
      notify(e.message, "error");
    } finally {
      setPending(null);
    }
  };
  return [pending, toggle];
}

function watchStateOf(entry, fileId) {
  return entry.watchStates?.find((w) => w.fileId === fileId)?.state;
}

function WatchCell({ state, fileId, pending, toggle }) {
  const current = watchStateOf(state.selected, fileId);
  const watched = current === "watched";
  const label = watched
    ? "Watched"
    : current === "started"
      ? "In progress"
      : "Unwatched";
  return html`
    <td class="watch">
      <button
        class=${"watch-toggle " + (current ?? "unwatched")}
        title=${watched ? "Mark unwatched" : "Mark watched"}
        aria-label=${label + " — " + (watched ? "mark unwatched" : "mark watched")}
        disabled=${pending === fileId}
        onClick=${() => toggle(fileId, watched)}
      >
        <span class="watch-dot" aria-hidden="true"></span>
        ${label}
      </button>
    </td>
  `;
}

function CachedFilesTable({ state, cache }) {
  const [busy, run] = useInspect(state);
  const [pending, toggle] = useWatchToggle(state);
  const n = cache.selectedFiles.length;
  const tabs = useSeasonTabs(cache.selectedFiles, (f) => f.season);
  const shown = cache.selectedFiles.filter(tabs.visible);
  return html`
    <${Section}
      id="files"
      title="Files"
      note=${
        n +
        " file" +
        (n === 1 ? "" : "s") +
        " selected from the last inspection, " +
        agoLabel(cache.inspectedAt) +
        ". Inspect again to change the selection or remap episodes."
      }
      action=${html`<button
        class="secondary"
        disabled=${busy}
        onClick=${() => run(false)}
      >
        ${busy ? "Inspecting…" : "Inspect to edit"}
      </button>`}
    >
      ${
        state.inspectionError
          ? html`<p class="danger">${state.inspectionError}</p>`
          : null
      }
      <${SeasonTabs}
        seasons=${tabs.seasons}
        season=${tabs.season}
        onChange=${tabs.setSeason}
        counts=${(season) =>
          cache.selectedFiles.filter((f) => f.season === season).length}
      />
      <div class="tablewrap scroll-table">
        <table class="files">
          <thead>
            <tr>
              <th>File</th>
              <th>Size</th>
              ${tabs.seasons.length < 2 ? html`<th>Season</th>` : null}
              <th>Episode</th>
              <th>Watched</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            ${shown.map(
              (f) => html`
                <tr key=${f.id}>
                  <td class="filename" title=${f.path}>${baseName(f.path)}</td>
                  <td class="num">${fmt(f.length)}</td>
                  ${
                    tabs.seasons.length < 2
                      ? html`<td class="num">${f.season ?? "—"}</td>`
                      : null
                  }
                  <td class="num">${f.episode ?? "—"}</td>
                  <${WatchCell}
                    state=${state}
                    fileId=${f.id}
                    pending=${pending}
                    toggle=${toggle}
                  />
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
      </div>
    <//>
  `;
}

function MappingTable({ state }) {
  const [busy, run] = useInspect(state);
  const initialRows = mappingRows(
    state.inspection.files,
    state.inspection.selectedFiles,
    state.selected.fileOverrides,
  );
  const [rows, setRows] = useState(initialRows);
  const [shiftBy, setShiftBy] = useState(1);
  const issues = mappingIssues(rows);
  const dirty = JSON.stringify(rows) !== JSON.stringify(initialRows);
  const repaired = Boolean(state.selected.episodeOverrides?.length);
  const update = (id, change) =>
    setRows((current) =>
      current.map((row) => (row.id === id ? { ...row, ...change } : row)),
    );
  const automap = async () => {
    setState({
      selected: await patch(state, { fileOverrides: [], episodeOverrides: [] }),
      inspection: null,
    });
    notify("Automatic mapping restored");
    await run(false);
  };
  const saveMap = async () => {
    if (issues.duplicates.size) {
      notify("Two files share one episode. Fix the highlighted rows first.");
      return;
    }
    setState({
      selected: await patch(
        state,
        mappingPatch(rows, initialRows, state.selected),
      ),
      inspection: null,
    });
    notify("Mapping saved");
    await run(false);
  };
  const rowOf = new Map(rows.map((row) => [row.id, row]));
  const seasonOfFile = (f) => rowOf.get(f.id)?.season;
  const tabs = useSeasonTabs(state.inspection.files, seasonOfFile);
  const shift = (direction) => {
    const by = direction * Math.abs(Number(shiftBy) || 0);
    const next = shiftEpisodes(
      rows,
      by,
      (row) => tabs.seasons.length < 2 || row.season === tabs.season,
    );
    if (!next) {
      notify("That shift would push an episode below 1.");
      return;
    }
    setRows(next);
  };
  const scope = tabs.seasons.length < 2 ? "all" : "season " + tabs.season;
  return html`
    <${Section}
      id="files"
      title="Files"
      note=${
        state.inspection.files.length +
        " files found. Choose which to use and map seasons and episodes." +
        (repaired ? " This series has a saved manual mapping." : "")
      }
      action=${html`
        <button class="secondary" disabled=${busy} onClick=${automap}>
          Restore automatic mapping
        </button>
        <button
          class="primary"
          disabled=${busy || !dirty || issues.duplicates.size > 0}
          onClick=${saveMap}
        >
          Save mapping
        </button>
      `}
    >
      <${SeasonTabs}
        seasons=${tabs.seasons}
        season=${tabs.season}
        onChange=${tabs.setSeason}
        counts=${(season) =>
          rows.filter((row) => row.included && row.season === season).length}
      />
      <div class="row mapping-tools">
        <label class="row">
          <span class="muted">Shift episodes (${scope}) by</span>
          <input
            type="number"
            min="1"
            class="shift-by"
            value=${shiftBy}
            onInput=${(e) => setShiftBy(Number(e.target.value))}
          />
        </label>
        <button class="secondary" disabled=${busy} onClick=${() => shift(-1)}>
          − Shift down
        </button>
        <button class="secondary" disabled=${busy} onClick=${() => shift(1)}>
          + Shift up
        </button>
      </div>
      ${
        issues.duplicates.size
          ? html`<p class="inline-note danger-note">
              Two files are mapped to the same episode. Change one of the
              highlighted rows before saving.
            </p>`
          : issues.gaps.length
            ? html`<p class="inline-note muted">
                ${describeGaps(issues.gaps)}. Gaps are allowed; check that
                nothing is mis-numbered.
              </p>`
            : null
      }
      <div class="tablewrap scroll-table">
        <table class="files mapping">
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
            ${state.inspection.files.map((f) => {
              const row = rowOf.get(f.id);
              const dup = issues.duplicates.has(f.id);
              return html`
                <tr
                  key=${f.id}
                  data-file=${f.id}
                  hidden=${!tabs.visible(f)}
                  class=${dup ? "dup" : row.included ? "" : "off"}
                >
                  <td>
                    <input
                      class="include"
                      type="checkbox"
                      checked=${row.included}
                      onChange=${(e) =>
                        update(f.id, { included: e.target.checked })}
                    />
                  </td>
                  <td class="filename" title=${f.path}>${baseName(f.path)}</td>
                  <td class="num">${fmt(f.length)}</td>
                  <td>
                    <input
                      class="season"
                      type="number"
                      min="0"
                      value=${row.season}
                      onInput=${(e) =>
                        update(f.id, { season: Number(e.target.value) })}
                    />
                  </td>
                  <td>
                    <input
                      class="episode"
                      type="number"
                      min="1"
                      value=${row.episode}
                      onInput=${(e) =>
                        update(f.id, { episode: Number(e.target.value) })}
                    />
                  </td>
                </tr>
              `;
            })}
          </tbody>
        </table>
      </div>
    <//>
  `;
}

function FilesTab({ state }) {
  if (state.inspection) return html`<${MappingTable} state=${state} />`;
  const cache = state.selected.inspectionCache;
  if (cache) return html`<${CachedFilesTable} state=${state} cache=${cache} />`;
  return html`
    <${Section}
      id="files"
      title="Files"
      note="Which files play, and how they map to seasons and episodes."
      action=${html`<${InspectButton} state=${state} technical=${false} />`}
    >
      <${NotYet} state=${state}>
        Not inspected yet — load the source's metadata to choose files.
      <//>
    <//>
  `;
}

async function openDirectStream(state) {
  const f =
    (
      state.inspection?.selectedFiles ??
      state.selected.inspectionCache?.selectedFiles
    )?.find((file) => file.id === pickSourceCheckFileId(state.selected)) ??
    state.inspection?.selectedFiles?.[0] ??
    state.selected.inspectionCache?.selectedFiles?.[0];
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
  if (!r.ok)
    throw Error(
      `Could not load stream metadata (HTTP ${r.status}). Open the entry and review its source check.`,
    );
  const payload = await r.json().catch(() => {
    throw Error(
      "Could not read the stream reply. Open the entry and review its source check.",
    );
  });
  const s = payload.streams?.[0];
  if (!s)
    throw Error(
      "No direct stream was returned for this title. Open the entry and review its source check.",
    );
  window.open(s.url, "_blank");
}

// Episodes tab (Phase 13): readable titles, overviews and air dates per
// episode, the Ongoing flag, and thumbnail generation for episodes whose
// media is already on disk. Rows come from /episodes so torrent and local
// series look the same here.
function EpisodesTab({ state }) {
  const entry = state.selected;
  const [data, setData] = useState(null);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const reload = async () => {
    try {
      setData(
        await api("library/" + encodeURIComponent(entry.id) + "/episodes"),
      );
      setError("");
    } catch (err) {
      setError(err.message);
    }
  };
  useEffect(() => {
    setData(null);
    reload();
  }, [entry.id, entry.updatedAt]);
  // Poll while a generation run is in flight so frames appear as they land.
  useEffect(() => {
    if (!data?.thumbnails?.running) return;
    const timer = setInterval(reload, 3000);
    return () => clearInterval(timer);
  }, [data?.thumbnails?.running]);
  const episodes = data?.episodes ?? [];
  const tabs = useSeasonTabs(episodes, (e) => e.season);
  const shown = episodes.filter(tabs.visible);
  const generated = episodes.filter((e) => e.onDisk && e.thumbnail).length;

  const onOngoing = async (e) => {
    try {
      syncSelectedEntry(await patch(state, { ongoing: e.target.checked }));
      notify(
        e.target.checked
          ? "Marked ongoing — Stremio keeps it on the Board"
          : "No longer marked ongoing",
      );
    } catch (err) {
      notify(err.message);
    }
  };
  const onGenerate = async (force) => {
    try {
      await api("library/" + encodeURIComponent(entry.id) + "/thumbnails", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(force ? { force: true } : {}),
      });
      notify("Generating thumbnails");
      await reload();
    } catch (err) {
      notify(err.message);
    }
  };
  const onSubmit = async (e) => {
    e.preventDefault();
    setSaving(true);
    try {
      const fields = Object.fromEntries(new FormData(e.target));
      syncSelectedEntry(
        await patch(state, episodesPatch(fields, shown, entry.episodes)),
      );
      notify("Episode details saved");
    } catch (err) {
      notify(err.message);
    } finally {
      setSaving(false);
    }
  };

  return html`
    <${Section}
      id="episodes"
      title="Episodes"
      note="How each episode reads in Stremio. Blank fields fall back to a title cleaned from the filename."
      action=${html`<label class="check">
        <input
          type="checkbox"
          checked=${Boolean(entry.ongoing)}
          onChange=${onOngoing}
        />
        Ongoing series
      </label>`}
    >
      <div class="section-head stacked-xs">
        <p class="muted">
          ${thumbnailSummary(data?.thumbnails, data?.eligible ?? 0, generated)}
        </p>
        <div class="row">
          <button
            type="button"
            class="secondary"
            disabled=${!data?.eligible || data?.thumbnails?.running}
            onClick=${() => onGenerate(false)}
          >
            Generate thumbnails
          </button>
          ${
            generated
              ? html`<button
                  type="button"
                  class="secondary"
                  disabled=${data?.thumbnails?.running}
                  onClick=${() => onGenerate(true)}
                >
                  Regenerate all
                </button>`
              : null
          }
        </div>
      </div>
      ${error ? html`<p class="danger">${error}</p>` : null}
      ${
        data && !data.inspected
          ? html`<${NotYet} state=${state}>
              Not inspected yet — inspect the source to list its episodes.
            <//>`
          : null
      }
      ${
        data?.inspected && !episodes.length
          ? html`<p class="empty quiet">
              No file is mapped to a season and episode yet. Repair the mapping
              under Files first.
            </p>`
          : null
      }
      ${
        episodes.length
          ? html`
              <form key=${entry.id + ":" + tabs.season} onSubmit=${onSubmit}>
                <${SeasonTabs}
                  seasons=${tabs.seasons}
                  season=${tabs.season}
                  onChange=${tabs.setSeason}
                  counts=${(season) =>
                    episodes.filter((e) => e.season === season).length}
                />
                <div class="tablewrap scroll-table">
                  <table class="files episodes">
                    <thead>
                      <tr>
                        <th>#</th>
                        <th>Frame</th>
                        <th>Title</th>
                        <th>Overview</th>
                        <th>Air date</th>
                      </tr>
                    </thead>
                    <tbody>
                      ${shown.map((row) => {
                        const key = episodeKey(row.season, row.episode);
                        return html`
                          <tr key=${key}>
                            <td class="num" title=${row.path}>
                              ${row.season}×${row.episode}
                            </td>
                            <td>
                              ${
                                row.thumbnail
                                  ? html`<img
                                      class="episode-thumb"
                                      src=${row.thumbnail}
                                      alt=""
                                      loading="lazy"
                                    />`
                                  : html`<span
                                      class="muted"
                                      title=${
                                        row.onDisk
                                          ? "On disk — generate to grab a frame"
                                          : "Not on disk"
                                      }
                                      >${row.onDisk ? "—" : "·"}</span
                                    >`
                              }
                            </td>
                            <td>
                              <input
                                name=${"title:" + key}
                                placeholder=${row.defaultTitle}
                                defaultValue=${row.title || ""}
                                maxlength="200"
                              />
                            </td>
                            <td>
                              <textarea
                                name=${"overview:" + key}
                                rows="1"
                                placeholder="Overview"
                                defaultValue=${row.overview || ""}
                                maxlength="2000"
                              ></textarea>
                            </td>
                            <td>
                              <input
                                type="date"
                                name=${"released:" + key}
                                defaultValue=${dateFromReleased(row.released)}
                              />
                            </td>
                          </tr>
                        `;
                      })}
                    </tbody>
                  </table>
                </div>
                <div class="row stacked-xs">
                  <button class="primary" disabled=${saving}>
                    ${saving ? "Saving…" : "Save episode details"}
                  </button>
                  ${
                    tabs.seasons.length > 1
                      ? html`<span class="muted inline-note">
                          Saves the season shown; other seasons keep their
                          details.
                        </span>`
                      : null
                  }
                </div>
              </form>
            `
          : null
      }
    <//>
  `;
}

function PlaybackTab({ state }) {
  const f =
    state.selected.inspectionCache?.selectedFiles?.find(
      (file) => file.id === pickSourceCheckFileId(state.selected),
    ) ?? state.selected.inspectionCache?.selectedFiles?.[0];
  return html`
    <${Section}
      id="playback"
      title="Playback check"
      note="Keep metadata, sampled-media evidence, and browser support separate. Each check covers only the named file."
    >
      <${SourceCheckPanel}
        entry=${state.selected}
        onEntry=${syncSelectedEntry}
        startOptions=${{
          probe: true,
          ...(pickSourceCheckFileId(state.selected)
            ? { fileId: pickSourceCheckFileId(state.selected) }
            : {}),
        }}
      />
      <div class="actions">
        <button
          class="primary"
          onClick=${() => goWatch(state.selected.id, f?.id)}
        >
          ▶ Play this file
        </button>
        <button
          class="secondary"
          onClick=${() =>
            openDirectStream(state).catch((error) => notify(error.message))}
        >
          Open direct stream
        </button>
      </div>
      <div class="stacked-sm">
        <p class="inline-note">
          Path: HoshiStream →
          ${
            state.selected.localFilePath || state.selected.localFolderPath
              ? "Local file"
              : "TorrServer"
          }
          → Player. Direct playback depends on the player's container and codec
          support. When stream repair is enabled, a "Compatible" stream may also
          be offered; the direct option stays available.
        </p>
        <p class="muted stacked-xs">
          Open direct stream opens the raw media URL in a new tab. It does not
          run a check or automatically assess playback.
        </p>
        ${
          state.status.transcode?.enabled
            ? html`<label class="check stacked-xs">
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
                          : "Compatible stream offered when file metadata suggests repair",
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
      </div>
    <//>
  `;
}

// Disk copy: keep this entry's files on a registered storage volume.
// Playback prefers the disk copy whenever the drive is connected and falls
// back to the torrent otherwise — same stream URL either way.
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
    return html`<${Section}
      id="storage"
      title="Keep on disk"
      note="Copy this title to a storage volume. Playback streams from the drive when it is connected and from the torrent when it is not."
      aside=${html`<span class="status idle">
        <i class="dot idle"></i>Not kept on disk
      </span>`}
    >
      ${
        volumes === null
          ? html`<p class="empty quiet">Loading volumes…</p>`
          : volumes.length === 0
            ? html`<p class="empty quiet">
                No storage registered yet — add a drive or folder on the
                <a href="#/storage">Storage page</a> first.
              </p>`
            : html`<div class="row tight">
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
    <//>`;
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
  const tabs = useSeasonTabs(files, seasonOf);
  const seasons = tabs.seasons;
  const shownFiles = files.filter(tabs.visible);
  const shownIncluded = included.filter(tabs.visible);
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
  const allDone = complete.length === included.length;
  const attention = troubled.some((file) => file.state === "invalid");
  const storageTone = attention ? "warn" : allDone ? "ok" : "idle";
  const fileTone = {
    complete: "ok",
    partial: "warn",
    missing: "idle",
    invalid: "bad",
  };
  const fileLabel = {
    complete: "On disk",
    partial: "Partial",
    missing: "Missing",
    invalid: "Invalid",
  };
  const fileStatus = (file) =>
    !file.included && file.evictedAt
      ? "Evicted " + agoLabel(file.evictedAt)
      : fileLabel[file.state];
  const FileRow = ({ file, pick }) => html`
    <li class="rowitem" key=${file.sourceKey}>
      <span class="lead">
        ${
          pick
            ? html`<input
                type="checkbox"
                checked=${picked.has(file.sourceKey)}
                onChange=${() => togglePicked(file.sourceKey)}
              />`
            : html`<i class="dot ${fileTone[file.state]}"></i>`
        }
      </span>
      <span class="main">
        <strong>${episodeLabel(entry.inspectionCache, file)}</strong>
        <span class="meta">${fileStatus(file)}</span>
      </span>
      <span class="trail"><span class="value">${fmt(file.length)}</span></span>
    </li>
  `;
  return html`<${Section}
    id="storage"
    title="Keep on disk"
    note=${
      volume
        ? "On " +
          volume.label +
          (volume.state === "online" ? "" : " — drive offline")
        : "Volume " + diskCopy.volumeId.slice(0, 8)
    }
    aside=${html`<span class="status ${storageTone}">
      <i class="dot ${storageTone}"></i>
      ${
        attention
          ? "Needs attention"
          : allDone
            ? "On disk"
            : complete.length + " of " + included.length + " files on disk"
      }
    </span>`}
  >
    ${
      entry.type === "series" && files.length > 1
        ? html`<div class="stacked-sm">
            <label class="check">
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
                    <div class="row between stacked-xs">
                      <${SeasonTabs}
                        seasons=${seasons}
                        season=${tabs.season}
                        onChange=${tabs.setSeason}
                        counts=${(season) =>
                          files.filter((file) => seasonOf(file) === season)
                            .length}
                      />
                      ${
                        seasons.length > 1
                          ? html`<button
                              type="button"
                              class="secondary"
                              onClick=${() => toggleSeason(tabs.season)}
                            >
                              Toggle season ${tabs.season}
                            </button>`
                          : null
                      }
                    </div>
                    <ul class="rows compact scroll-list stacked-xs">
                      ${shownFiles.map(
                        (file) => html`<${FileRow} file=${file} pick />`,
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
        : html`
            <${SeasonTabs}
              seasons=${seasons}
              season=${tabs.season}
              onChange=${tabs.setSeason}
              counts=${(season) =>
                included.filter((file) => seasonOf(file) === season).length}
            />
            <ul class="rows compact scroll-list">
              ${shownIncluded.map((file) => html`<${FileRow} file=${file} />`)}
            </ul>
          `
    }
    <div class="row tight stacked">
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
    ${
      entry.type === "series" && files.length > 1
        ? html`<${PolicyBlock} entry=${entry} diskCopy=${diskCopy} />`
        : null
    }
  <//>`;
}

// Rolling window (Phase 8): how many episodes to keep ahead of the last one
// played, and whether watched copies are removed once those are on disk.
function PolicyBlock({ entry, diskCopy }) {
  const policy = diskCopy.policy ?? {};
  const [keepAhead, setKeepAhead] = useState(policy.keepAhead ?? 0);
  const [evictWatched, setEvictWatched] = useState(
    Boolean(policy.evictWatched),
  );
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    setKeepAhead(policy.keepAhead ?? 0);
    setEvictWatched(Boolean(policy.evictWatched));
  }, [policy.keepAhead, policy.evictWatched]);
  const active = (policy.keepAhead ?? 0) > 0 || policy.evictWatched;
  const dirty =
    keepAhead !== (policy.keepAhead ?? 0) ||
    evictWatched !== Boolean(policy.evictWatched);
  const save = async () => {
    setBusy(true);
    try {
      const updated = await api(
        "library/" + encodeURIComponent(entry.id) + "/disk-copy/policy",
        {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ keepAhead, evictWatched }),
        },
      );
      setState({ selected: updated });
      void load();
      notify(
        keepAhead || evictWatched
          ? "Rolling window saved"
          : "Rolling window off",
      );
    } catch (error) {
      notify(error.message);
    } finally {
      setBusy(false);
    }
  };
  return html`<div class="stacked" id="storage-policy">
    <span class="field-label">
      Rolling window
      ${active ? html` <span class="muted">· ${policySummary(policy)}</span>` : null}
    </span>
    <p class="muted">
      Keep the next episodes after the one you last played on the drive and, if
      you like, remove copies you have finished once those are on disk. Turning
      the window on switches to selected episodes; the episode playing right now
      is never removed.
    </p>
    <div class="row tight stacked-xs">
      <label class="check">
        Keep
        <input
          class="input-narrow"
          type="number"
          min="0"
          max="50"
          step="1"
          value=${keepAhead}
          onInput=${(event) =>
            setKeepAhead(
              Math.max(0, Math.min(50, Number(event.target.value) || 0)),
            )}
        />
        ahead
      </label>
      <label class="check">
        <input
          type="checkbox"
          checked=${evictWatched}
          onChange=${(event) => setEvictWatched(event.target.checked)}
        />
        Remove watched copies
      </label>
      <button class="primary" disabled=${busy || !dirty} onClick=${save}>
        ${active || keepAhead || evictWatched ? "Save window" : "Save"}
      </button>
    </div>
  </div>`;
}

// The entry sheet: a full-screen overlay media page. The hero keeps Play as
// the unmistakable primary action; admin work lives behind tabs so the sheet
// stays short. state.tab (also set by Storage deep links) picks the tab.
const SECTIONS = [
  ["overview", "Details", OverviewTab],
  ["metadata", "Metadata", MetadataTab],
  ["source", "Source", SourceTab],
  ["files", "Files", FilesTab],
  ["episodes", "Episodes", EpisodesTab, "series"],
  ["playback", "Playback check", PlaybackTab],
  ["storage", "Keep on disk", StorageTab],
];

// Series-only tabs carry their type in the fourth slot.
function sectionsFor(entry) {
  return SECTIONS.filter(([, , , type]) => !type || type === entry.type);
}

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
  const closeButton = useRef(null);
  // Focus and initial scroll happen once per opened entry. An inline ref
  // callback would refocus the close button on every poll-driven re-render,
  // yanking the sheet back to the top mid-scroll.
  useEffect(() => {
    if (!entry) return;
    closeButton.current?.focus({ preventScroll: true });
  }, [entry?.id]);
  if (!entry) return null;
  const resume =
    entry.playback?.fileId !== undefined || entry.playback?.positionSeconds;
  const check = sourceCheckBadge(entry.sourceCheck);
  const disk = diskBadge(entry);
  const sections = sectionsFor(entry);
  const active = sections.find(([key]) => key === state.tab) ?? sections[0];
  const [, , Tab] = active;
  // Arrow keys move between tabs, as the tablist pattern expects.
  const onTabKey = (event) => {
    const keys = sections.map(([key]) => key);
    const index = keys.indexOf(active[0]);
    const next =
      event.key === "ArrowRight"
        ? keys[(index + 1) % keys.length]
        : event.key === "ArrowLeft"
          ? keys[(index - 1 + keys.length) % keys.length]
          : null;
    if (!next) return;
    event.preventDefault();
    setState({ tab: next });
    event.currentTarget.querySelector(`[data-tab="${next}"]`)?.focus();
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
          ref=${closeButton}
          onClick=${closeDetail}
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
                  <span class="status ${check.tone}">
                    <i class="dot ${check.tone}"></i>
                    ${check.label}
                  </span>
                  ${
                    disk
                      ? html`<span class="status ok">
                          <i class="dot ok"></i>${disk}
                        </span>`
                      : null
                  }
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
        <div
          class="sheet-tabs"
          role="tablist"
          aria-label="Sections"
          onKeyDown=${onTabKey}
        >
          ${sections.map(
            ([key, label]) => html`
              <button
                type="button"
                role="tab"
                data-tab=${key}
                aria-selected=${key === active[0]}
                tabindex=${key === active[0] ? 0 : -1}
                class=${key === active[0] ? "on" : ""}
                onClick=${() => setState({ tab: key })}
              >
                ${label}
              </button>
            `,
          )}
        </div>
        <div class="sheet-body" role="tabpanel">
          <${Tab} state=${state} key=${active[0]} />
        </div>
      </section>
    </div>
  `;
}
