// Status page: service health, library stats, connection speed, resource
// usage, and troubleshooting.
import { html, useEffect, useState } from "../vendor/preact-htm.js";
import { api, fmt, notify } from "../api.js";
import { useStore, load } from "../store.js";
import { Shell } from "../components/shell.js";

function uptimeLabel(seconds) {
  if (!seconds) return "—";
  if (seconds < 3600) return Math.round(seconds / 60) + " min";
  if (seconds < 86400) return (seconds / 3600).toFixed(1) + " h";
  return Math.round(seconds / 86400) + " d";
}

function agoLabel(iso) {
  const minutes = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 6e4));
  if (minutes < 1) return "just now";
  if (minutes < 60) return minutes + " min ago";
  return Math.round(minutes / 60) + " h ago";
}

// Clipboard fallback (e.g. plain-HTTP LAN origins): offer the bundle as a file.
function downloadDiagnostics(text) {
  const url = URL.createObjectURL(
    new Blob([text], { type: "application/json" }),
  );
  const link = document.createElement("a");
  link.href = url;
  link.download =
    "hoshistream-diagnostics-" +
    new Date().toISOString().replace(/[:.]/g, "-") +
    ".json";
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function Status({ tone, children }) {
  return html`<span class="status ${tone}"
    ><i class="dot ${tone}"></i>${children}</span
  >`;
}

const MiB = 1024 * 1024;

// Field descriptors for the TorrServer tuning form. Cache is edited in MiB
// and stored in bytes; everything else is stored as-is.
const TUNING_FIELDS = [
  {
    key: "UploadRateLimit",
    label: "Upload limit (KiB/s, 0 = unlimited)",
    min: 0,
  },
  {
    key: "DownloadRateLimit",
    label: "Download limit (KiB/s, 0 = unlimited)",
    min: 0,
  },
  { key: "ConnectionsLimit", label: "Peer connections per torrent", min: 1 },
  { key: "CacheSize", label: "Memory cache (MiB)", min: 32, scale: MiB },
  { key: "ReaderReadAHead", label: "Read-ahead (%)", min: 5, max: 100 },
  {
    key: "TorrentDisconnectTimeout",
    label: "Drop idle torrent after (s)",
    min: 1,
  },
];

function toForm(settings) {
  const out = {};
  for (const field of TUNING_FIELDS) {
    const value = settings?.[field.key];
    out[field.key] =
      typeof value === "number"
        ? String(Math.round(value / (field.scale || 1)))
        : "";
  }
  return out;
}

function fromForm(form) {
  const out = {};
  for (const field of TUNING_FIELDS) {
    const raw = form[field.key];
    if (raw === "" || raw === undefined) continue;
    const parsed = Number(raw);
    if (!Number.isFinite(parsed)) continue;
    out[field.key] = Math.round(parsed) * (field.scale || 1);
  }
  return out;
}

const APPLY_WARNING =
  "Apply TorrServer settings?\n\nTorrServer reconnects and drops every active torrent. Anything playing right now will stall until the viewer presses play again.";

const CINEMETA_DISCLOSURE =
  "Sends the title and year of each entry to strem.io. Artwork is downloaded once and served from this computer.";

export function MetadataSettings() {
  const [settings, setSettings] = useState(null);
  const [backfill, setBackfill] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const reload = async () => {
    try {
      const [next, progress] = await Promise.all([
        api("metadata/settings"),
        api("metadata/backfill"),
      ]);
      setSettings(next);
      setBackfill(progress);
      setError("");
    } catch (e) {
      setError(e.message);
    }
  };
  useEffect(() => {
    void reload();
  }, []);
  // Poll while a backfill is running so the count moves.
  useEffect(() => {
    if (!backfill?.running) return undefined;
    const timer = setInterval(() => {
      api("metadata/backfill").then(setBackfill, () => undefined);
    }, 1500);
    return () => clearInterval(timer);
  }, [backfill?.running]);
  const update = async (patch) => {
    setBusy(true);
    try {
      setSettings(
        await api("metadata/settings", {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(patch),
        }),
      );
    } catch (e) {
      notify(e.message);
    } finally {
      setBusy(false);
    }
  };
  const start = async () => {
    setBusy(true);
    try {
      setBackfill(await api("metadata/backfill", { method: "POST" }));
    } catch (e) {
      notify(e.message);
    } finally {
      setBusy(false);
    }
  };
  const enabled = Boolean(settings?.enabled);
  const progressLabel = () => {
    if (!backfill) return "";
    if (backfill.running)
      return `Fetching… ${backfill.done} of ${backfill.total}`;
    if (backfill.total > 0)
      return (
        `Last run: ${backfill.done} of ${backfill.total} titles checked` +
        (backfill.failed ? `, ${backfill.failed} could not be fetched` : "")
      );
    return "";
  };
  return html`
    <section class="page-section" id="status-metadata">
      <div class="section-head">
        <h2 class="section-title">Title details from Cinemeta</h2>
        <span class="inline-note">
          ${settings ? (enabled ? "On" : "Off") : error || "Loading…"}
        </span>
        <label class="check">
          <input
            type="checkbox"
            checked=${enabled}
            disabled=${busy || !settings}
            onChange=${(e) => update({ enabled: e.target.checked })}
          />
          Fetch posters, descriptions, and episode names
        </label>
      </div>
      <p class="muted section-note">${CINEMETA_DISCLOSURE}</p>
      ${
        enabled
          ? html`
              <label class="check">
                <input
                  type="checkbox"
                  checked=${Boolean(settings.autoOnAdd)}
                  disabled=${busy}
                  onChange=${(e) => update({ autoOnAdd: e.target.checked })}
                />
                Fetch automatically when a title is added
              </label>
              <div class="row">
                <button
                  type="button"
                  class="secondary"
                  disabled=${busy || backfill?.running}
                  onClick=${start}
                >
                  ${
                    backfill?.running
                      ? "Fetching…"
                      : "Fetch details for existing titles"
                  }
                </button>
                <span class="muted">${progressLabel()}</span>
              </div>
            `
          : html`<p class="muted section-note">
              Off: nothing leaves this computer. Titles keep whatever details
              you typed.
            </p>`
      }
    </section>
  `;
}

export function TorrServerTuning() {
  const [data, setData] = useState(null);
  const [form, setForm] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const reload = async () => {
    try {
      const next = await api("torrserver/settings");
      setData(next);
      setForm(toForm(next.current));
      setError("");
    } catch (e) {
      setError(e.message);
    }
  };
  useEffect(() => {
    void reload();
  }, []);
  const dirty =
    data && form
      ? TUNING_FIELDS.some((f) => form[f.key] !== toForm(data.current)[f.key])
      : false;
  const submit = async (path, body) => {
    if (!confirm(APPLY_WARNING)) return;
    setBusy(true);
    try {
      const next = await api(path, {
        method: path.endsWith("/reset") ? "POST" : "PUT",
        headers: { "content-type": "application/json" },
        body: body ? JSON.stringify(body) : undefined,
      });
      setData((prev) => ({ ...prev, ...next, suggestion: null }));
      setForm(toForm(next.current));
      notify("TorrServer settings applied");
    } catch (e) {
      notify(e.message);
    } finally {
      setBusy(false);
    }
  };
  const onSubmit = (event) => {
    event.preventDefault();
    const patch = fromForm(form);
    if (!Object.keys(patch).length) return;
    void submit("torrserver/settings", patch);
  };
  const suggestion = data?.suggestion;
  return html`
    <section class="page-section" id="status-tuning">
      <div class="section-head">
        <h2 class="section-title">TorrServer tuning</h2>
        <span class="inline-note">
          ${data ? "Live values from TorrServer" : error || "Loading…"}
        </span>
        <button
          class="secondary"
          disabled=${busy || !data}
          onClick=${() => submit("torrserver/settings/reset")}
          title="Restore the six values HoshiStream ships with"
        >
          Reset to shipped defaults
        </button>
      </div>
      <p class="muted section-note">
        Applying restarts TorrServer's BitTorrent client: active torrents are
        dropped and any playback in progress stalls. Changes are refused while
        someone is streaming.
      </p>
      ${
        suggestion
          ? html`<p class="muted section-note">
              Your measured line suggests capping upload at
              ${suggestion.UploadRateLimit} KiB/s (about a tenth of download) so
              seeding never starves playback.
              <button
                class="secondary"
                type="button"
                onClick=${() =>
                  setForm({
                    ...form,
                    UploadRateLimit: String(suggestion.UploadRateLimit),
                  })}
              >
                Use suggestion
              </button>
            </p>`
          : null
      }
      ${
        form
          ? html`<form class="form-grid" onSubmit=${onSubmit}>
              ${TUNING_FIELDS.map(
                (field) => html`
                  <label key=${field.key}>
                    ${field.label}
                    <input
                      type="number"
                      name=${field.key}
                      min=${field.min}
                      max=${field.max}
                      step="1"
                      value=${form[field.key]}
                      onInput=${(e) =>
                        setForm({ ...form, [field.key]: e.target.value })}
                    />
                    <span class="meta"
                      >Shipped:
                      ${Math.round(
                        data.shipped[field.key] / (field.scale || 1),
                      )}</span
                    >
                  </label>
                `,
              )}
              <div class="actions span2">
                <button class="primary" disabled=${busy || !dirty}>
                  ${busy ? "Applying…" : "Apply settings"}
                </button>
              </div>
            </form>`
          : null
      }
    </section>
  `;
}

function procLabel(stats, available) {
  if (!available) return "Unavailable";
  return stats && stats.processes > 0
    ? stats.cpuPercent + "% CPU · " + fmt(stats.rssBytes)
    : "Not running";
}

function Resources() {
  const [report, setReport] = useState(null);
  useEffect(() => {
    let alive = true;
    const poll = async () => {
      if (document.hidden) return;
      try {
        const next = await api("resources");
        if (alive) setReport(next);
      } catch {
        // transient failures keep the last report
      }
    };
    void poll();
    const timer = setInterval(poll, 5000);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, []);
  const disk = report?.disk;
  const totalDisk = disk
    ? disk.torrentCacheBytes + disk.transcodeBytes + disk.uploadsBytes
    : 0;
  return html`
    <section class="page-section" id="status-resources">
      <div class="section-head">
        <h2 class="section-title">Resources</h2>
        <span class="inline-note">
          ${report ? "Sampled every 5 s" : "Measuring…"}
        </span>
      </div>
      ${
        report && !report.processes.available
          ? html`<p class="muted section-note">
              Process statistics are not available on this platform.
            </p>`
          : null
      }
      <div class="stats">
        <div class="stat">
          <span class="label">Add-on server</span>
          <span class="value">
            ${report ? procLabel(report.processes.addon, report.processes.available) : "—"}
          </span>
        </div>
        <div class="stat">
          <span class="label">TorrServer</span>
          <span class="value">
            ${report ? procLabel(report.processes.torrServer, report.processes.available) : "—"}
          </span>
        </div>
        <div class="stat">
          <span class="label">ffmpeg repair</span>
          <span class="value">
            ${report ? procLabel(report.processes.ffmpeg, report.processes.available) : "—"}
          </span>
        </div>
      </div>
      <dl class="kv stacked-sm">
        <div>
          <dt>Torrent cache on disk</dt>
          <dd>${disk ? fmt(disk.torrentCacheBytes) : "—"}</dd>
        </div>
        <div>
          <dt>Stream-repair sessions</dt>
          <dd>${disk ? fmt(disk.transcodeBytes) : "—"}</dd>
        </div>
        <div>
          <dt>Managed uploads</dt>
          <dd>${disk ? fmt(disk.uploadsBytes) : "—"}</dd>
        </div>
        <div>
          <dt>Total cache</dt>
          <dd>${disk ? fmt(totalDisk) : "—"}</dd>
        </div>
      </dl>
    </section>
  `;
}

export function HealthSection() {
  const { status } = useStore();
  const [testing, setTesting] = useState(false);
  const [exporting, setExporting] = useState(false);
  const ts = status.torrServer?.online;
  const native = Boolean(status.nativePicker);
  const streaming = Boolean(status.streamingActive);
  const repair = status.transcode;
  const runSpeedTest = async () => {
    setTesting(true);
    try {
      const result = await api("speedtest", { method: "POST" });
      notify("Measured " + result.mbps + " Mbps");
      await load();
    } catch (error) {
      notify(error.message);
    } finally {
      setTesting(false);
    }
  };
  const copyDiagnostics = async () => {
    setExporting(true);
    try {
      const bundle = await api("diagnostics");
      const text = JSON.stringify(bundle, null, 2);
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(text);
        notify("Diagnostics copied — tokens and paths are redacted");
      } else {
        downloadDiagnostics(text);
        notify("Diagnostics saved as a file");
      }
    } catch (error) {
      notify(error.message);
    } finally {
      setExporting(false);
    }
  };
  const checks = [
    ["ok", "Port availability", "HoshiStream is reachable"],
    [
      ts ? "ok" : "warn",
      "TorrServer API",
      ts ? "Connected" : "Unavailable — check that TorrServer is running",
    ],
    ["ok", "Library data", "Readable"],
    native
      ? ["ok", "System sleep", "Desktop app manages idle sleep during playback"]
      : [
          "warn",
          "System sleep",
          "Keep the host computer awake during playback",
        ],
  ];
  return html`
    <section class="page-section" id="status-services">
      <div class="section-head">
        <h2 class="section-title">Services</h2>
        <${Status} tone=${streaming ? "live" : "idle"}>
          ${streaming ? "Streaming now" : "Idle"}
        <//>
      </div>
      <ul class="rows">
        <li class="rowitem">
          <span class="lead"><i class="dot ok"></i></span>
          <span class="main">
            <strong>HoshiStream</strong>
            <span class="meta">
              ${native ? "Native desktop app" : "Terminal mode"} · up
              ${uptimeLabel(status.uptimeSeconds)}
            </span>
            ${
              status.release
                ? html`<span class="meta wrap">
                    Version ${status.release.version} ·
                    ${status.release.buildId === "source" ? "Source build — not a stamped candidate" : status.release.buildId}
                  </span>`
                : null
            }
          </span>
          <span class="trail"><span class="value online">Online</span></span>
        </li>
        <li class="rowitem">
          <span class="lead"><i class="dot ${ts ? "ok" : "bad"}"></i></span>
          <span class="main">
            <strong>TorrServer</strong>
            <span class="meta"
              >${status.torrServer?.version || "Unavailable"}</span
            >
          </span>
          <span class="trail">
            <span class="value ${ts ? "online" : "warn"}">
              ${ts ? "Online" : "Offline"}
            </span>
          </span>
        </li>
        <li class="rowitem">
          <span class="lead">
            <i class="dot ${repair?.enabled ? "ok" : "idle"}"></i>
          </span>
          <span class="main">
            <strong>Stream repair</strong>
            <span class="meta">
              ${
                repair?.enabled
                  ? repair.videoEncoder
                    ? "Hardware video encoder available"
                    : "No hardware video encoder — audio and remux only"
                  : "Set TRANSCODE_ENABLED=true to offer Compatible streams"
              }
            </span>
          </span>
          <span class="trail">
            <span class="value ${repair?.enabled ? "online" : "muted"}">
              ${repair?.enabled ? repair.activeSessions + " active" : "Off"}
            </span>
          </span>
        </li>
      </ul>
    </section>
    <section class="page-section" id="status-overview">
      <div class="section-head">
        <h2 class="section-title">Overview</h2>
        <button class="secondary" disabled=${testing} onClick=${runSpeedTest}>
          ${testing ? "Measuring…" : "Run speed test"}
        </button>
      </div>
      <div class="stats">
        <div class="stat">
          <span class="label">Library</span>
          <span class="value">${status.libraryCount} titles</span>
          <span class="sub">Atomic JSON storage</span>
        </div>
        <div class="stat">
          <span class="label">Connection speed</span>
          <span class="value">${status.homeSpeedMbps} Mbps</span>
          <span class="sub">
            ${
              status.speed?.source === "measured"
                ? "Measured " + agoLabel(status.speed.measuredAt)
                : "Configured fallback — not yet measured"
            }
          </span>
        </div>
        <div class="stat">
          <span class="label">Uptime</span>
          <span class="value">${uptimeLabel(status.uptimeSeconds)}</span>
          <span class="sub">Since the server last started</span>
        </div>
      </div>
    </section>
    <${Resources} />
    <${MetadataSettings} />
    <${TorrServerTuning} />
    <section class="page-section" id="status-checks">
      <div class="section-head">
        <h2 class="section-title">Checks</h2>
        <span class="inline-note">
          ${checks.filter(([tone]) => tone === "ok").length} of ${checks.length}
          passing
        </span>
        <button
          class="secondary"
          disabled=${exporting}
          onClick=${copyDiagnostics}
          title="Copy a redacted support bundle: versions, TorrServer settings, speed tests, playback telemetry and recent logs"
        >
          ${exporting ? "Collecting…" : "Copy diagnostics"}
        </button>
      </div>
      <ul class="rows">
        ${checks.map(
          ([tone, label, detail]) => html`
            <li class="rowitem" key=${label}>
              <span class="lead"><i class="dot ${tone}"></i></span>
              <span class="main">
                <strong>${label}</strong>
                <span class="meta wrap">${detail}</span>
              </span>
              <span class="trail">
                <span class="value ${tone === "ok" ? "online" : "warn"}">
                  ${tone === "ok" ? "OK" : "Check"}
                </span>
              </span>
            </li>
          `,
        )}
      </ul>
    </section>
  `;
}

export function StatusView() {
  return html`
    <${Shell} title="Status">
      <${HealthSection} />
    <//>
  `;
}
