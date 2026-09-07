import { html, useEffect, useRef, useState } from "../vendor/preact-htm.js";
import { api, notify } from "../api.js";
import { useStore } from "../store.js";
import { Shell } from "../components/shell.js";
import { onboardingReport, setupProgress } from "../onboarding-state.js";
import { openAdd } from "./add.js";

function StepMarker({ complete, number }) {
  return html`<span
    class=${"setup-marker" + (complete ? " complete" : "")}
    aria-label=${complete ? "Complete" : "Step " + number}
  >
    ${complete ? html`<svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true"><path d="m3 8 3 3 7-7" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" /></svg>` : number}
  </span>`;
}

export function WelcomeView() {
  const { entries, status, loaded } = useStore();
  const [report, setReport] = useState(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const busyRef = useRef(false);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    const controller = new AbortController();
    setError("");
    void api("onboarding", {
      signal: AbortSignal.any([controller.signal, AbortSignal.timeout(10000)]),
    })
      .then(async (value) => {
        let next = onboardingReport(value);
        if (controller.signal.aborted) return;
        if (next.state.welcomePending) {
          next = onboardingReport(
            await api("onboarding", {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ action: "welcome-shown" }),
              signal: AbortSignal.any([
                controller.signal,
                AbortSignal.timeout(10000),
              ]),
            }),
          );
        }
        if (!controller.signal.aborted) setReport(next);
      })
      .catch((reason) => {
        if (!controller.signal.aborted) setError(reason.message);
      });
    return () => {
      mounted.current = false;
      controller.abort();
    };
  }, [attempt]);

  const action = async (input, leave = false) => {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setError("");
    try {
      const next = onboardingReport(
        await api("onboarding", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(input),
          signal: AbortSignal.timeout(10000),
        }),
      );
      if (!mounted.current) return;
      setReport(next);
      if (input.action === "select-client") setCopied(false);
      if (leave) location.hash = "#/library";
    } catch (reason) {
      if (mounted.current) {
        setError(reason.message);
        if (leave) {
          notify(
            "Could not remember that setup was skipped. You can still use the Library.",
          );
          location.hash = "#/library";
        }
      }
    } finally {
      busyRef.current = false;
      if (mounted.current) setBusy(false);
    }
  };
  const copy = async () => {
    setError("");
    setCopied(false);
    try {
      if (!navigator.clipboard?.writeText) throw Error("Clipboard unavailable");
      await navigator.clipboard.writeText(report.addonUrl);
      if (mounted.current) setCopied(true);
    } catch {
      if (mounted.current)
        setError(
          "Your browser could not copy the address. Expand Show private URL below and copy it manually.",
        );
    }
  };
  const progress = report ? setupProgress(entries, report) : null;
  const complete = report?.state.status === "complete";
  const client = report?.state.client === "stremio" ? "Stremio" : "Nuvio";
  const firstEntry = entries.at(-1);

  return html`<${Shell}
    title=${complete ? "You're set up" : "Get started"}
    actions=${html`<div class="row">
      <button
        class="secondary"
        disabled=${busy}
        onClick=${() =>
          !complete
            ? action({ action: "dismiss" }, true)
            : (location.hash = "#/library")}
      >
        ${complete ? "Go to library" : "Skip for now"}
      </button>
    </div>`}
  >
    <div class="setup">
      <p class="setup-intro">
        ${
          complete
            ? `Open HoshiStream in ${client} to browse your library. Keep this computer awake and HoshiStream running while you watch.`
            : "Add a title on this computer, then watch it in Nuvio or Stremio on your home network."
        }
      </p>
      <div class="setup-health">
        <span class="row tight"
          ><i class=${"dot " + (status.torrServer?.online ? "ok" : "bad")}></i>
          ${status.torrServer?.online ? "Streaming engine online" : "Streaming engine not ready"}
        </span>
        ${progress ? html`<span>${progress.count} of 2 steps complete</span>` : null}
      </div>
      ${!status.torrServer?.online ? html`<p class="muted">You can set up your library now. If the engine stays offline, <a href="#/status">open Status</a> before trying playback.</p>` : null}
      ${
        error
          ? html`<div class="setup-error" role="alert">
              <p>${error}</p>
              ${!report ? html`<button class="secondary stacked-sm" onClick=${() => setAttempt((value) => value + 1)}>Try again</button>` : null}
            </div>`
          : null
      }
      ${
        !report || !loaded
          ? !error
            ? html`<p class="muted stacked" role="status">
                Loading your setup…
              </p>`
            : null
          : html`
              <section class="setup-step">
                <${StepMarker} number="1" complete=${progress.hasMedia} />
                <div class="setup-step-body">
                  <h2>
                    ${progress.hasMedia ? "Your library has its first title" : "Add your first title"}
                  </h2>
                  <p class="muted">
                    ${
                      progress.hasMedia
                        ? `${entries.length} ${entries.length === 1 ? "title" : "titles"} in your library. Source checks and playback readiness are shown on each entry.`
                        : "Use a magnet link, a .torrent file, or a video already on this computer."
                    }
                  </p>
                  <div class="row stacked-sm">
                    <button
                      class=${progress.hasMedia ? "secondary" : "primary"}
                      disabled=${busy}
                      onClick=${openAdd}
                    >
                      ${progress.hasMedia ? "Add another title" : "Add media"}
                    </button>
                    ${firstEntry ? html`<a class="setup-link" href=${"#/entry/" + encodeURIComponent(firstEntry.id)}>Open latest title</a>` : null}
                  </div>
                  ${!progress.hasMedia ? html`<p class="setup-note">Only add media you own or are authorized to access. Source checks run separately after saving and may contact peers.</p>` : null}
                </div>
              </section>
              <section class="setup-step">
                <${StepMarker} number="2" complete=${progress.connected} />
                <div class="setup-step-body">
                  <h2>Connect your player</h2>
                  <p class="muted">
                    Use the same home network as this computer. Add HoshiStream
                    once in your player's add-ons.
                  </p>
                  <div
                    class="segmented stacked-sm"
                    role="group"
                    aria-label="Player"
                  >
                    ${["nuvio", "stremio"].map(
                      (name) =>
                        html`<button
                          class=${report.state.client === name ? "on" : ""}
                          aria-pressed=${report.state.client === name}
                          disabled=${busy}
                          onClick=${() => action({ action: "select-client", client: name })}
                        >
                          ${name === "nuvio" ? "Nuvio" : "Stremio"}
                        </button>`,
                    )}
                  </div>
                  <ol class="setup-instructions">
                    <li>Copy your private add-on URL below.</li>
                    <li>
                      ${
                        client === "Nuvio"
                          ? "In Nuvio, open Addons and choose Add Addon. Paste the URL and confirm."
                          : "In Stremio, open Add-ons and paste the URL into the add-on search field. Install HoshiStream."
                      }
                    </li>
                    <li>
                      Return here once HoshiStream appears in your player's
                      add-ons.
                    </li>
                  </ol>
                  ${report.loopbackOnly ? html`<p class="setup-warning" role="status">This address currently works only on this computer. Connect it to your home network and restart HoshiStream before setting up another device.</p>` : null}
                  <div class="row stacked-sm">
                    <button class="primary" disabled=${busy} onClick=${copy}>
                      ${copied ? "Copy again" : "Copy add-on URL"}
                    </button>
                    ${copied ? html`<span class="online" role="status">Copied. Paste it in ${client}.</span>` : null}
                  </div>
                  <details class="setup-url">
                    <summary>Show private URL</summary>
                    <label class="field-label stacked-sm" for="setup-addon-url"
                      >Add-on URL</label
                    >
                    <input
                      id="setup-addon-url"
                      readonly
                      value=${report.addonUrl}
                      aria-describedby="setup-private-note"
                      onFocus=${(event) => event.target.select()}
                    />
                  </details>
                  <p id="setup-private-note" class="setup-note">
                    This link grants access to your library. Keep it private. If
                    this computer's network address changes, copy the updated
                    link here.
                  </p>
                  ${report.observedClient ? html`<p class="muted">Recent library request received from ${report.observedClient}.</p>` : null}
                  <div class="row stacked-sm">
                    ${
                      progress.connected
                        ? html`<span class="online" role="status"
                            >You confirmed HoshiStream is available in
                            ${client}.</span
                          >`
                        : html`<button
                            class="secondary"
                            disabled=${busy}
                            onClick=${() => action({ action: "confirm-client", client: report.state.client })}
                          >
                            I can see HoshiStream in ${client}
                          </button>`
                    }
                  </div>
                </div>
              </section>
              <details class="setup-extras">
                <summary>Optional shortcuts</summary>
                <p class="muted">
                  From HoshiStream's menu-bar menu, choose
                  <strong>Use HoshiStream for Magnet Links</strong> to open
                  links directly in Add Media, or enable
                  <strong>Start at Login</strong>. Both are optional.
                </p>
                <p class="muted">
                  The Chrome companion can help capture links and torrent files
                  later. It is not required for this setup.
                </p>
              </details>
              <div class="setup-finish row">
                ${
                  complete
                    ? html`<button
                        class="secondary"
                        disabled=${busy}
                        onClick=${() => action({ action: "resume" })}
                      >
                        Review setup again
                      </button>`
                    : html`<button
                        class="primary"
                        disabled=${busy || progress.count < 2}
                        onClick=${() => action({ action: "finish" })}
                      >
                        ${busy ? "Saving…" : "Finish setup"}
                      </button>`
                }
                <span class="muted"
                  >${progress.count < 2 ? "You can leave now and finish these steps later." : "Playback checks remain separate from setup."}</span
                >
              </div>
            `
      }
    </div>
  <//>`;
}
