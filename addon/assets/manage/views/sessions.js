// Stream-repair section of the Activity page: live transcode sessions with a
// kill switch, fed by the shared activity poller.
import { html } from "../vendor/preact-htm.js";
import { api, notify } from "../api.js";
import { useStore } from "../store.js";

const TIER_LABELS = { remux: "Remux", audio: "Audio fix", video: "Video" };
const STATE_LABELS = {
  running: "Running",
  finished: "Finished",
  failed: "Failed",
};

function ago(iso) {
  const seconds = Math.max(
    0,
    Math.round((Date.now() - Date.parse(iso)) / 1000),
  );
  if (seconds < 60) return seconds + " s ago";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return minutes + " min ago";
  return Math.round(minutes / 60) + " h ago";
}

export function RepairSection() {
  const { entries, status, activity } = useStore();
  const enabled = Boolean(status.transcode?.enabled);
  const sessions = activity.repair;

  const name = (entryId) =>
    entries.find((entry) => entry.id === entryId)?.name ?? entryId;

  const kill = async (session) => {
    try {
      await api(
        "transcode/sessions/" +
          encodeURIComponent(session.entryId) +
          "/" +
          session.fileId,
        { method: "DELETE" },
      );
      notify("Session stopped");
    } catch (error) {
      notify(error.message);
    }
  };

  return html`
    <section class="page-section" id="activity-repair">
      <div class="section-head">
        <div>
          <h2 class="section-title">Stream repair</h2>
          <p class="muted">
            Real-time sessions behind "Compatible" streams. They end a minute
            after the player stops requesting segments.
          </p>
        </div>
        <span class="status ${enabled ? "ok" : "idle"}">
          <i class="dot ${enabled ? "ok" : "idle"}"></i>
          ${enabled ? sessions.length + " active" : "Off"}
        </span>
      </div>
      ${
        !enabled
          ? html`<p class="empty quiet">
              Stream repair is off. Set TRANSCODE_ENABLED=true in .env and
              restart to offer "Compatible" streams.
            </p>`
          : sessions.length === 0
            ? html`<p class="empty quiet">
                No active sessions. Pick a "Compatible" stream in Stremio to
                start one.
              </p>`
            : html`<ul class="rows">
                ${sessions.map(
                  (session) => html`
                    <li
                      class="rowitem"
                      key=${session.entryId + ":" + session.fileId}
                    >
                      <span class="lead">
                        <i
                          class="dot ${
                            session.state === "failed"
                              ? "bad"
                              : session.state === "running"
                                ? "live"
                                : "idle"
                          }"
                        ></i>
                      </span>
                      <span class="main">
                        <strong>${name(session.entryId)}</strong>
                        <span class="meta">
                          ${TIER_LABELS[session.tier] ?? session.tier} · started
                          ${ago(session.startedAt)} · last request
                          ${ago(session.lastAccess)}
                        </span>
                      </span>
                      <span class="trail">
                        <span
                          class="value ${
                            session.state === "failed" ? "warn" : "online"
                          }"
                        >
                          ${STATE_LABELS[session.state] ?? session.state}
                        </span>
                        <button class="danger" onClick=${() => kill(session)}>
                          Stop
                        </button>
                      </span>
                    </li>
                  `,
                )}
              </ul>`
      }
    </section>
  `;
}
