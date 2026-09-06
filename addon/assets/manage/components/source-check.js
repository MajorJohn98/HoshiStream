import { html, useEffect, useRef, useState } from "../vendor/preact-htm.js";
import { api, fmt } from "../api.js";
import { createRequestGate } from "../import-state.js";
import { markSourceCheckRequested } from "../store.js";

export const ACTIVE_SOURCE_CHECK_PHASES = new Set([
  "queued",
  "inspecting",
  "probing",
]);

const SOURCE_CHECK_BADGES = {
  unchecked: { tone: "idle", label: "Unchecked" },
  queued: { tone: "warn", label: "Queued" },
  inspecting: { tone: "warn", label: "Inspecting…" },
  probing: { tone: "warn", label: "Checking…" },
  complete: { tone: "ok", label: "Checked" },
  failed: { tone: "bad", label: "Check failed" },
  cancelled: { tone: "idle", label: "Check cancelled" },
  interrupted: { tone: "warn", label: "Check interrupted" },
};

function sameCheck(left, right) {
  return (
    sourceCheckPhase(left) === sourceCheckPhase(right) &&
    left?.updatedAt === right?.updatedAt &&
    left?.message === right?.message &&
    left?.jobId === right?.jobId &&
    left?.fileId === right?.fileId
  );
}

export function sourceCheckKey(entry) {
  const source = (value) => ({
    magnetUri: value.magnetUri,
    torrentFilePath: value.torrentFilePath,
    fileOverrides: value.fileOverrides,
    seasonHint: value.seasonHint,
    hash: value.sourceHash ?? value.searchImport?.hash,
    filmPath: value.searchImport?.filmPath,
  });
  return JSON.stringify({
    id: entry.id,
    type: entry.type,
    primary: source(entry),
    localFilePath: entry.localFilePath,
    localFolderPath: entry.localFolderPath,
    preferredFileIndex: entry.preferredFileIndex,
    extraSources: (entry.extraSources ?? []).map(source),
  });
}

function checkReport(report) {
  if (!report || !Object.hasOwn(SOURCE_CHECK_BADGES, report.phase))
    throw Error(
      "The server returned an unrecognized check status. Refresh it.",
    );
  return report;
}

export function sourceCheckPhase(check) {
  return check?.phase ?? "unchecked";
}

export function isSourceCheckActive(check) {
  return ACTIVE_SOURCE_CHECK_PHASES.has(sourceCheckPhase(check));
}

export function sourceCheckBadge(check, error) {
  if (error) return { tone: "warn", label: "Status unavailable" };
  const phase = sourceCheckPhase(check);
  if (phase !== "complete")
    return (
      SOURCE_CHECK_BADGES[phase] ?? { tone: "warn", label: "Unknown status" }
    );
  if (!check?.probe) return { tone: "ok", label: "Inspected" };
  if (check.browserSupport === "likely")
    return { tone: "ok", label: "Browser likely" };
  if (check.browserSupport === "limited")
    return { tone: "warn", label: "Browser limited" };
  return SOURCE_CHECK_BADGES.complete;
}

export function sourceCheckSummary(check, entryType = "movie") {
  const phase = sourceCheckPhase(check);
  if (phase === "unchecked")
    return "Not checked yet. Run a source check when you want metadata and a bounded playback sample.";
  if (phase === "queued")
    return check?.probe === false
      ? "Queued to inspect source metadata."
      : "Queued to inspect the source and read a limited media sample after saving.";
  if (phase === "inspecting")
    return "Inspecting source metadata. This may contact peers but does not switch sources or download the full title.";
  if (phase === "probing")
    return "Reading a limited sample from one representative file. This is still not a ready-to-play guarantee for every browser, device, or episode.";
  if (phase === "cancelled")
    return "The background check was cancelled. The library entry and source were kept unchanged.";
  if (phase === "interrupted")
    return "The background check stopped because the source changed or the app restarted. Retry when you are ready.";
  if (phase === "failed") return check?.message || "The source check failed.";
  if (!check?.probe)
    return "Source metadata was resolved, but playback has not been checked yet.";
  if (check.browserSupport === "likely")
    return `One representative ${entryType === "series" ? "episode" : "file"} completed a bounded playback check. That is a useful browser hint, not a ready-to-play guarantee for every file or every device.`;
  if (check.browserSupport === "limited")
    return `The representative ${entryType === "series" ? "episode" : "file"} completed a bounded check, but browser support looks limited. A native player or the optional Compatible stream may still be needed.`;
  return `The representative ${entryType === "series" ? "episode" : "file"} completed a bounded check, but browser support is still uncertain.`;
}

export function pickSourceCheckFileId(entry) {
  const selected = entry?.inspectionCache?.selectedFiles ?? [];
  const newestHash =
    entry?.extraSources?.at(-1)?.sourceHash ??
    entry?.extraSources?.at(-1)?.searchImport?.hash ??
    entry?.sourceHash ??
    entry?.searchImport?.hash;
  if (newestHash) {
    const match = selected.find((file) => file.hash === newestHash);
    if (match) return match.id;
  }
  return entry?.sourceCheck?.fileId ?? selected[0]?.id;
}

export function applySourceCheck(entry, check) {
  if (!entry) return entry;
  return {
    ...entry,
    ...(sourceCheckPhase(check) === "unchecked"
      ? { sourceCheck: undefined }
      : { sourceCheck: check }),
  };
}

export function createSourceCheckController(
  load,
  publish,
  {
    schedule = (callback, delay) => setTimeout(callback, delay),
    clear = (handle) => clearTimeout(handle),
    delayMs = 1500,
    onError = () =>
      console.warn(JSON.stringify({ event: "source_check_poll_failed" })),
  } = {},
) {
  const gate = createRequestGate();
  let timer = null;
  let current = null;
  let stopped = false;
  let failures = 0;
  const clearTimer = () => {
    if (timer !== null) {
      clear(timer);
      timer = null;
    }
  };
  const queue = () => {
    clearTimer();
    if (stopped || !isSourceCheckActive(current)) return;
    timer = schedule(
      async () => {
        if (stopped) return;
        const request = gate.start();
        try {
          const next = checkReport(await load(request.signal));
          if (!request.isCurrent()) return;
          failures = 0;
          current = next;
          publish(next);
          queue();
        } catch (error) {
          if (request.isCurrent()) {
            failures++;
            onError(error);
            if (failures < 3) queue();
          }
        }
      },
      Math.min(15000, delayMs * 2 ** failures),
    );
  };
  return {
    update(check) {
      stopped = false;
      current = check;
      failures = 0;
      queue();
    },
    stop() {
      stopped = true;
      clearTimer();
      gate.cancel();
    },
  };
}

function agoLabel(iso) {
  if (!iso) return "";
  const minutes = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 6e4));
  if (minutes < 1) return "just now";
  if (minutes < 60) return minutes + " min ago";
  const hours = Math.round(minutes / 60);
  if (hours < 24) return hours + " h ago";
  return Math.round(hours / 24) + " days ago";
}

function metricRows(check) {
  if (!check) return [];
  const technical = check.technical || {};
  return [
    check.checkedFiles !== undefined && check.totalFiles !== undefined
      ? [
          "Coverage",
          `${check.checkedFiles} of ${check.totalFiles} ${
            check.totalFiles === 1 ? "file" : "files"
          }`,
        ]
      : null,
    check.probe && check.browserSupport
      ? [
          "Browser hint",
          check.browserSupport === "likely"
            ? "Likely"
            : check.browserSupport === "limited"
              ? "Limited"
              : "Unknown",
        ]
      : null,
    technical.container
      ? ["Container", technical.container.toUpperCase()]
      : null,
    technical.videoCodec ? ["Video", technical.videoCodec.toUpperCase()] : null,
    technical.audioCodec ? ["Audio", technical.audioCodec.toUpperCase()] : null,
    technical.width && technical.height
      ? ["Resolution", `${technical.width} × ${technical.height}`]
      : null,
    technical.durationSeconds
      ? ["Duration", Math.round(technical.durationSeconds / 60) + " min"]
      : null,
    technical.bitrateMbps
      ? ["Average bitrate", technical.bitrateMbps.toFixed(1) + " Mbps"]
      : null,
    technical.sizeBytes ? ["File size", fmt(technical.sizeBytes)] : null,
    check.updatedAt ? ["Updated", agoLabel(check.updatedAt)] : null,
  ].filter(Boolean);
}

export function SourceCheckPanel({
  entry,
  onEntry,
  autoStart = false,
  startOptions = {},
  showOpenHint = false,
  busyLabel,
}) {
  const [check, setCheck] = useState(entry.sourceCheck);
  const [actionBusy, setActionBusy] = useState(false);
  const [actionError, setActionError] = useState("");
  const startedAuto = useRef(false);
  const generation = useRef(0);
  const entryRef = useRef(entry);
  entryRef.current = entry;
  const key = sourceCheckKey(entry);

  const publish = (report) => {
    setActionError("");
    setCheck(report);
    onEntry?.(applySourceCheck(entryRef.current, report));
  };

  const controller = useRef(null);
  useEffect(() => {
    const own = ++generation.current;
    startedAuto.current = false;
    setActionBusy(false);
    setActionError("");
    controller.current?.stop();
    const currentPublish = (report) => {
      if (generation.current === own) publish(report);
    };
    const loadStatus = (signal) =>
      api("library/" + encodeURIComponent(entry.id) + "/check", {
        signal: AbortSignal.any([signal, AbortSignal.timeout(5000)]),
      }).then(checkReport);
    controller.current = createSourceCheckController(
      loadStatus,
      currentPublish,
      {
        onError: (error) => {
          if (generation.current === own)
            setActionError("Check status is unavailable: " + error.message);
        },
      },
    );
    const initial = new AbortController();
    if (!(autoStart && sourceCheckPhase(entry.sourceCheck) === "unchecked")) {
      void loadStatus(initial.signal)
        .then(currentPublish)
        .catch((error) => {
          if (!initial.signal.aborted && generation.current === own)
            setActionError("Check status is unavailable: " + error.message);
        });
    }
    return () => {
      generation.current++;
      initial.abort();
      controller.current?.stop();
    };
  }, [key]);

  useEffect(() => {
    if (sameCheck(check, entry.sourceCheck)) return;
    setCheck(entry.sourceCheck);
  }, [entry.id, entry.sourceCheck]);

  useEffect(() => {
    controller.current?.update(check);
  }, [check]);

  const run = async (override = {}) => {
    const own = generation.current;
    setActionBusy(true);
    setActionError("");
    markSourceCheckRequested(entry.id);
    try {
      const report = checkReport(
        await api("library/" + encodeURIComponent(entry.id) + "/check", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ ...startOptions, ...override }),
          signal: AbortSignal.timeout(10000),
        }),
      );
      if (own === generation.current) publish(report);
    } catch (error) {
      if (own === generation.current) setActionError(error.message);
    } finally {
      if (own === generation.current) setActionBusy(false);
    }
  };

  useEffect(() => {
    if (startedAuto.current || !autoStart) return;
    if (sourceCheckPhase(check) !== "unchecked") return;
    startedAuto.current = true;
    void run();
  }, [autoStart, check]);

  const cancel = async () => {
    const own = generation.current;
    setActionBusy(true);
    setActionError("");
    try {
      const report = checkReport(
        await api("library/" + encodeURIComponent(entry.id) + "/check", {
          method: "DELETE",
          signal: AbortSignal.timeout(10000),
        }),
      );
      if (own === generation.current) publish(report);
    } catch (error) {
      if (own === generation.current) setActionError(error.message);
    } finally {
      if (own === generation.current) setActionBusy(false);
    }
  };
  const refreshStatus = async () => {
    const own = generation.current;
    markSourceCheckRequested(entry.id);
    setActionBusy(true);
    try {
      const report = checkReport(
        await api("library/" + encodeURIComponent(entry.id) + "/check", {
          signal: AbortSignal.timeout(5000),
        }),
      );
      if (own === generation.current) publish(report);
    } catch (error) {
      if (own === generation.current) setActionError(error.message);
    } finally {
      if (own === generation.current) setActionBusy(false);
    }
  };

  const phase = sourceCheckPhase(check);
  const badge = sourceCheckBadge(check);
  const rows = metricRows(check);
  const actionLabel =
    phase === "complete" && !check?.probe
      ? "Check playback sample"
      : phase === "failed" || phase === "cancelled" || phase === "interrupted"
        ? "Retry check"
        : phase === "complete"
          ? "Check again"
          : "Inspect and check";

  return html`
    <div class="source-check panel stacked-sm">
      <div class="section-head">
        <div>
          <h3 class="section-title">Source check</h3>
          <p class="muted" role="status" aria-live="polite">
            ${sourceCheckSummary(check, entry.type)}
          </p>
        </div>
        <span class="status ${badge.tone}">
          <i class="dot ${badge.tone}"></i>${badge.label}
        </span>
      </div>
      ${
        check?.message && phase !== "failed"
          ? html`<p class="inline-note stacked-xs">${check.message}</p>`
          : null
      }
      ${actionError ? html`<p class="danger stacked-xs" role="alert">${actionError}</p>` : null}
      ${
        rows.length
          ? html`<dl class="kv stacked-sm">
              ${rows.map(
                ([label, value]) => html`
                  <div key=${label}>
                    <dt>${label}</dt>
                    <dd>${value}</dd>
                  </div>
                `,
              )}
            </dl>`
          : null
      }
      <div class="actions stacked-sm">
        ${actionError ? html`<button class="secondary" type="button" disabled=${actionBusy} onClick=${refreshStatus}>Refresh status</button>` : null}
        ${
          isSourceCheckActive(check)
            ? html`<button
                class="secondary"
                type="button"
                disabled=${actionBusy}
                onClick=${cancel}
              >
                ${actionBusy ? "Cancelling…" : "Cancel check"}
              </button>`
            : html`<button
                class="primary"
                type="button"
                disabled=${actionBusy}
                onClick=${() => run()}
              >
                ${actionBusy ? busyLabel || "Starting…" : actionLabel}
              </button>`
        }
      </div>
      ${
        showOpenHint
          ? html`<p class="muted stacked-xs">
              You can close this window now. The background check keeps running.
            </p>`
          : null
      }
    </div>
  `;
}
