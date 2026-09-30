// Detail modal: overview, source, files, storage, and playback tabs for one
// entry. Rendered by App whenever state.selected is set; closing clears it.
import { html, useEffect, useRef, useState } from "../vendor/preact-htm.js";
import { api, fmt, notify, token } from "../api.js";
import { closeDetailRoute } from "../entry-route.js";
import { state, setState, useStore, load } from "../store.js";
import { TagPicker } from "../components/tag-picker.js";
import {
  editableSource,
  sourceHintLabel,
  sourceHints,
} from "../import-state.js";
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
          ${
            meta?.lastError && meta.status !== "unavailable" && !pending
              ? html`<span class="muted"
                  >Last fetch failed: ${meta.lastError}.</span
                >`
              : null
          }
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

// Fields behind "More details": optional extras Stremio shows on the title
// page. Counted in the disclosure summary so filled values are never hidden
// silently.
const MORE_DETAIL_FIELDS = [
  "releaseInfo",
  "runtime",
  "imdbRating",
  "cast",
  "director",
  "writer",
  "country",
  "language",
  "logo",
  "awards",
  "trailers",
];

function filledMoreDetails(entry) {
  return MORE_DETAIL_FIELDS.filter((field) =>
    Array.isArray(entry[field]) ? entry[field].length : Boolean(entry[field]),
  ).length;
}

// Everything Stremio shows about the title, in one form with one Save: the
// essentials up top, the optional extras behind "More details".
function DetailsTab({ state }) {
  const entry = state.selected;
  const [tags, setTags] = useState(entry.tags ?? []);
  const [saving, setSaving] = useState(false);
  useEffect(() => setTags(entry.tags ?? []), [entry.id]);
  const filled = filledMoreDetails(entry);
  const onSubmit = async (e) => {
    e.preventDefault();
    const fields = Object.fromEntries(new FormData(e.target));
    setSaving(true);
    try {
      const d = {
        ...metadataPatch(fields),
        name: fields.name,
        type: fields.type,
        description: fields.description || null,
        poster: fields.poster || null,
        background: fields.background || null,
        tags: tags.length ? tags : null,
        ...(entry.type === "series" ? { ongoing: "ongoing" in fields } : {}),
      };
      syncSelectedEntry(await patch(state, d));
      notify("Details saved");
      // Tags may have been created inline; refresh the grid and registry.
      void load();
    } catch (error) {
      notify(error.message);
    } finally {
      setSaving(false);
    }
  };
  // Uncontrolled fields use defaultValue: the sheet re-renders on every
  // activity poll, and preact re-syncs a `value` prop to the DOM each time,
  // which would wipe whatever the user is typing.
  return html`
    <${Section}
      id="overview"
      title="Details"
      note="How this title appears in Stremio."
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
          entry.type === "series"
            ? html`<label class="check span2">
                <input
                  type="checkbox"
                  name="ongoing"
                  defaultChecked=${Boolean(entry.ongoing)}
                />
                <span>
                  Ongoing series
                  <small class="muted block"
                    >Still airing — Stremio keeps it on the Board.</small
                  >
                </span>
              </label>`
            : null
        }
        <details class="span2 more-details">
          <summary>
            More details
            <span class="muted">
              ${
                filled
                  ? " · " +
                    filled +
                    " of " +
                    MORE_DETAIL_FIELDS.length +
                    " filled"
                  : " · year, runtime, cast, trailers…"
              }
            </span>
          </summary>
          <div class="form-grid">
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
          </div>
        </details>
        <div class="span2 row between">
          <span class="inline-note"
            >Stremio picks up changes on its next catalog refresh.</span
          >
          <button class="primary" disabled=${saving}>
            ${saving ? "Saving…" : "Save details"}
          </button>
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

function HintFields({ season, episode, onSeason, onEpisode, disabled }) {
  return html`
    <input
      class="input-narrow"
      type="number"
      min="0"
      step="1"
      placeholder="Season"
      aria-label="Season"
      title="Season for files without SxxEyy in their names"
      disabled=${disabled}
      value=${season}
      onInput=${(e) => onSeason(e.target.value)}
    />
    <input
      class="input-narrow"
      type="number"
      min="1"
      max="9999"
      step="1"
      placeholder="Episode"
      aria-label="Episode"
      title="Episode number of a single-episode torrent, or the first episode of a partial pack"
      disabled=${disabled}
      value=${episode}
      onInput=${(e) => onEpisode(e.target.value)}
    />
  `;
}

// One source with editable numbering hints. Local edits reset whenever the
// saved hints change, so a refreshed entry never shows stale values.
function SourceRow({ label, source, saving, onSave, onRemove, onPromote }) {
  const savedSeason = String(source.seasonHint ?? "");
  const savedEpisode = String(source.episodeHint ?? "");
  const [season, setSeason] = useState(savedSeason);
  const [episode, setEpisode] = useState(savedEpisode);
  useEffect(() => {
    setSeason(savedSeason);
    setEpisode(savedEpisode);
  }, [savedSeason, savedEpisode]);
  const dirty = season !== savedSeason || episode !== savedEpisode;
  const save = () => {
    try {
      onSave(sourceHints(season, episode));
    } catch (error) {
      notify(error.message);
    }
  };
  return html`
    <li class="rowitem no-lead">
      <span class="main">
        <strong class="mono">${label}</strong>
        <span class="meta">${sourceHintLabel(source)}</span>
      </span>
      <span class="trail source-hints">
        <${HintFields}
          season=${season}
          episode=${episode}
          onSeason=${setSeason}
          onEpisode=${setEpisode}
          disabled=${saving}
        />
        <button class="secondary" disabled=${saving || !dirty} onClick=${save}>
          Save
        </button>
        ${
          onPromote
            ? html`<button
                class="secondary"
                disabled=${saving}
                title="Swap with the main torrent. Watched state stays with each episode."
                onClick=${onPromote}
              >
                Make main
              </button>`
            : null
        }
        ${
          onRemove
            ? html`<button
                class="secondary"
                disabled=${saving}
                onClick=${onRemove}
              >
                Remove
              </button>`
            : null
        }
      </span>
    </li>
  `;
}

function sourceLocator(source) {
  return source.magnetUri
    ? shortMagnet(source.magnetUri)
    : source.localFolderPath || source.torrentFilePath || "Source";
}

// Every source of a series with its season/episode numbering, plus extra
// torrents merged into a torrent-backed series. Any change clears the
// inspection cache server-side; the server refills it in the background, and
// Inspect joins that run rather than starting another.
function SeriesSourcesPanel({ state }) {
  const entry = state.selected;
  const torrentBacked = Boolean(entry.magnetUri || entry.torrentFilePath);
  const [magnet, setMagnet] = useState("");
  const [season, setSeason] = useState("");
  const [episode, setEpisode] = useState("");
  const [saving, setSaving] = useState(false);
  const extras = entry.extraSources || [];
  const save = async (
    changes,
    message,
    request = () => patch(state, changes),
  ) => {
    setSaving(true);
    try {
      const selected = await request();
      setState({ selected, inspection: null });
      notify(message);
      return true;
    } catch (error) {
      notify(error.message);
      return false;
    } finally {
      setSaving(false);
    }
  };
  const refreshing = " — episodes are refreshing in the background";
  const promote = (index) =>
    save(null, "Main torrent changed" + refreshing, () =>
      api("library/" + encodeURIComponent(entry.id) + "/sources/promote", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ index }),
      }),
    );
  const saveExtras = (extraSources) =>
    save(
      { extraSources: extraSources.map(editableSource) },
      "Sources updated" + refreshing,
    );
  const withHints = (source, hints) => {
    const { seasonHint, episodeHint, ...rest } = source;
    return { ...rest, ...hints };
  };
  const add = async () => {
    let hints;
    try {
      hints = sourceHints(season, episode);
    } catch (error) {
      notify(error.message);
      return;
    }
    if (await saveExtras([...extras, { magnetUri: magnet.trim(), ...hints }])) {
      setMagnet("");
      setSeason("");
      setEpisode("");
    }
  };
  return html`
    <div class="stacked">
      <span class="field-label">
        ${torrentBacked ? "Torrents and numbering" : "Numbering"}
      </span>
      <p class="muted">
        Season and Episode number files whose names carry no SxxEyy numbering: a
        single-episode torrent becomes exactly that episode, and a pack is
        numbered upward from it.
        ${
          torrentBacked
            ? " Additional torrents merge into this series; on episode conflicts the newest source wins."
            : ""
        }
      </p>
      <ul class="rows compact">
        <${SourceRow}
          key="primary"
          label=${(torrentBacked ? "Main torrent · " : "") + sourceLocator(entry)}
          source=${entry}
          saving=${saving}
          onSave=${(hints) =>
            save(
              {
                seasonHint: hints.seasonHint ?? null,
                episodeHint: hints.episodeHint ?? null,
              },
              "Numbering updated" + refreshing,
            )}
        />
        ${extras.map(
          (extra, index) => html`
            <${SourceRow}
              key=${extra.magnetUri || extra.torrentFilePath || index}
              label=${sourceLocator(extra)}
              source=${extra}
              saving=${saving}
              onSave=${(hints) =>
                saveExtras(
                  extras.map((item, i) =>
                    i === index ? withHints(item, hints) : item,
                  ),
                )}
              onPromote=${() => promote(index)}
              onRemove=${() => saveExtras(extras.filter((_, i) => i !== index))}
            />
          `,
        )}
      </ul>
      ${
        torrentBacked
          ? html`<div class="picker-row stacked-sm">
              <input
                class="grow"
                placeholder="magnet:?xt=urn:btih:…"
                aria-label="Additional magnet link"
                value=${magnet}
                onInput=${(e) => setMagnet(e.target.value)}
              />
              <${HintFields}
                season=${season}
                episode=${episode}
                onSeason=${setSeason}
                onEpisode=${setEpisode}
                disabled=${saving}
              />
              <button
                class="secondary"
                disabled=${saving || !magnet.trim().startsWith("magnet:?")}
                onClick=${add}
              >
                Add torrent
              </button>
            </div>`
          : null
      }
    </div>
  `;
}

// The magnet itself is a source field: edited here, behind a disclosure so
// the long URI never dominates the tab.
function MagnetEditor({ state }) {
  const entry = state.selected;
  const [saving, setSaving] = useState(false);
  const onSubmit = async (e) => {
    e.preventDefault();
    const magnetUri = new FormData(e.target).get("magnetUri").trim();
    if (magnetUri === entry.magnetUri) return;
    setSaving(true);
    try {
      setState({
        selected: await patch(state, { magnetUri }),
        inspection: null,
      });
      notify("Magnet link saved — the source is re-inspected");
    } catch (error) {
      notify(error.message);
    } finally {
      setSaving(false);
    }
  };
  return html`
    <details class="more-details">
      <summary>Change magnet link</summary>
      <form class="stacked-sm" key=${entry.magnetUri} onSubmit=${onSubmit}>
        <textarea name="magnetUri" required>${entry.magnetUri}</textarea>
        <div class="row between">
          <span class="inline-note"
            >Complete magnet URIs are visible only on this tokenized page and
            are never written to logs.</span
          >
          <button class="secondary" disabled=${saving}>
            ${saving ? "Saving…" : "Save magnet link"}
          </button>
        </div>
      </form>
    </details>
  `;
}

function SourceTab({ state }) {
  const entry = state.selected;
  const [relinking, setRelinking] = useState(false);
  const local = Boolean(entry.localFilePath || entry.localFolderPath);
  const relinkable = local && Boolean(state.status.nativePicker);
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
  const location = entry.magnetUri
    ? shortMagnet(entry.magnetUri)
    : entry.localFolderPath || entry.localFilePath || entry.torrentFilePath;
  return html`
    <${Section}
      id="source"
      title="Source"
      note="Where this title's media comes from."
      action=${
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
    >
      <dl class="kv">
        <div>
          <dt>Kind</dt>
          <dd>${kind}</dd>
        </div>
        <div>
          <dt>Location</dt>
          <dd class=${entry.magnetUri ? "mono" : ""}>${location}</dd>
        </div>
      </dl>
      ${entry.magnetUri ? html`<${MagnetEditor} state=${state} />` : null}
      ${
        entry.type === "series" && !entry.localFilePath
          ? html`<${SeriesSourcesPanel} state=${state} />`
          : null
      }
    <//>
    <${FilesSection} state=${state} />
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

function WatchCell({ state, fileId, pending, toggle, children }) {
  const current = watchStateOf(state.selected, fileId);
  const watched = current === "watched";
  const label = watched
    ? "Watched"
    : current === "started"
      ? "In progress"
      : "Unwatched";
  return html`
    <td class="watch">
      <span class="watch-actions">
        <button
          type="button"
          class=${"watch-toggle " + (current ?? "unwatched")}
          title=${watched ? "Mark unwatched" : "Mark watched"}
          aria-label=${label + " — " + (watched ? "mark unwatched" : "mark watched")}
          disabled=${pending === fileId}
          onClick=${() => toggle(fileId, watched)}
        >
          <span class="watch-dot" aria-hidden="true"></span>
          ${label}
        </button>
        ${children}
      </span>
    </td>
  `;
}

function PlayButton({ state, fileId, label = "Play this file" }) {
  return html`
    <button
      type="button"
      class="secondary"
      title=${label}
      aria-label=${label}
      onClick=${() => goWatch(state.selected.id, fileId)}
    >
      ▶
    </button>
  `;
}

function CachedFilesTable({ state, cache }) {
  const [busy, run] = useInspect(state);
  const [pending, toggle] = useWatchToggle(state);
  // Series track watching and play per episode on the Episodes tab.
  const playable = state.selected.type !== "series";
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
        (state.selected.type === "series"
          ? ". Inspect to change the selection or remap episodes."
          : ". Inspect to choose a different file.")
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
              ${
                !playable && tabs.seasons.length < 2
                  ? html`<th>Season</th>`
                  : null
              }
              ${playable ? html`<th>Watched</th>` : html`<th>Episode</th>`}
            </tr>
          </thead>
          <tbody>
            ${shown.map(
              (f) => html`
                <tr key=${f.id}>
                  <td class="filename" title=${f.path}>${baseName(f.path)}</td>
                  <td class="num">${fmt(f.length)}</td>
                  ${
                    !playable && tabs.seasons.length < 2
                      ? html`<td class="num">${f.season ?? "—"}</td>`
                      : null
                  }
                  ${
                    playable
                      ? html`<${WatchCell}
                          state=${state}
                          fileId=${f.id}
                          pending=${pending}
                          toggle=${toggle}
                        >
                          <${PlayButton} state=${state} fileId=${f.id} />
                        <//>`
                      : html`<td class="num">${f.episode ?? "—"}</td>`
                  }
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

// Which files play and, for a series, which episode each one is. The one
// place that inspects the source: the cached selection shows instantly, and
// inspecting loads every file for editing.
function FilesSection({ state }) {
  if (state.inspection) return html`<${MappingTable} state=${state} />`;
  const cache = state.selected.inspectionCache;
  if (cache) return html`<${CachedFilesTable} state=${state} cache=${cache} />`;
  return html`
    <${Section}
      id="files"
      title="Files"
      note=${
        state.selected.type === "series"
          ? "Which files play, and which episode each one is."
          : "Which file plays."
      }
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
  const [pending, toggle] = useWatchToggle(state);
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
  // A column of placeholder dots is noise: show frames once one exists or an
  // episode is on disk and could get one.
  const showFrames = episodes.some((e) => e.thumbnail || e.onDisk);

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
      note="How each episode reads in Stremio, and what you've watched. Blank titles fall back to one cleaned from the filename."
      action=${html`
        <button
          type="button"
          class="secondary"
          disabled=${!data?.eligible || data?.thumbnails?.running}
          title=${thumbnailSummary(
            data?.thumbnails,
            data?.eligible ?? 0,
            generated,
          )}
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
      `}
    >
      <p class="muted section-note">
        ${thumbnailSummary(data?.thumbnails, data?.eligible ?? 0, generated)}
      </p>
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
              under Source → Files first.
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
                        ${showFrames ? html`<th>Frame</th>` : null}
                        <th>Title</th>
                        <th>Overview</th>
                        <th>Air date</th>
                        <th>Watched</th>
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
                            ${
                              showFrames
                                ? html` <td>
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
                                  </td>`
                                : null
                            }
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
                            <${WatchCell}
                              state=${state}
                              fileId=${row.fileId}
                              pending=${pending}
                              toggle=${toggle}
                            >
                              <${PlayButton}
                                state=${state}
                                fileId=${row.fileId}
                                label=${"Play " + row.season + "×" + row.episode}
                              />
                            <//>
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
  const entry = state.selected;
  const fileId = pickSourceCheckFileId(entry);
  return html`
    <${Section}
      id="playback"
      title="Playback check"
      note="Whether this source is likely to play. Each check covers only the file it names."
      action=${html`<button
        class="secondary"
        title="Opens the raw media URL in a new tab. It does not run a check."
        onClick=${() =>
          openDirectStream(state).catch((error) => notify(error.message))}
      >
        Open direct stream
      </button>`}
    >
      <${SourceCheckPanel}
        entry=${entry}
        onEntry=${syncSelectedEntry}
        startOptions=${{ probe: true, ...(fileId ? { fileId } : {}) }}
      />
      <p class="inline-note stacked-sm">
        Path: HoshiStream →
        ${entry.localFilePath || entry.localFolderPath ? "Local file" : "TorrServer"}
        → Player. Direct playback depends on the player's container and codec
        support.
        ${
          state.status.transcode?.enabled
            ? " When stream repair is on, a “Compatible” stream may be offered alongside the direct one."
            : ""
        }
      </p>
      ${
        state.status.transcode?.enabled
          ? html`<label class="check stacked-xs">
              <input
                type="checkbox"
                checked=${Boolean(entry.forceTranscode)}
                onChange=${async (e) => {
                  try {
                    syncSelectedEntry(
                      await patch(state, { forceTranscode: e.target.checked }),
                    );
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
  ["overview", "Details", DetailsTab],
  ["episodes", "Episodes", EpisodesTab, "series"],
  ["source", "Source", SourceTab],
  ["playback", "Playback", PlaybackTab],
  ["storage", "Storage", StorageTab],
];
// Tabs folded into others by the 2026-09-28 consolidation; old deep links
// land on their new home.
const TAB_ALIASES = { metadata: "overview", files: "source" };

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
  const tab = TAB_ALIASES[state.tab] ?? state.tab;
  const active = sections.find(([key]) => key === tab) ?? sections[0];
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
