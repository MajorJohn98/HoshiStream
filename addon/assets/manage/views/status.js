// System Status view: service health, library stats, and troubleshooting.
import { state, app, esc, shell, load } from "../app.js";

export function statusView() {
  app.innerHTML =
    shell(
      "System Status",
      '<button class="secondary" id="refresh">Refresh checks</button>',
    ) +
    '<p class="muted">Local services and connectivity</p><div class="metrics"><div class="panel"><h3>HoshiStream</h3><span class="pill online">● Online</span><p class="muted">Uptime ' +
    state.status.uptimeSeconds +
    ' seconds</p></div><div class="panel"><h3>TorrServer</h3><span class="pill ' +
    (state.status.torrServer?.online ? "online" : "warn") +
    '">● ' +
    (state.status.torrServer?.online ? "Online" : "Offline") +
    '</span><p class="muted">' +
    esc(state.status.torrServer?.version || "Unavailable") +
    '</p></div><div class="panel"><h3>Library</h3><strong>' +
    state.status.libraryCount +
    ' titles</strong><p class="muted">Atomic JSON storage</p></div><div class="panel"><h3>Home connection</h3><strong>' +
    state.status.homeSpeedMbps +
    ' Mbps</strong><p class="muted">Used for direct-play guidance</p></div></div><div class="panel" style="margin-top:18px"><h2>Troubleshooting</h2><div class="metrics"><div class="metric"><span class="online">✓ Port availability</span><strong>HoshiStream is reachable</strong></div><div class="metric"><span class="' +
    (state.status.torrServer?.online ? "online" : "warn") +
    '">' +
    (state.status.torrServer?.online ? "✓" : "!") +
    " TorrServer API</span><strong>" +
    (state.status.torrServer?.online ? "Connected" : "Unavailable") +
    '</strong></div><div class="metric"><span class="online">✓ Library data</span><strong>Readable</strong></div><div class="metric"><span class="warn">! Mac sleep</span><strong>Keep the Mac awake during playback</strong></div></div></div>';
  document.querySelector("#refresh").onclick = load;
}
