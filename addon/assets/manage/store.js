// Shared app state: a single mutable object plus a subscription hook so
// preact components re-render on changes. The legacy detail view mutates
// this object directly (via the app.js `state` re-export) and manages its
// own DOM, so plain mutation without notify() is still safe there.
import { useEffect, useState } from "./vendor/preact-htm.js";
import { api } from "./api.js";

export const state = {
  entries: [],
  status: {},
  selected: null,
  tab: "overview",
  inspection: null,
  inspectionError: "",
  source: "torrent",
  query: "",
  filter: "all",
  loaded: false,
  loadError: "",
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
  const [entries, status] = await Promise.all([api("library"), api("status")]);
  setState({ entries, status, loaded: true, loadError: "" });
}
