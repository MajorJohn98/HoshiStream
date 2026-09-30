// Devices section of the Activity page: live TorrServer playback, recent
// clients observed by this server, and remote-pointer health. All client
// data is local and ephemeral — nothing is logged in the cloud.
import { html, useEffect, useState } from "../vendor/preact-htm.js";
import { api, fmt, notify } from "../api.js";
import { useStore } from "../store.js";
import { PointerCard } from "./pointer.js";

function agoLabel(iso) {
  const minutes = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 6e4));
  if (minutes < 1) return "just now";
  if (minutes < 60) return minutes + " min ago";
  if (minutes < 1440) return Math.round(minutes / 60) + " h ago";
  return Math.round(minutes / 1440) + " d ago";
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
  subtitles: "Listed subtitles",
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

// Seconds of playback already cached ahead of the player, from the add-on's
// own sampling of TorrServer's cache window. Null when the file's bitrate is
// unknown — then only swarm speed is shown, and whether the first-play probe
// is still measuring it.
export function runwaySummary(latest, probing = false) {
  if (!latest) return null;
  const swarm = latest.downloadMbps.toFixed(1) + " Mbps swarm";
  if (latest.runwaySeconds === null || latest.bitrateMbps === null) {
    return {
      tone: "idle",
      label: "Runway unknown",
      detail:
        swarm + (probing ? " · measuring bitrate…" : " · bitrate not analyzed"),
    };
  }
  const tone =
    latest.readers === 0
      ? "idle"
      : latest.runwaySeconds < 10 || latest.sustainable === false
        ? "warn"
        : "ok";
  const label =
    latest.readers === 0
      ? "No reader attached"
      : "Runway " + Math.round(latest.runwaySeconds) + " s";
  return {
    tone,
    label,
    detail:
      swarm +
      " vs " +
      latest.bitrateMbps.toFixed(1) +
      " Mbps needed · " +
      latest.activePeers +
      " peers",
  };
}

function Runway({ stream }) {
  const summary = runwaySummary(stream?.latest, stream?.probing);
  if (!summary) return null;
  return html`
    <span class="meta runway">
      <i class="dot ${summary.tone}"></i>
      <span>${summary.label}</span>
      <span class="muted">· ${summary.detail}</span>
    </span>
  `;
}

// Torrent groups on the Activity page, in reading order. "Copying to disk"
// only appears while the archiver is working; Idle starts collapsed because
// it is the long, quiet list (every torrent of a multi-torrent series loads
// when one episode plays).
const SESSION_GROUPS = [
  ["streaming", "Streaming", true],
  ["inspecting", "Checking", true],
  ["downloading", "Copying to disk", true],
  ["idle", "Idle", false],
];

function groupOf(session) {
  return SESSION_GROUPS.some(([key]) => key === session.activity)
    ? session.activity
    : "idle";
}

// Open/closed survives polling (component state) and reloads (storage).
function useGroupOpen(key, fallback) {
  const storageKey = "hoshistream.activity.group." + key;
  const [open, setOpen] = useState(() => {
    try {
      const saved = localStorage.getItem(storageKey);
      return saved === null ? fallback : saved === "1";
    } catch {
      return fallback;
    }
  });
  const onToggle = (event) => {
    const next = event.currentTarget.open;
    if (next === open) return;
    setOpen(next);
    try {
      localStorage.setItem(storageKey, next ? "1" : "0");
    } catch {
      // Private mode: the choice lasts for this visit only.
    }
  };
  return [open, onToggle];
}

// Transfer rates sit mostly below 1 MB/s, where the size formatter reads 0.
function fmtRate(bytesPerSecond) {
  const n = bytesPerSecond || 0;
  if (n >= 1e6) return (n / 1e6).toFixed(n >= 1e7 ? 0 : 1) + " MB/s";
  if (n >= 1e3) return Math.round(n / 1e3) + " KB/s";
  return n ? "<1 KB/s" : "0 KB/s";
}

function SessionRow({ session, runways }) {
  const [tone, label] = session.active
    ? (ACTIVITY[session.activity] ?? ACTIVITY.idle)
    : ["idle", session.statString];
  return html`
    <li class="rowitem">
      <span class="lead"><i class="dot ${tone}"></i></span>
      <span class="main">
        <strong>
          ${session.title}
          ${
            session.sourceLabel
              ? html`<span class="muted"> · ${session.sourceLabel}</span>`
              : null
          }
        </strong>
        <span class="meta">
          ${label} · ${session.connectedSeeders} seeders ·
          ${fmt(session.loadedSize)} of ${fmt(session.torrentSize)}
        </span>
        ${
          session.activity === "streaming"
            ? html`<${Runway}
                stream=${runways.get(session.hash.toLowerCase())}
              />`
            : null
        }
      </span>
      <span class="trail">
        <span class="value">↓ ${fmtRate(session.downloadSpeedBps)}</span>
        <span class="muted">↑ ${fmtRate(session.uploadSpeedBps)}</span>
      </span>
    </li>
  `;
}

function SessionGroup({ id, title, fallbackOpen, sessions, runways }) {
  const [open, onToggle] = useGroupOpen(id, fallbackOpen);
  const down = sessions.reduce((sum, s) => sum + (s.downloadSpeedBps || 0), 0);
  return html`
    <details class="session-group" open=${open} onToggle=${onToggle}>
      <summary>
        <span class="session-group-title">${title}</span>
        <span class="count">${sessions.length}</span>
        ${
          down
            ? html`<span class="muted session-group-rate"
                >↓ ${fmtRate(down)}</span
              >`
            : null
        }
      </summary>
      <ul class="rows">
        ${sessions.map(
          (session) =>
            html`<${SessionRow}
              key=${session.hash}
              session=${session}
              runways=${runways}
            />`,
        )}
      </ul>
    </details>
  `;
}

function Playback() {
  const { activity } = useStore();
  const sessions = activity.playback;
  const telemetry = usePoll("playback/telemetry", 3000);
  const runways = new Map(
    (telemetry?.streams ?? []).map((stream) => [
      stream.hash.toLowerCase(),
      stream,
    ]),
  );
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
          : SESSION_GROUPS.map(([key, title, fallbackOpen]) => {
              const members = sessions.filter(
                (session) => groupOf(session) === key,
              );
              return members.length
                ? html`<${SessionGroup}
                    key=${key}
                    id=${key}
                    title=${title}
                    fallbackOpen=${fallbackOpen}
                    sessions=${members}
                    runways=${runways}
                  />`
                : null;
            })
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
