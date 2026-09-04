// Devices section of the Activity page: live TorrServer playback, recent
// clients observed by this server, and remote-pointer health. All client
// data is local and ephemeral — nothing is logged in the cloud.
import { html, useEffect, useState } from "../vendor/preact-htm.js";
import { api, fmt, notify } from "../api.js";
import { useStore } from "../store.js";

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

// Seen within the last five minutes reads as "here now".
function recent(iso) {
  return Date.now() - Date.parse(iso) < 5 * 60_000;
}

const RESOURCE_LABELS = {
  manifest: "Installed add-on",
  catalog: "Browsed catalog",
  meta: "Viewed details",
  stream: "Listed streams",
  playback: "Played media",
};

function usePoll(path, intervalMs, refreshTick = 0) {
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
  }, [path, intervalMs, refreshTick]);
  return value;
}

function Clients() {
  const [refreshTick, setRefreshTick] = useState(0);
  const report = usePoll("clients", 5000, refreshTick);
  const clients = report?.clients ?? [];
  const renameDevice = async (client) => {
    const name = prompt(
      "Name for " + client.ip + " (empty to clear)",
      client.name || client.hostname || client.device,
    );
    if (name === null) return;
    try {
      await api("clients/name", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ip: client.ip, name }),
      });
      notify(name.trim() ? "Device named " + name.trim() : "Name cleared");
      setRefreshTick((tick) => tick + 1);
    } catch (error) {
      notify(error.message);
    }
  };
  return html`
    <section class="page-section" id="activity-clients">
      <div class="section-head">
        <div>
          <h2 class="section-title">Connected clients</h2>
          <p class="muted">
            Devices that reached this server since it started. Kept in memory
            only — never uploaded anywhere.
          </p>
        </div>
        <span class="inline-note">
          ${clients.length} device${clients.length === 1 ? "" : "s"}
        </span>
      </div>
      ${
        clients.length === 0
          ? html`<p class="empty quiet">No client activity yet.</p>`
          : html`<ul class="rows">
              ${clients.map(
                (client) => html`
                  <li
                    class="rowitem clickable"
                    role="button"
                    tabindex="0"
                    title="Rename this device"
                    key=${client.ip}
                    onClick=${() => renameDevice(client)}
                    onKeyDown=${(e) => {
                      if (e.key === "Enter" || e.key === " ") {
                        e.preventDefault();
                        renameDevice(client);
                      }
                    }}
                  >
                    <span class="lead">
                      <i
                        class="dot ${recent(client.lastSeen) ? "ok" : "idle"}"
                      ></i>
                    </span>
                    <span class="main">
                      <strong>
                        ${client.name || client.hostname || client.device}
                      </strong>
                      <span class="meta">
                        ${client.ip}${
                          client.hostname && client.hostname !== client.ip
                            ? " · " + client.hostname
                            : ""
                        }${client.name ? " · " + client.device : ""}
                      </span>
                    </span>
                    <span class="trail">
                      <span class="value">
                        ${RESOURCE_LABELS[client.lastResource] || "Request"}
                      </span>
                      <span class="muted">
                        ${agoLabel(client.lastSeen)} · ${client.requests} req
                      </span>
                    </span>
                  </li>
                `,
              )}
            </ul>`
      }
    </section>
  `;
}

const ACTIVITY = {
  streaming: ["live", "Streaming"],
  downloading: ["ok", "Copying to disk"],
  inspecting: ["idle", "Inspecting"],
  idle: ["idle", "Idle"],
};

function Playback() {
  const { activity } = useStore();
  const sessions = activity.playback;
  const streaming = sessions.filter(
    (session) => session.activity === "streaming",
  );
  const busy = sessions.filter((session) => session.active);
  return html`
    <section class="page-section" id="activity-streaming">
      <div class="section-head">
        <div>
          <h2 class="section-title">Torrents</h2>
          <p class="muted">
            Everything TorrServer holds right now, and why it is busy.
          </p>
        </div>
        <span class="inline-note">
          ${
            streaming.length
              ? streaming.length + " streaming"
              : busy.length
                ? busy.length + " working, none streaming"
                : sessions.length
                  ? sessions.length + " idle"
                  : "Nothing registered"
          }
        </span>
      </div>
      ${
        sessions.length === 0
          ? html`<p class="empty quiet">
              No torrents registered with TorrServer right now.
            </p>`
          : html`<ul class="rows">
              ${sessions.map(
                (session) => html`
                  <li class="rowitem" key=${session.hash}>
                    <span class="lead">
                      <i
                        class="dot ${
                          session.active
                            ? (ACTIVITY[session.activity] ?? ACTIVITY.idle)[0]
                            : "idle"
                        }"
                      ></i>
                    </span>
                    <span class="main">
                      <strong>${session.title}</strong>
                      <span class="meta">
                        ${
                          session.active
                            ? (ACTIVITY[session.activity] ?? ACTIVITY.idle)[1]
                            : session.statString
                        }
                        · ${session.connectedSeeders} seeders ·
                        ${fmt(session.loadedSize)} of
                        ${fmt(session.torrentSize)}
                      </span>
                    </span>
                    <span class="trail">
                      <span class="value">
                        ↓ ${fmt(session.downloadSpeedBps)}/s
                      </span>
                      <span class="muted"
                        >↑ ${fmt(session.uploadSpeedBps)}/s</span
                      >
                    </span>
                  </li>
                `,
              )}
            </ul>`
      }
    </section>
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
  const configured = Boolean(local?.configured);
  const expiringDays = remote?.expiresAt ? daysUntil(remote.expiresAt) : null;
  const pointerTone = !configured ? "idle" : local.stale ? "warn" : "ok";
  const remoteTone = !remote
    ? "idle"
    : !remote.reachable
      ? "bad"
      : remote.registered
        ? "ok"
        : "idle";
  return html`
    <section class="page-section" id="activity-pointer">
      <div class="section-head">
        <div>
          <h2 class="section-title">Remote pointer</h2>
          <p class="muted">
            A permanent add-on URL that follows this server across IP changes.
          </p>
        </div>
        ${
          configured
            ? html`<div class="row">
                <button
                  class="primary"
                  disabled=${busy}
                  onClick=${() => act("pointer/push", "Remote pointer updated")}
                >
                  ${busy ? "Working…" : "Update pointer"}
                </button>
                <button
                  class="secondary"
                  disabled=${busy}
                  onClick=${() =>
                    act("pointer/remove", "Remote pointer removed")}
                >
                  Remove
                </button>
              </div>`
            : null
        }
      </div>
      ${
        !configured
          ? html`<p class="empty quiet">
              Not configured. Set POINTER_URL and POINTER_PUSH_SECRET in .env to
              enable it.
            </p>`
          : html`<ul class="rows">
              <li class="rowitem">
                <span class="lead"><i class="dot ${pointerTone}"></i></span>
                <span class="main">
                  <strong>Pointer</strong>
                  <span class="meta wrap">${local.manifestUrl}</span>
                </span>
                <span class="trail">
                  <span class="value ${local.stale ? "warn" : "online"}">
                    ${local.stale ? "Stale — IP changed" : "Fresh"}
                  </span>
                </span>
              </li>
              <li class="rowitem">
                <span class="lead"><i class="dot ${remoteTone}"></i></span>
                <span class="main">
                  <strong>Pointer server</strong>
                  <span class="meta">
                    ${
                      remote?.updatedAt
                        ? "Last push " +
                          agoLabel(remote.updatedAt) +
                          " → " +
                          (remote.baseUrl || "unknown")
                        : "No push recorded yet"
                    }
                  </span>
                </span>
                <span class="trail">
                  <span
                    class="value ${
                      remoteTone === "ok"
                        ? "online"
                        : remoteTone === "bad"
                          ? "warn"
                          : "muted"
                    }"
                  >
                    ${
                      !remote
                        ? "Checking…"
                        : !remote.reachable
                          ? "Unreachable"
                          : remote.registered
                            ? "Registered"
                            : "Not registered yet"
                    }
                  </span>
                  ${
                    expiringDays !== null
                      ? html`<span class="muted">
                          expires in ${expiringDays} d
                        </span>`
                      : null
                  }
                </span>
              </li>
            </ul>`
      }
    </section>
  `;
}

export function DevicesSection() {
  return html`
    <${Playback} />
    <${Clients} />
    <${PointerCard} />
  `;
}
