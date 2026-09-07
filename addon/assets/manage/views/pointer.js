import { html, useEffect, useRef, useState } from "../vendor/preact-htm.js";
import { api, notify } from "../api.js";

const labels = {
  disabled: "Disabled",
  unconfigured: "Not configured",
  "recovery-required": "Restore your pointer credential",
  unregistered: "Ready to register",
  registered: "Registered",
  stale: "LAN address changed",
  expired: "Expired",
  unreachable: "Service unreachable",
  "authentication-failed": "Authentication failed",
  "not-found": "Record or credential not confirmed",
  "storage-error": "Local setup unavailable",
};

export function PointerCard() {
  const [local, setLocal] = useState(null);
  const [remote, setRemote] = useState(null);
  const [endpoint, setEndpoint] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const mounted = useRef(false);
  const request = (path, options = {}) =>
    api(path, { ...options, signal: AbortSignal.timeout(15000) });
  const refresh = async (resetEndpoint = false) => {
    const value = await request("pointer/status");
    if (!mounted.current) return;
    setLocal(value);
    if (resetEndpoint)
      setEndpoint(value.pointerUrl || value.suggestedUrl || "");
  };
  useEffect(() => {
    mounted.current = true;
    void refresh(true).catch((reason) => {
      if (mounted.current) setError(reason.message);
    });
    return () => {
      mounted.current = false;
    };
  }, []);
  const act = async (action) => {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setError("");
    setRemote(null);
    try {
      if (action === "reload") {
        await refresh(true);
        return;
      }
      if (action === "save" || action === "disable") {
        await request("pointer/settings", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            enabled: action === "save",
            pointerUrl: action === "save" ? endpoint.trim() : local.pointerUrl,
          }),
        });
        notify(
          action === "save"
            ? "Saved locally. Click Register / update to contact the service."
            : "Pointer disabled. Any existing remote record remains until removed or expired.",
        );
      } else {
        const result = await request("pointer/" + action, {
          method: action === "remote" ? "GET" : "POST",
        });
        if (mounted.current && action === "remote") setRemote(result);
        if (action === "push") notify("Remote pointer registered / updated.");
        if (action === "remove") notify("Remote pointer removed.");
      }
      await refresh();
    } catch (reason) {
      if (mounted.current) setError(reason.message);
      // Read local outcomes after a failed manual request; never retry it.
      try {
        await refresh();
      } catch {
        if (mounted.current)
          setError(
            reason.message +
              " Local status could not be refreshed; try Reload setup.",
          );
      }
    } finally {
      busyRef.current = false;
      if (mounted.current) setBusy(false);
    }
  };
  const save = (event) => {
    event.preventDefault();
    void act("save");
  };
  const remove = () => {
    if (
      confirm(
        "Remove this installation's remote pointer? Installed pointer URLs will stop working until you register again. Your local library is unchanged.",
      )
    )
      void act("remove");
  };
  const copy = async () => {
    setError("");
    try {
      await navigator.clipboard.writeText(local.manifestUrl);
      notify("Private pointer URL copied.");
    } catch {
      setError(
        "Clipboard unavailable. Expand Show private pointer URL and copy it manually.",
      );
    }
  };
  const current = remote || local;
  return html`
    <section class="page-section" id="activity-pointer" aria-busy=${busy}>
      <div class="section-head">
        <div>
          <h2 class="section-title">Remote pointer</h2>
          <p class="muted">
            A stable add-on address for your home LAN. Update it manually when
            this computer's LAN address changes.
          </p>
        </div>
        <span class="inline-note" role="status">
          ${busy ? "Working…" : labels[current?.state] || (local ? "Review setup" : "Loading setup…")}
        </span>
      </div>
      ${error ? html`<p class="setup-error" role="alert">${error}</p>` : null}
      ${
        !local
          ? html`
              <button
                class="secondary"
                disabled=${busy}
                onClick=${() => act("reload")}
              >
                Reload setup
              </button>
            `
          : html`
              <form class="pointer-setup stacked-sm" onSubmit=${save}>
                <label class="field-label" for="pointer-endpoint"
                  >Pointer service URL</label
                >
                <input
                  id="pointer-endpoint"
                  type="url"
                  required
                  maxlength="2048"
                  value=${endpoint}
                  disabled=${busy}
                  aria-describedby="pointer-privacy"
                  onInput=${(event) => setEndpoint(event.target.value)}
                  placeholder="https://your-pointer.example"
                />
                <p id="pointer-privacy" class="muted stacked-sm">
                  ${`Suggested beta service: ${local.suggestedUrl}, operated by ${local.suggestedOperator}. You may use your own trusted service. Saving enables local setup only; it sends nothing.`}
                </p>
                <div class="row stacked-sm">
                  <button class="primary" type="submit" disabled=${busy}>
                    ${local.enabled ? "Save endpoint" : "Save and enable"}
                  </button>
                  ${
                    local.enabled
                      ? html`
                          <button
                            class="secondary"
                            type="button"
                            disabled=${busy}
                            onClick=${() => act("disable")}
                          >
                            Disable locally
                          </button>
                        `
                      : null
                  }
                  <button
                    class="secondary"
                    type="button"
                    disabled=${busy}
                    onClick=${() => act("reload")}
                  >
                    Reload setup
                  </button>
                </div>
              </form>
              <p class="stacked-sm" role="status">${current?.message}</p>
              ${
                local.configured
                  ? html`
                      <div class="row stacked-sm">
                        <button
                          class="primary"
                          disabled=${busy}
                          onClick=${() => act("push")}
                        >
                          Register / update
                        </button>
                        <button
                          class="secondary"
                          disabled=${busy}
                          onClick=${() => act("remote")}
                        >
                          Check service
                        </button>
                        <button
                          class="secondary"
                          disabled=${busy}
                          onClick=${remove}
                        >
                          Remove remote record
                        </button>
                      </div>
                    `
                  : null
              }
              ${
                local.lastPushedAt
                  ? html`
                      <p class="muted stacked-sm">
                        Last successful push:
                        ${new Date(local.lastPushedAt).toLocaleString()}.
                        ${local.expiresAt ? "Expires: " + new Date(local.expiresAt).toLocaleString() + "." : ""}
                      </p>
                    `
                  : null
              }
              ${
                local.usable
                  ? html`
                      <button
                        class="secondary stacked-sm"
                        disabled=${busy}
                        onClick=${copy}
                      >
                        Copy private pointer URL
                      </button>
                      <details class="setup-url">
                        <summary>Show private pointer URL</summary>
                        <label
                          class="field-label stacked-sm"
                          for="pointer-manifest"
                          >Private pointer URL</label
                        >
                        <input
                          id="pointer-manifest"
                          readonly
                          value=${local.manifestUrl}
                          onFocus=${(event) => event.target.select()}
                        />
                      </details>
                    `
                  : null
              }
              <p class="muted stacked-sm">
                Manual actions send your installation's credentials to the
                chosen service over HTTPS. Add-on requests transit that service;
                media stays on the LAN. This is not remote streaming. Never
                share private add-on URLs.
              </p>
              <p class="muted stacked-sm">
                Some browser clients block HTTPS-to-HTTP LAN redirects. Use the
                <a href="#/welcome">direct LAN URL in Get started</a> instead.
                Disable keeps the remote record; remove it before changing
                services. A lost credential must be restored from a private
                backup, not replaced with the operator's Vercel or storage
                credentials.
              </p>
            `
      }
    </section>
  `;
}
