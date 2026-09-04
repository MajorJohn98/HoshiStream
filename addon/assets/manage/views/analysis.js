// Library-wide playback analysis panel: kicks off the sequential server-side
// run and polls its progress while it is active. Rendered by the Library view
// behind its "Analyze" toolbar button.
import { html, useEffect, useState } from "../vendor/preact-htm.js";
import { api, notify } from "../api.js";
import { useStore, load } from "../store.js";

export function unanalyzedCount(entries) {
  return entries.filter((entry) => !entry.directPlay).length;
}

export function AnalysisPanel() {
  const { entries } = useStore();
  const [status, setStatus] = useState(null);
  const analyzed = entries.length - unanalyzedCount(entries);
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
    <section class="panel analysis-panel" id="library-analysis">
      <div class="row between">
        <div>
          <h2>Playback analysis</h2>
          <p class="muted">
            Inspect and probe every title so verdicts and Compatible streams are
            ready before you press play. Runs one title at a time.
          </p>
        </div>
        <span class="inline-note"
          >${analyzed} of ${entries.length} analyzed</span
        >
      </div>
      <div class="row stacked-sm">
        <span class="status ok">
          <i class="dot ok"></i>${verdicts.direct} direct play
        </span>
        ${
          verdicts.caution
            ? html`<span class="status warn">
                <i class="dot warn"></i>${verdicts.caution} check device
              </span>`
            : null
        }
        ${
          verdicts.risky
            ? html`<span class="status bad">
                <i class="dot bad"></i>${verdicts.risky} may not play
              </span>`
            : null
        }
      </div>
      ${
        running
          ? html`
              <div class="row between">
                <div>
                  <strong>
                    Analyzing ${status.done + 1} of ${status.total}
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
                  Analyze ${entries.length - analyzed} missing
                </button>
                <button class="secondary" onClick=${() => run(true)}>
                  Re-analyze everything
                </button>
              </div>
              ${
                status?.finishedAt
                  ? html`<p class="muted stacked-sm">
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
