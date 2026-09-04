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

function Status({ tone, children }) {
  return html`<span class="status ${tone}"
    ><i class="dot ${tone}"></i>${children}</span
  >`;
}

function procLabel(stats) {
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
            ${report ? procLabel(report.processes.addon) : "—"}
          </span>
        </div>
        <div class="stat">
          <span class="label">TorrServer</span>
          <span class="value">
            ${report ? procLabel(report.processes.torrServer) : "—"}
          </span>
        </div>
        <div class="stat">
          <span class="label">ffmpeg repair</span>
          <span class="value">
            ${report ? procLabel(report.processes.ffmpeg) : "—"}
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
  const checks = [
    ["ok", "Port availability", "HoshiStream is reachable"],
    [
      ts ? "ok" : "warn",
      "TorrServer API",
      ts ? "Connected" : "Unavailable — check that TorrServer is running",
    ],
    ["ok", "Library data", "Readable"],
    native
      ? ["ok", "Mac sleep", "Kept awake automatically during playback"]
      : [
          "warn",
          "Mac sleep",
          "Run caffeinate or keep the Mac awake during playback",
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
              ${native ? "Native macOS app" : "Headless mode"} · up
              ${uptimeLabel(status.uptimeSeconds)}
            </span>
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
    <section class="page-section" id="status-checks">
      <div class="section-head">
        <h2 class="section-title">Checks</h2>
        <span class="inline-note">
          ${checks.filter(([tone]) => tone === "ok").length} of ${checks.length}
          passing
        </span>
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
