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
  inspection: null,
  inspectionError: "",
  source: "torrent",
  query: "",
  filter: "all",
  // Library tag filter: entries must carry every selected tag.
  tagFilter: [],
  // Registry from GET /api/tags: [{ name, count }].
  tags: [],
  loaded: false,
  loadError: "",
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
