// System Status view: service health, library stats, and troubleshooting.
import { html, useState } from "../vendor/preact-htm.js";
import { api, notify } from "../api.js";
import { useStore, load } from "../store.js";
import { Shell, Pill } from "../components/shell.js";

function agoLabel(iso) {
  const minutes = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 6e4));
  if (minutes < 1) return "just now";
  if (minutes < 60) return minutes + " min ago";
  return Math.round(minutes / 60) + " h ago";
}

export function StatusView() {
  const { status } = useStore();
  const [testing, setTesting] = useState(false);
  const ts = status.torrServer?.online;
  const native = Boolean(status.nativePicker);
  const streaming = Boolean(status.streamingActive);
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
  return html`
    <${Shell}
      title="System Status"
      actions=${html`<button class="secondary" onClick=${() => load()}>
        Refresh checks
      </button>`}
    >
      <p class="muted">Local services and connectivity</p>
      <div class="statusbar">
        <${Pill} online=${streaming}>
          ${streaming ? "● Streaming now" : "○ Idle"}
        <//>
        <${Pill}>${native ? "Native macOS app" : "Docker mode"}<//>
        <${Pill} online=${status.transcode?.enabled}>
          Stream repair
          ${
            status.transcode?.enabled
              ? "on · " + status.transcode.activeSessions + " active"
              : "off"
          }
        <//>
        ${
          status.transcode?.enabled
            ? html`<${Pill}
                online=${Boolean(status.transcode.videoEncoder)}
                warn=${!status.transcode.videoEncoder}
              >
                ${
                  status.transcode.videoEncoder
                    ? "HW video encoder"
                    : "No HW video encoder"
                }
              <//>`
            : null
        }
      </div>
      <div class="metrics">
        <div class="panel">
          <h3>HoshiStream</h3>
          <${Pill} online>● Online<//>
          <p class="muted">Uptime ${status.uptimeSeconds} seconds</p>
        </div>
        <div class="panel">
          <h3>TorrServer</h3>
          <${Pill} online=${ts} warn=${!ts}>● ${ts ? "Online" : "Offline"}<//>
          <p class="muted">${status.torrServer?.version || "Unavailable"}</p>
        </div>
        <div class="panel">
          <h3>Library</h3>
          <strong>${status.libraryCount} titles</strong>
          <p class="muted">Atomic JSON storage</p>
        </div>
        <div class="panel">
          <h3>Connection speed</h3>
          <strong>${status.homeSpeedMbps} Mbps</strong>
          <p class="muted">
            ${
              status.speed?.source === "measured"
                ? "Measured " + agoLabel(status.speed.measuredAt)
                : "Configured fallback — not yet measured"
            }
          </p>
          <button
            class="secondary"
            style="margin-top:8px"
            disabled=${testing}
            onClick=${runSpeedTest}
          >
            ${testing ? "Measuring…" : "Run speed test"}
          </button>
        </div>
      </div>
      <div class="panel" style="margin-top:18px">
        <h2>Troubleshooting</h2>
        <div class="metrics">
          <div class="metric">
            <span class="online">✓ Port availability</span>
            <strong>HoshiStream is reachable</strong>
          </div>
          <div class="metric">
            <span class=${ts ? "online" : "warn"}>
              ${ts ? "✓" : "!"} TorrServer API
            </span>
            <strong>${ts ? "Connected" : "Unavailable"}</strong>
          </div>
          <div class="metric">
            <span class="online">✓ Library data</span>
            <strong>Readable</strong>
          </div>
          ${
            native
              ? html`<div class="metric">
                  <span class="online">✓ Mac sleep</span>
                  <strong>Kept awake automatically during playback</strong>
                </div>`
              : html`<div class="metric">
                  <span class="warn">! Mac sleep</span>
                  <strong>
                    Run caffeinate or keep the Mac awake during playback
                  </strong>
                </div>`
          }
        </div>
      </div>
    <//>
  `;
}
