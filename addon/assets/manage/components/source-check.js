import { html, useEffect, useRef, useState } from "../vendor/preact-htm.js";
import { api, fmt } from "../api.js";
import { createRequestGate } from "../import-state.js";
import { markSourceCheckRequested, state } from "../store.js";

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
  complete: { tone: "idle", label: "Sample unverified" },
  failed: { tone: "warn", label: "Check unavailable" },
  cancelled: { tone: "idle", label: "Check cancelled" },
  interrupted: { tone: "warn", label: "Check interrupted" },
};

function sameCheck(left, right) {
  return (
    sourceCheckPhase(left) === sourceCheckPhase(right) &&
    left?.updatedAt === right?.updatedAt &&
    left?.message === right?.message &&
    left?.jobId === right?.jobId &&
    left?.fileId === right?.fileId &&
    left?.outcome === right?.outcome &&
    left?.technical?.decodedVideoFrames === right?.technical?.decodedVideoFrames
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

export function sourceCheckOutcome(check) {
  if (check?.outcome) return check.outcome;
  if (
    check?.phase === "failed" &&
    ["probe_timeout", "metadata_timeout", "check_timeout", "timeout"].includes(
      check.code,
    )
  )
    return "inconclusive";
  return check?.phase === "failed" ? "unavailable" : "observed";
}

export function hasReadableSample(check) {
  return (
    check?.phase === "complete" &&
    sourceCheckOutcome(check) === "observed" &&
    check.probe === true &&
    check.technical?.decodedVideoFrames >= 1
  );
}

export function sourceCheckBadge(check, error) {
  if (error) return { tone: "warn", label: "Status unavailable" };
  const phase = sourceCheckPhase(check);
  if (phase === "complete" || phase === "failed") {
    const outcome = sourceCheckOutcome(check);
    if (outcome === "inconclusive")
      return { tone: "warn", label: "Check inconclusive" };
    if (outcome === "invalid") return { tone: "bad", label: "Invalid source" };
    if (outcome === "unavailable") return SOURCE_CHECK_BADGES.failed;
  }
  if (phase !== "complete")
    return (
      SOURCE_CHECK_BADGES[phase] ?? { tone: "warn", label: "Unknown status" }
    );
  if (hasReadableSample(check)) return { tone: "ok", label: "Sample read" };
  if (check?.probe === false) return { tone: "idle", label: "Metadata found" };
  return SOURCE_CHECK_BADGES.complete;
}

export function sourceCheckSummary(check, entryType = "movie") {
  const phase = sourceCheckPhase(check);
  if (phase === "unchecked")
    return "Not checked yet. A basic check inspects metadata and tries a small media sample, for up to 1 minute.";
  if (phase === "queued")
    return check?.probe === false
      ? "Queued to inspect source metadata."
      : "Queued to inspect the source and read a limited media sample after saving.";
  if (phase === "inspecting")
    return "Inspecting source metadata. This may contact peers but does not switch sources or request a full download.";
  if (phase === "probing")
    return "Trying a small sample from one selected file. Engine read-ahead may fetch extra data; this is not a strict network-byte limit.";
  if (phase === "cancelled")
    return "The background check was cancelled. The library entry and source were kept unchanged.";
  if (phase === "interrupted")
    return "The background check stopped because the source changed or the app restarted. Retry when you are ready.";
  const outcome = sourceCheckOutcome(check);
  if (outcome === "inconclusive")
    return `The ${check?.stage === "metadata" || check?.code === "metadata_timeout" || check?.probe === false ? "metadata" : "sample"} check did not collect enough evidence within its limits. This does not mean the source is unplayable. Retry for longer or try direct playback.`;
  if (outcome === "invalid")
    return "The check found invalid source or media data. Review the source details before retrying.";
  if (outcome === "unavailable")
    return "This attempt could not check the source. The entry was kept; try again when the engine, file, or connection is available.";
  if (hasReadableSample(check))
    return `A small video sample from one ${entryType === "series" ? "episode" : "file"} was decoded on this computer. This is not a ready-to-play guarantee: other files, later seeks, sustained playback, and browser support remain untested.`;
  if (check?.probe === false)
    return "Source metadata was found; playback has not been checked. File listings do not establish media availability.";
  return "This check has no recorded decoded-frame evidence. Treat any saved technical details as historical metadata, not a verified media sample.";
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
  if (!Number.isFinite(Date.parse(iso))) return "Unknown time";
  const minutes = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 6e4));
  if (minutes < 1) return "just now";
  if (minutes < 60) return minutes + " min ago";
  const hours = Math.round(minutes / 60);
  if (hours < 24) return hours + " h ago";
  return Math.round(hours / 24) + " days ago";
}

// `lineFit` is the server's `{ lineMbps, fitMbps }` from /api/status, so the
// verdict here matches the stream ordering exactly rather than re-deriving it.
export function lineFitLabel(bitrateMbps, lineFit) {
  if (!bitrateMbps || !lineFit || !lineFit.fitMbps) return undefined;
  const need = bitrateMbps.toFixed(1);
  const line = Math.round(lineFit.lineMbps);
  return bitrateMbps <= lineFit.fitMbps
    ? `Fits · needs ${need} Mbps of ~${line} Mbps`
    : `Heavy · needs ${need} Mbps, line ~${line} Mbps`;
}

export function sourceCheckRows(check, lineFit) {
  if (!check) return [];
  const technical = check.technical || {};
  const fit = lineFitLabel(technical.bitrateMbps, lineFit);
  return [
    check.checkedFiles !== undefined && check.totalFiles !== undefined
      ? [
          "Sample coverage",
          `${hasReadableSample(check) ? check.checkedFiles : 0} of ${check.totalFiles} ${
            check.totalFiles === 1 ? "file" : "files"
          }`,
        ]
      : null,
    check.filePath
      ? ["File", check.filePath]
      : check.fileId !== undefined
        ? ["File ID", String(check.fileId)]
        : null,
    check.browserSupport || check.phase
      ? [
          "Browser hint",
          check.browserSupport === "likely"
            ? "Likely · not tested in this browser"
            : check.browserSupport === "limited"
              ? "Limited · a native player may differ"
              : "Uncertain",
        ]
      : null,
    technical.container
      ? ["Container", technical.container.toUpperCase()]
      : null,
    technical.videoCodec ? ["Video", technical.videoCodec.toUpperCase()] : null,
    technical.videoProfile ? ["Video profile", technical.videoProfile] : null,
    technical.pixelFormat ? ["Pixel format", technical.pixelFormat] : null,
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
    fit ? ["Line fit", fit] : null,
    (check.fileLength ?? technical.sizeBytes) !== undefined
      ? ["File size", fmt(check.fileLength ?? technical.sizeBytes)]
      : null,
    check.stage
      ? ["Check stage", check.stage === "sample" ? "Media sample" : "Metadata"]
      : null,
    check.mode
      ? [
          "Time limit",
          check.mode === "extended"
            ? "Up to 3 minutes · extended"
            : "Up to 1 minute · basic",
        ]
      : null,
    check.updatedAt
      ? ["Last attempt", `${agoLabel(check.updatedAt)} · ${check.updatedAt}`]
      : null,
  ].filter(Boolean);
}

export function sourceCheckRequestOptions(
  startOptions = {},
  check,
  mode = "basic",
) {
  const fileId =
    mode === "extended"
      ? (check?.fileId ?? startOptions.fileId)
      : (startOptions.fileId ?? check?.fileId);
  return {
    ...startOptions,
    probe: startOptions.probe ?? true,
    ...(fileId === undefined ? {} : { fileId }),
    mode,
  };
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

  const run = async (mode = "basic") => {
    const own = generation.current;
    setActionBusy(true);
    setActionError("");
    markSourceCheckRequested(entry.id);
    try {
      const report = checkReport(
        await api("library/" + encodeURIComponent(entry.id) + "/check", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(
            sourceCheckRequestOptions(startOptions, check, mode),
          ),
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
  const rows = sourceCheckRows(check, state.status.lineFit);
  const history = (entry.mediaFacts ?? []).filter(
    (fact) => fact.jobId !== check?.jobId,
  );
  const actionLabel =
    phase === "complete" && !check?.probe
      ? "Check media sample"
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
        check?.message && sourceCheckOutcome(check) !== "observed"
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
      ${
        history.length
          ? html`<details class="stacked-sm">
              <summary>Earlier file facts (${history.length})</summary>
              <p class="muted stacked-xs">
                Historical metadata belongs only to the named file. It does not
                replace the latest check result or establish current
                availability.
              </p>
              ${history.map(
                (fact) =>
                  html`<dl
                    class="kv stacked-sm"
                    key=${fact.jobId + ":" + fact.fileId}
                  >
                    ${[
                      ["File", fact.filePath],
                      ["Observed", fact.observedAt],
                      ...sourceCheckRows({
                        technical: fact.technical,
                        fileLength: fact.fileLength,
                      }),
                    ].map(
                      ([label, value]) =>
                        html`<div key=${label}>
                          <dt>${label}</dt>
                          <dd>${value}</dd>
                        </div>`,
                    )}
                  </dl>`,
              )}
            </details>`
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
        ${
          !isSourceCheckActive(check) && phase !== "unchecked"
            ? html`<button
                class="secondary"
                type="button"
                disabled=${actionBusy}
                onClick=${() => run("extended")}
              >
                Retry longer (up to 3 min)
              </button>`
            : null
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
