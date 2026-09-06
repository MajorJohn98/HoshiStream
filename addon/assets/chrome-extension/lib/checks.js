import { ACTIVE_CHECK_PHASES } from "./constants.js";

const CHECK_BADGES = {
  unchecked: { tone: "idle", label: "Not checked" },
  queued: { tone: "warn", label: "Queued" },
  inspecting: { tone: "warn", label: "Inspecting…" },
  probing: { tone: "warn", label: "Checking…" },
  complete: { tone: "ok", label: "Checked" },
  failed: { tone: "bad", label: "Check failed" },
  cancelled: { tone: "idle", label: "Check cancelled" },
  interrupted: { tone: "warn", label: "Check interrupted" },
};

export function checkPhase(check) {
  return check?.phase ?? "unchecked";
}

export function isActiveCheck(check) {
  return ACTIVE_CHECK_PHASES.has(checkPhase(check));
}

export function checkBadge(check) {
  const phase = checkPhase(check);
  if (phase !== "complete")
    return CHECK_BADGES[phase] ?? CHECK_BADGES.unchecked;
  if (!check?.probe) return { tone: "ok", label: "Inspected" };
  if (check.browserSupport === "limited") {
    return { tone: "warn", label: "Browser limited" };
  }
  if (check.browserSupport === "likely") {
    return { tone: "ok", label: "Browser likely" };
  }
  return CHECK_BADGES.complete;
}

export function checkSummary(check, entryType = "movie") {
  const itemLabel = entryType === "series" ? "episode" : "file";
  switch (checkPhase(check)) {
    case "unchecked":
      return "Run a source check when you want metadata and a bounded playback sample.";
    case "queued":
      return "Queued to inspect the source and read a limited media sample after saving.";
    case "inspecting":
      return "Inspecting metadata. This may contact peers but does not switch sources or download the full title.";
    case "probing":
      return `Reading a limited sample from one representative ${itemLabel}. This is still not a ready-to-play guarantee.`;
    case "cancelled":
      return "The check was cancelled. Your saved library entry stayed unchanged.";
    case "interrupted":
      return "The check stopped because the source changed or the app restarted. Retry when you are ready.";
    case "failed":
      return check?.message || "The source check failed.";
    case "complete":
      if (!check?.probe) {
        return "Metadata inspection finished, but playback has not been checked yet.";
      }
      if (check.browserSupport === "limited") {
        return `One representative ${itemLabel} completed a bounded check, but browser support looks limited.`;
      }
      if (check.browserSupport === "likely") {
        return `One representative ${itemLabel} completed a bounded playback check. That is a useful browser hint, not a ready-to-play guarantee.`;
      }
      return `A representative ${itemLabel} completed a bounded check, but browser support is still uncertain.`;
    default:
      return "Refresh the check status.";
  }
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
