// Stream-repair section for the System page: live transcode sessions with a
// kill switch, fed by the shared activity poller.
import { html } from "../vendor/preact-htm.js";
import { api, notify } from "../api.js";
import { useStore } from "../store.js";
import { Pill } from "../components/shell.js";

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
    <p class="muted">
      Real-time repair sessions started by "Compatible" streams. Sessions end on
      their own one minute after the player stops requesting segments.
    </p>
    <div class="statusbar">
      <${Pill} online=${enabled} warn=${!enabled}>
        Repair ${enabled ? "enabled" : "disabled"}
      <//>
      ${enabled ? html`<${Pill}>${(sessions ?? []).length} active<//>` : null}
    </div>
    ${
      !enabled
        ? html`<div class="empty">
            Stream repair is off. Set TRANSCODE_ENABLED=true in .env and restart
            to offer "Compatible" streams.
          </div>`
        : sessions.length === 0
          ? html`<div class="empty">
              No active sessions. Pick a "Compatible" stream in Stremio to start
              one.
            </div>`
          : html`
              <div class="panel tablewrap">
                <table class="files">
                  <thead>
                    <tr>
                      <th>Title</th>
                      <th>Repair</th>
                      <th>State</th>
                      <th>Started</th>
                      <th>Last request</th>
                      <th></th>
                    </tr>
                  </thead>
                  <tbody>
                    ${sessions.map(
                      (session) => html`
                        <tr key=${session.entryId + ":" + session.fileId}>
                          <td class="filename">${name(session.entryId)}</td>
                          <td>${TIER_LABELS[session.tier] ?? session.tier}</td>
                          <td>
                            <span
                              class=${
                                session.state === "failed" ? "warn" : "online"
                              }
                            >
                              ${STATE_LABELS[session.state] ?? session.state}
                            </span>
                          </td>
                          <td>${ago(session.startedAt)}</td>
                          <td>${ago(session.lastAccess)}</td>
                          <td>
                            <button
                              class="danger"
                              onClick=${() => kill(session)}
                            >
                              Stop
                            </button>
                          </td>
                        </tr>
                      `,
                    )}
                  </tbody>
                </table>
              </div>
            `
    }
  `;
}
