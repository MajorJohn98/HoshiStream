// Devices view (plan C dashboard): recent clients observed by this server,
// live TorrServer playback, and remote-pointer health. All client data is
// local and ephemeral — nothing is logged in the cloud.
import { html, useEffect, useState } from "../vendor/preact-htm.js";
import { api, fmt, notify } from "../api.js";
import { Shell, Pill } from "../components/shell.js";

function agoLabel(iso) {
  const minutes = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 6e4));
  if (minutes < 1) return "just now";
  if (minutes < 60) return minutes + " min ago";
  if (minutes < 1440) return Math.round(minutes / 60) + " h ago";
  return Math.round(minutes / 1440) + " d ago";
}

function daysUntil(iso) {
  return Math.round((Date.parse(iso) - Date.now()) / 864e5);
}

const RESOURCE_LABELS = {
  manifest: "Installed add-on",
  catalog: "Browsed catalog",
  meta: "Viewed details",
  stream: "Listed streams",
  playback: "Played media",
};

function usePoll(path, intervalMs) {
  const [value, setValue] = useState(null);
  useEffect(() => {
    let alive = true;
    const poll = async () => {
      if (document.hidden) return;
      try {
        const next = await api(path);
        if (alive) setValue(next);
      } catch {
        // transient failures keep the last result
      }
    };
    void poll();
    const timer = setInterval(poll, intervalMs);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [path, intervalMs]);
  return value;
}

function Clients() {
  const report = usePoll("clients", 5000);
  const clients = report?.clients ?? [];
  return html`
    <div class="panel" style="margin-top:18px">
      <h2>Connected clients</h2>
      <p class="muted">
        Devices that talked to this server since it started. Kept in memory only
        — never uploaded anywhere.
      </p>
      ${
        clients.length === 0
          ? html`<p class="muted">No client activity yet.</p>`
          : html`<div class="metrics">
              ${clients.map(
                (client) => html`
                  <div class="metric">
                    <span class="muted">${client.ip}</span>
                    <strong>${client.device}</strong>
                    <span class="muted">
                      ${RESOURCE_LABELS[client.lastResource] || "Request"} ·
                      ${agoLabel(client.lastSeen)} · ${client.requests} requests
                    </span>
                  </div>
                `,
              )}
            </div>`
      }
    </div>
  `;
}

function Playback() {
  const report = usePoll("playback", 5000);
  const sessions = report?.sessions ?? [];
  const active = sessions.filter((session) => session.active);
  return html`
    <div class="panel" style="margin-top:18px">
      <h2>Now streaming</h2>
      ${
        sessions.length === 0
          ? html`<p class="muted">No torrents registered right now.</p>`
          : html`<div class="metrics">
              ${sessions.map(
                (session) => html`
                  <div class="metric">
                    <span class=${session.active ? "online" : "muted"}>
                      ${session.active ? "● " : "○ "}${session.statString}
                    </span>
                    <strong>${session.title}</strong>
                    <span class="muted">
                      ↓ ${fmt(session.downloadSpeedBps)}/s · ↑
                      ${fmt(session.uploadSpeedBps)}/s ·
                      ${session.connectedSeeders} seeders ·
                      ${fmt(session.loadedSize)} of ${fmt(session.torrentSize)}
                    </span>
                  </div>
                `,
              )}
            </div>`
      }
      ${
        active.length > 0
          ? html`<p class="muted">${active.length} active session(s)</p>`
          : null
      }
    </div>
  `;
}

function PointerCard() {
  const [local, setLocal] = useState(null);
  const [remote, setRemote] = useState(null);
  const [busy, setBusy] = useState(false);
  const refresh = async () => {
    try {
      const localStatus = await api("pointer/status");
      setLocal(localStatus);
      if (localStatus.configured) setRemote(await api("pointer/remote"));
    } catch {
      // pointer optional; leave the card in its last state
    }
  };
  useEffect(() => {
    void refresh();
  }, []);
  const act = async (path, message) => {
    setBusy(true);
    try {
      await api(path, { method: "POST" });
      notify(message);
      await refresh();
    } catch (error) {
      notify(error.message);
    } finally {
      setBusy(false);
    }
  };
  if (!local || !local.configured) {
    return html`
      <div class="panel" style="margin-top:18px">
        <h2>Remote pointer</h2>
        <p class="muted">
          Not configured. Set POINTER_URL and POINTER_PUSH_SECRET to get a
          permanent add-on URL that survives IP changes.
        </p>
      </div>
    `;
  }
  const expiringDays = remote?.expiresAt ? daysUntil(remote.expiresAt) : null;
  return html`
    <div class="panel" style="margin-top:18px">
      <h2>Remote pointer</h2>
      <div class="statusbar">
        <${Pill} online=${!local.stale} warn=${local.stale}>
          ${local.stale ? "! Pointer stale — IP changed" : "● Pointer fresh"}
        <//>
        ${
          remote
            ? html`<${Pill}
                online=${remote.registered}
                warn=${!remote.reachable}
              >
                ${
                  !remote.reachable
                    ? "! Server unreachable"
                    : remote.registered
                      ? "● Registered"
                      : "○ Not registered yet"
                }
              <//>`
            : null
        }
        ${
          expiringDays !== null
            ? html`<${Pill}
                online=${expiringDays > 14}
                warn=${expiringDays <= 14}
              >
                Expires in ${expiringDays} days
              <//>`
            : null
        }
      </div>
      <p class="muted">Permanent add-on URL: ${local.manifestUrl}</p>
      ${
        remote?.updatedAt
          ? html`<p class="muted">
              Last push ${agoLabel(remote.updatedAt)} →
              ${remote.baseUrl || "unknown"}
            </p>`
          : null
      }
      <div style="display:flex;gap:8px;margin-top:8px">
        <button
          disabled=${busy}
          onClick=${() => act("pointer/push", "Remote pointer updated")}
        >
          ${busy ? "Working…" : "Update remote pointer"}
        </button>
        <button
          class="secondary"
          disabled=${busy}
          onClick=${() => act("pointer/remove", "Remote pointer removed")}
        >
          Remove
        </button>
      </div>
    </div>
  `;
}

export function DevicesView() {
  return html`
    <${Shell} title="Devices">
      <p class="muted">
        Who is connected, what is playing, and remote pointer health
      </p>
      <${PointerCard} />
      <${Playback} />
      <${Clients} />
    <//>
  `;
}
