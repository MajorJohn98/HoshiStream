import { ACTIVE_CHECK_PHASES } from "./constants.js";

const CHECK_BADGES = {
  unchecked: { tone: "idle", label: "Not checked" },
  queued: { tone: "warn", label: "Queued" },
  inspecting: { tone: "warn", label: "Inspecting…" },
  probing: { tone: "warn", label: "Checking…" },
  complete: { tone: "idle", label: "Sample unverified" },
  failed: { tone: "warn", label: "Check unavailable" },
  cancelled: { tone: "idle", label: "Check cancelled" },
  interrupted: { tone: "warn", label: "Check interrupted" },
};

export function checkPhase(check) {
  return check?.phase ?? "unchecked";
}

export function isActiveCheck(check) {
  return ACTIVE_CHECK_PHASES.has(checkPhase(check));
}

export function checkOutcome(check) {
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
    checkOutcome(check) === "observed" &&
    check.probe === true &&
    check.technical?.decodedVideoFrames >= 1
  );
}

export function checkBadge(check) {
  const phase = checkPhase(check);
  if (phase === "complete" || phase === "failed") {
    const outcome = checkOutcome(check);
    if (outcome === "inconclusive")
      return { tone: "warn", label: "Check inconclusive" };
    if (outcome === "invalid") return { tone: "bad", label: "Invalid source" };
    if (outcome === "unavailable") return CHECK_BADGES.failed;
  }
  if (phase !== "complete")
    return CHECK_BADGES[phase] ?? CHECK_BADGES.unchecked;
  if (hasReadableSample(check)) return { tone: "ok", label: "Sample read" };
  if (check?.probe === false) return { tone: "idle", label: "Metadata found" };
  return CHECK_BADGES.complete;
}

export function checkSummary(check, entryType = "movie") {
  const itemLabel = entryType === "series" ? "episode" : "file";
  switch (checkPhase(check)) {
    case "unchecked":
      return "A basic check inspects metadata and tries a small media sample, for up to 1 minute.";
    case "queued":
      return check?.probe === false
        ? "Queued to inspect source metadata."
        : "Queued to inspect the source and try a small media sample.";
    case "inspecting":
      return "Inspecting metadata. This may contact peers but does not switch sources or request a full download.";
    case "probing":
      return `Trying a small sample from one selected ${itemLabel}. Engine read-ahead may fetch extra data; this is not a strict network-byte limit.`;
    case "cancelled":
      return "The check was cancelled. Your saved library entry stayed unchanged.";
    case "interrupted":
      return "The check stopped because the source changed or the app restarted. Retry when you are ready.";
    case "failed":
    case "complete":
      if (checkOutcome(check) === "inconclusive")
        return `The ${check?.stage === "metadata" || check?.code === "metadata_timeout" || check?.probe === false ? "metadata" : "sample"} check did not collect enough evidence within its limits. This does not mean the source is unplayable. Retry for longer or open the entry for direct playback.`;
      if (checkOutcome(check) === "invalid")
        return (
          check?.message ||
          "Invalid source or media data. Review the source before retrying."
        );
      if (checkOutcome(check) === "unavailable")
        return `This attempt could not check the source. ${check?.message || "Retry when the engine, file, or connection is available."} Your entry was kept.`;
      if (hasReadableSample(check))
        return `A small video sample from one ${itemLabel} was decoded on this computer. This is not a ready-to-play guarantee: other files, later seeks, sustained playback, and browser support remain untested.`;
      if (check?.probe === false)
        return "Metadata was found; playback has not been checked. File listings do not establish media availability.";
      return "No decoded-frame evidence was recorded. Saved technical details are historical metadata, not a verified media sample.";
    default:
      return "Refresh the check status.";
  }
}

export function checkDetails(check) {
  if (!check) return "";
  const browser =
    check.browserSupport === "likely"
      ? "Likely (not tested in this browser)"
      : check.browserSupport === "limited"
        ? "Limited (a native player may differ)"
        : "Uncertain";
  return [
    check.mode === "extended"
      ? "Extended: up to 3 minutes."
      : "Basic: up to 1 minute.",
    check.filePath
      ? `File: ${check.filePath}.`
      : check.fileId !== undefined
        ? `File ID: ${check.fileId}.`
        : "",
    check.totalFiles !== undefined
      ? `Sample coverage: ${hasReadableSample(check) ? (check.checkedFiles ?? 1) : 0} of ${check.totalFiles} files.`
      : "",
    `Browser hint: ${browser}.`,
    check.updatedAt ? `Last attempt: ${check.updatedAt}.` : "",
  ]
    .filter(Boolean)
    .join(" ");
}

export function checkActions(check) {
  if (checkPhase(check) === "unchecked")
    return [
      {
        label: "Start check",
        command: "panel:startCheck",
        payload: { mode: "basic" },
      },
    ];
  const actions = [{ label: "Refresh status", command: "panel:getCheck" }];
  if (isActiveCheck(check))
    return [
      ...actions,
      { label: "Cancel check", command: "panel:cancelCheck" },
    ];
  return [
    ...actions,
    {
      label: "Retry check",
      command: "panel:startCheck",
      payload: { mode: "basic" },
    },
    {
      label: "Retry longer (up to 3 min)",
      command: "panel:startCheck",
      payload: { mode: "extended" },
    },
  ];
}

export function startCheckPayload(entry, check, mode = "basic") {
  if (mode !== "basic" && mode !== "extended")
    throw new Error("Choose a basic or extended source check.");
  const fileId = check?.fileId ?? entry.checkFileId;
  return {
    entryId: entry.id,
    ...(fileId === undefined ? {} : { fileId }),
    mode,
  };
}

export function createCheckPoller(
  load,
  publish,
  {
    schedule = (callback, delay) => setTimeout(callback, delay),
    clear = (handle) => clearTimeout(handle),
    delayMs = 1_500,
    maxFailures = 3,
    onError = () => {},
  } = {},
) {
  let timer = null;
  let stopped = false;
  let current = null;
  let failures = 0;
  let ticket = 0;

  const clearTimer = () => {
    if (timer !== null) {
      clear(timer);
      timer = null;
    }
  };

  const queue = () => {
    clearTimer();
    if (stopped || !isActiveCheck(current)) return;
    timer = schedule(
      async () => {
        if (stopped) return;
        const own = ++ticket;
        try {
          const next = await load();
          if (stopped || own !== ticket) return;
          failures = 0;
          current = next;
          publish(next);
          queue();
        } catch (error) {
          if (stopped || own !== ticket) return;
          failures += 1;
          onError(error);
          if (failures < maxFailures) queue();
        }
      },
      Math.min(15_000, delayMs * 2 ** failures),
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
      ticket += 1;
      clearTimer();
    },
  };
}
