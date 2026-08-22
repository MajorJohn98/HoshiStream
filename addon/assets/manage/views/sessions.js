// Stream Repair view: live transcode sessions with a kill switch. Polls the
// management API every 2 seconds while the tab is visible.
import { html, useEffect, useState } from "../vendor/preact-htm.js";
import { api, notify } from "../api.js";
import { useStore } from "../store.js";
import { Shell, Pill } from "../components/shell.js";

const TIER_LABELS = { remux: "Remux", audio: "Audio fix" };
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

export function SessionsView() {
  const { entries, status } = useStore();
  const [sessions, setSessions] = useState(null);
  const enabled = Boolean(status.transcode?.enabled);

  useEffect(() => {
    if (!enabled) return;
    let alive = true;
    const poll = async () => {
      if (document.hidden) return;
      try {
        const next = await api("transcode/sessions");
        if (alive) setSessions(next);
      } catch {
        // transient poll failures keep the last list
      }
    };
    void poll();
    const timer = setInterval(poll, 2000);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [enabled]);

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
      setSessions(await api("transcode/sessions"));
      notify("Session stopped");
    } catch (error) {
      notify(error.message);
    }
  };

  return html`
    <${Shell} title="Stream Repair">
      <p class="muted">
        Real-time repair sessions started by "Compatible" streams. Sessions end
        on their own one minute after the player stops requesting segments.
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
              Stream repair is off. Set TRANSCODE_ENABLED=true in .env and
              restart to offer "Compatible" streams.
            </div>`
          : sessions === null
            ? html`<div class="empty">Loading sessions…</div>`
            : sessions.length === 0
              ? html`<div class="empty">
                  No active sessions. Pick a "Compatible" stream in Stremio to
                  start one.
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
                              <td>
                                ${TIER_LABELS[session.tier] ?? session.tier}
                              </td>
                              <td>
                                <span
                                  class=${
                                    session.state === "failed"
                                      ? "warn"
                                      : "online"
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
    <//>
  `;
}
