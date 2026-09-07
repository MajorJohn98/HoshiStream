// Library-wide playback analysis panel: kicks off the sequential server-side
// run and polls its progress while it is active. Rendered by the Library view
// behind its "Analyze" toolbar button.
import { html, useEffect, useState } from "../vendor/preact-htm.js";
import { api, notify } from "../api.js";
import { useStore, load } from "../store.js";
import {
  sourceCheckBadge,
  sourceCheckPhase,
} from "../components/source-check.js";

export function unanalyzedCount(entries) {
  return entries.filter(
    (entry) => sourceCheckPhase(entry.sourceCheck) === "unchecked",
  ).length;
}

export function analysisEvidenceCounts(entries) {
  const counts = new Map();
  for (const entry of entries) {
    const badge = sourceCheckBadge(entry.sourceCheck);
    const group = counts.get(badge.label) ?? { ...badge, count: 0 };
    group.count++;
    counts.set(badge.label, group);
  }
  return [...counts.values()];
}

export function AnalysisPanel() {
  const { entries } = useStore();
  const [status, setStatus] = useState(null);
  const analyzed = entries.length - unanalyzedCount(entries);
  const evidence = analysisEvidenceCounts(entries);
  useEffect(() => {
    let alive = true;
    let timer;
    const poll = async () => {
      if (document.hidden) return;
      try {
        const next = await api("analysis");
        if (!alive) return;
        // Refresh evidence when a run finishes under our feet.
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
      notify(force ? "Rechecking the whole library" : "Checking library");
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
    <section class="panel analysis-panel" id="library-analysis">
      <div class="row between">
        <div>
          <h2>Library source checks</h2>
          <p class="muted">
            Try metadata and a small sample from one selected file per title,
            one title at a time. Basic checks take up to 1 minute each; results
            do not guarantee playback or cover every episode.
          </p>
        </div>
        <span class="inline-note"
          >${analyzed} of ${entries.length} with check records</span
        >
      </div>
      <div class="row stacked-sm">
        ${evidence.map(
          (group) =>
            html`<span class="status ${group.tone}" key=${group.label}>
              <i class="dot ${group.tone}"></i>${group.count}
              ${group.label.toLowerCase()}
            </span>`,
        )}
      </div>
      ${
        running
          ? html`
              <div class="row between">
                <div>
                  <strong>
                    Checking ${Math.min(status.done + 1, status.total)} of
                    ${status.total}
                  </strong>
                  <p class="muted stacked-xs">${status.current?.name ?? "…"}</p>
                </div>
                <button class="secondary" onClick=${cancel}>Cancel</button>
              </div>
              <div class="progress stacked-sm">
                <span style=${"transform:scaleX(" + percent / 100 + ")"}></span>
              </div>
            `
          : html`
              <div class="row">
                <button
                  class="primary"
                  disabled=${analyzed === entries.length}
                  onClick=${() => run(false)}
                >
                  Check ${entries.length - analyzed} unchecked
                </button>
                <button class="secondary" onClick=${() => run(true)}>
                  Recheck everything
                </button>
              </div>
              ${
                status?.finishedAt
                  ? html`<p class="muted stacked-sm">
                      Last run ${status.cancelled ? "cancelled" : "finished"}:
                      ${status.done}
                      attempts${
                        status.failed.length
                          ? ", " + status.failed.length + " need review"
                          : ""
                      }.
                    </p>`
                  : null
              }
            `
      }
      ${
        status?.failed?.length
          ? html`<ul class="plain-list stacked-sm">
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
    </section>
  `;
}
