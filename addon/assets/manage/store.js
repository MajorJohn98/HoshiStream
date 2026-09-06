// Shared app state: a single mutable object plus a subscription hook so
// preact components re-render on changes. Also hosts the activity polling
// hub that feeds the sidebar HUD and the System page — one set of timers for
// the whole app, paused while the tab is hidden.
import { useEffect, useState } from "./vendor/preact-htm.js";
import { api } from "./api.js";

export const state = {
  entries: [],
  status: {},
  selected: null,
  tab: "overview",
  // True while the Add Media modal is open.
  adding: false,
  magnetLinkId: null,
  inspection: null,
  inspectionError: "",
  entryRouteId: null,
  entryRouteLoading: false,
  entryRouteError: "",
  source: "torrent",
  query: "",
  filter: "all",
  // Library tag filter: entries must carry every selected tag.
  tagFilter: [],
  // Registry from GET /api/tags: [{ name, count }].
  tags: [],
  loaded: false,
  loadError: "",
  checkRequests: [],
  checkStatusErrors: {},
  // Live activity, refreshed by startActivityPolling().
  activity: {
    jobs: [],
    volumes: [],
    playback: [],
    repair: [],
    schedule: null,
  },
};

const listeners = new Set();
const checkPollFailures = new Map();

export function markSourceCheckRequested(id) {
  checkPollFailures.delete(id);
  setState({ checkRequests: [...new Set([...state.checkRequests, id])] });
}

export async function refreshSourceCheckReports() {
  const active = new Set(["queued", "inspecting", "probing"]);
  const phases = new Set([
    ...active,
    "unchecked",
    "complete",
    "failed",
    "cancelled",
    "interrupted",
  ]);
  const existing = new Set(state.entries.map((entry) => entry.id));
  const requested = state.checkRequests.filter((id) => existing.has(id));
  for (const id of checkPollFailures.keys())
    if (!existing.has(id)) checkPollFailures.delete(id);
  if (requested.length !== state.checkRequests.length)
    setState({ checkRequests: requested });
  const ids = [
    ...new Set([
      ...requested,
      ...state.entries
        .filter((entry) => active.has(entry.sourceCheck?.phase))
        .map((entry) => entry.id),
    ]),
  ]
    .filter((id) => (checkPollFailures.get(id) ?? 0) < 3)
    .slice(0, 32);
  if (!ids.length) return;
  const before = new Map(state.entries.map((entry) => [entry.id, entry]));
  const reports = await Promise.all(
    ids.map(async (id) => {
      try {
        const report = await api(
          "library/" + encodeURIComponent(id) + "/check",
          { signal: AbortSignal.timeout(5000) },
        );
        if (!report || report.entryId !== id || !phases.has(report.phase))
          throw Error("Invalid check status");
        checkPollFailures.delete(id);
        return { id, report };
      } catch {
        checkPollFailures.set(id, (checkPollFailures.get(id) ?? 0) + 1);
        return {
          id,
          error: "Check status is unavailable. Open the entry to refresh it.",
        };
      }
    }),
  );
  const errors = { ...state.checkStatusErrors };
  let selected = state.selected;
  let pending = state.checkRequests;
  const byId = new Map(reports.map((report) => [report.id, report]));
  const entries = state.entries.map((entry) => {
    const result = byId.get(entry.id);
    if (!result) return entry;
    if (entry !== before.get(entry.id)) return entry;
    if (result.error) {
      errors[entry.id] = result.error;
      return entry;
    }
    delete errors[entry.id];
    if (!active.has(result.report.phase))
      pending = pending.filter((id) => id !== entry.id);
    const next = {
      ...entry,
      sourceCheck:
        result.report.phase === "unchecked" ? undefined : result.report,
    };
    if (selected === entry) selected = next;
    return next;
  });
  setState({
    entries,
    selected,
    checkRequests: pending,
    checkStatusErrors: errors,
  });
}

export function setState(patch) {
  Object.assign(state, patch);
  for (const listener of listeners) listener();
}

export function useStore() {
  const [, force] = useState(0);
  useEffect(() => {
    const listener = () => force((n) => n + 1);
    listeners.add(listener);
    return () => listeners.delete(listener);
  }, []);
  return state;
}

export async function load() {
  const [entries, status, tags] = await Promise.all([
    api("library"),
    api("status"),
    api("tags").catch(() => ({ tags: state.tags })),
  ]);
  setState({ entries, status, tags: tags.tags, loaded: true, loadError: "" });
}

// Refresh the download queue now rather than on the next poll tick, so a
// pause or resume shows immediately.
export async function loadJobs() {
  const report = await api("disk-jobs");
  setState({ activity: { ...state.activity, jobs: report.jobs } });
}

export async function loadTags() {
  const { tags } = await api("tags");
  setState({ tags });
}

function poller(intervalMs, tick) {
  const run = async () => {
    if (document.hidden) return;
    try {
      await tick();
    } catch {
      // transient failures keep the last snapshot
    }
  };
  void run();
  return setInterval(run, intervalMs);
}

let pollingStarted = false;

// Refresh cadences follow how fast each fact changes: copy progress is the
// liveliest, service status the calmest. Every tick patches state.activity so
// any subscribed component (HUD, System cards) re-renders together.
export function startActivityPolling() {
  if (pollingStarted) return;
  pollingStarted = true;
  poller(3000, refreshSourceCheckReports);
  addEventListener("online", () => checkPollFailures.clear());
  poller(3000, async () => {
    const report = await api("disk-jobs").catch(() => null);
    if (report)
      setState({ activity: { ...state.activity, jobs: report.jobs } });
  });
  poller(6000, async () => {
    const report = await api("playback").catch(() => null);
    if (report)
      setState({ activity: { ...state.activity, playback: report.sessions } });
    if (state.status.transcode?.enabled) {
      const repair = await api("transcode/sessions").catch(() => null);
      if (repair) setState({ activity: { ...state.activity, repair } });
    }
  });
  poller(12000, async () => {
    const report = await api("volumes").catch(() => null);
    if (report)
      setState({ activity: { ...state.activity, volumes: report.volumes } });
    const schedule = await api("disk-schedule").catch(() => null);
    if (schedule) setState({ activity: { ...state.activity, schedule } });
  });
  poller(15000, async () => {
    const status = await api("status").catch(() => null);
    if (status) setState({ status });
  });
}
