// System page: one scrollable control center merging health, analysis,
// storage, devices, and stream repair. Section chips stay sticky at the top
// and the hash (#/system/<section>) deep-links from the sidebar HUD.
import { html, useEffect, useState } from "../vendor/preact-htm.js";
import { api, notify } from "../api.js";
import { Shell, Pill } from "../components/shell.js";
import { useStore, load } from "../store.js";
import { HealthSection } from "./status.js";
import { StorageSection } from "./storage.js";
import { DevicesSection } from "./devices.js";
import { RepairSection } from "./sessions.js";

// Library-wide playback analysis: kicks off the sequential server-side run
// and polls its progress while it is active.
function AnalysisSection() {
  const { entries } = useStore();
  const [status, setStatus] = useState(null);
  const analyzed = entries.filter((entry) => entry.directPlay).length;
  const verdicts = { direct: 0, caution: 0, risky: 0 };
  for (const entry of entries) {
    if (entry.directPlay) verdicts[entry.directPlay.compatibility] += 1;
  }
  useEffect(() => {
    let alive = true;
    let timer;
    const poll = async () => {
      if (document.hidden) return;
      try {
        const next = await api("analysis");
        if (!alive) return;
        // Refresh library verdicts when a run finishes under our feet.
        if (status?.running && !next.running) void load();
        setStatus(next);
      } catch {
        // analysis endpoint optional; keep the last state
      }
    };
    void poll();
    timer = setInterval(poll, 2500);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [status?.running]);
  const run = async (force) => {
    try {
      setStatus(
        await api("analysis", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ force }),
        }),
      );
      notify(force ? "Re-analyzing the whole library" : "Analyzing library");
    } catch (error) {
      notify(error.message);
    }
  };
  const cancel = async () => {
    try {
      setStatus(await api("analysis", { method: "DELETE" }));
      notify("Analysis cancelled");
    } catch (error) {
      notify(error.message);
    }
  };
  const running = Boolean(status?.running);
  const percent = status?.total
    ? Math.round((status.done / status.total) * 100)
    : 0;
  return html`
    <p class="muted">
      Inspect and probe every title so playback verdicts and Compatible streams
      are ready before you press play. Runs one title at a time.
    </p>
    <div class="statusbar">
      <${Pill}>${analyzed} of ${entries.length} analyzed<//>
      <${Pill} online=${verdicts.direct > 0}>
        ● ${verdicts.direct} direct play
      <//>
      ${
        verdicts.caution
          ? html`<${Pill} warn>● ${verdicts.caution} check device<//>`
          : null
      }
      ${
        verdicts.risky
          ? html`<${Pill} warn>● ${verdicts.risky} may not play<//>`
          : null
      }
    </div>
    <div class="panel" style="margin-top:14px">
      ${
        running
          ? html`
              <div class="row" style="justify-content:space-between">
                <div>
                  <strong>
                    Analyzing ${status.done + 1} of ${status.total}
                  </strong>
                  <p class="muted" style="margin:4px 0 0">
                    ${status.current?.name ?? "…"}
                  </p>
                </div>
                <button class="secondary" onClick=${cancel}>Cancel</button>
              </div>
              <div class="hud-bar" style="margin-top:12px;height:6px">
                <span style=${"width:" + percent + "%"}></span>
              </div>
            `
          : html`
              <div class="row">
                <button
                  class="primary"
                  disabled=${analyzed === entries.length}
                  onClick=${() => run(false)}
                >
                  Analyze ${entries.length - analyzed} missing
                </button>
                <button class="secondary" onClick=${() => run(true)}>
                  Re-analyze everything
                </button>
              </div>
              ${
                status?.finishedAt
                  ? html`<p class="muted" style="margin-top:10px">
                      Last run ${status.cancelled ? "cancelled" : "finished"}:
                      ${status.done}
                      analyzed${
                        status.failed.length
                          ? ", " + status.failed.length + " failed"
                          : ""
                      }.
                    </p>`
                  : null
              }
            `
      }
      ${
        status?.failed?.length
          ? html`<ul class="plain-list" style="margin-top:10px">
              ${status.failed
                .slice(0, 8)
                .map(
                  (failure) =>
                    html`<li class="muted">
                      ⚠ ${failure.name} — ${failure.error}
                    </li>`,
                )}
            </ul>`
          : null
      }
    </div>
  `;
}

const SECTIONS = [
  ["health", "Health", HealthSection],
  ["analysis", "Analysis", AnalysisSection],
  ["storage", "Storage", StorageSection],
  ["devices", "Devices", DevicesSection],
  ["repair", "Stream repair", RepairSection],
];

function requestedSection() {
  return /^#\/system\/([a-z]+)/.exec(location.hash)?.[1];
}

export function SystemView() {
  useEffect(() => {
    const scrollToSection = () => {
      const section = requestedSection();
      if (!section) return;
      document
        .querySelector("#system-" + section)
        ?.scrollIntoView({ behavior: "smooth", block: "start" });
    };
    scrollToSection();
    addEventListener("hashchange", scrollToSection);
    return () => removeEventListener("hashchange", scrollToSection);
  }, []);
  return html`
    <${Shell} title="System">
      <p class="muted">
        Everything running behind your library — services, storage, devices, and
        repair sessions.
      </p>
      <nav class="section-chips">
        ${SECTIONS.map(
          ([key, label]) => html`
            <a class="chip" href=${"#/system/" + key}>${label}</a>
          `,
        )}
      </nav>
      ${SECTIONS.map(
        ([key, label, Section]) => html`
          <section class="system-section" id=${"system-" + key} key=${key}>
            <h2 class="section-title">${label}</h2>
            <${Section} />
          </section>
        `,
      )}
    <//>
  `;
}
