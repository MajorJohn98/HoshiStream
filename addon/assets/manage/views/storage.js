// Storage page: registered volumes (external drives or folders identified by
// their on-disk marker), live state and free space, the download schedule,
// and the archive queue. Volume status polls also trigger deferred-cleanup
// sweeps server-side.
import { html, useEffect, useState } from "../vendor/preact-htm.js";
import { api, fmt, notify } from "../api.js";
import { setState, useStore, load, loadJobs } from "../store.js";
import { Shell } from "../components/shell.js";

function usePoll(path, intervalMs, refreshTick = 0) {
  const [value, setValue] = useState(null);
  useEffect(() => {
    let alive = true;
    const poll = async () => {
      if (document.hidden) return;
      try {
        const next = await api(path);
        if (alive) setValue(next);
      } catch {
        // transient failures keep the last result
      }
    };
    void poll();
    const timer = setInterval(poll, intervalMs);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [path, intervalMs, refreshTick]);
  return value;
}

const STATE_LABELS = {
  online: "Online",
  offline: "Offline",
  ambiguous: "Two drives carry this volume",
  "permission-denied": "Not readable",
};
const STATE_TONES = {
  online: "ok",
  offline: "idle",
  ambiguous: "warn",
  "permission-denied": "warn",
};

function entriesOn(entries, volumeId) {
  return entries.filter((entry) => entry.diskCopy?.volumeId === volumeId);
}

function Volumes({ entries }) {
  const [refreshTick, setRefreshTick] = useState(0);
  const [busy, setBusy] = useState(false);
  const report = usePoll("volumes", 5000, refreshTick);
  const volumes = report?.volumes ?? [];
  const add = async () => {
    setBusy(true);
    try {
      const volume = await api("volumes", { method: "POST" });
      notify("Registered " + volume.label);
      setRefreshTick((tick) => tick + 1);
    } catch (error) {
      notify(error.message);
    } finally {
      setBusy(false);
    }
  };
  const forget = async (volume) => {
    const stored = entriesOn(entries, volume.id);
    if (
      !confirm(
        "Forget " +
          volume.label +
          "? Files on the drive stay untouched" +
          (stored.length
            ? ", but " +
              stored.length +
              " entr" +
              (stored.length === 1 ? "y" : "ies") +
              " will lose disk playback."
            : "."),
      )
    )
      return;
    try {
      await api("volumes/" + encodeURIComponent(volume.id), {
        method: "DELETE",
      });
      notify("Volume forgotten");
      setRefreshTick((tick) => tick + 1);
    } catch (error) {
      notify(error.message);
    }
  };
  return html`
    <section class="page-section" id="storage-volumes">
      <div class="section-head">
        <div>
          <h2 class="section-title">Volumes</h2>
          <p class="muted">
            Drives and folders that keep playable copies. A drive is recognized
            by a marker file, not its name — renamed or remounted drives are
            found again, look-alikes never are.
          </p>
        </div>
        <button class="primary" disabled=${busy} onClick=${add}>
          ${busy ? "Choose a folder in Finder…" : "+ Add drive or folder"}
        </button>
      </div>
      ${
        volumes.length === 0
          ? html`<p class="empty quiet">No storage registered yet.</p>`
          : html`<ul class="rows">
              ${volumes.map((volume) => {
                const stored = entriesOn(entries, volume.id);
                const tone = STATE_TONES[volume.state] ?? "warn";
                return html`
                  <li class="rowitem" key=${volume.id}>
                    <span class="lead"><i class="dot ${tone}"></i></span>
                    <span class="main">
                      <strong>${volume.label}</strong>
                      <span class="meta">
                        ${STATE_LABELS[volume.state] || volume.state}
                        ${
                          volume.state === "online"
                            ? " · " +
                              fmt(volume.freeBytes ?? 0) +
                              " free of " +
                              fmt(volume.totalBytes ?? 0) +
                              " · " +
                              volume.root
                            : ""
                        }
                      </span>
                    </span>
                    <span class="trail">
                      <span class="value">
                        ${stored.length}
                        entr${stored.length === 1 ? "y" : "ies"}
                      </span>
                      <button class="secondary" onClick=${() => forget(volume)}>
                        Forget
                      </button>
                    </span>
                  </li>
                `;
              })}
            </ul>`
      }
    </section>
  `;
}

function Schedule() {
  const [schedule, setSchedule] = useState(null);
  const [start, setStart] = useState("01:00");
  const [end, setEnd] = useState("07:00");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    api("disk-schedule")
      .then((report) => {
        setSchedule(report);
        if (report.window) {
          setStart(report.window.start);
          setEnd(report.window.end);
        }
      })
      .catch(() => setSchedule({ window: null, active: true }));
  }, []);
  const save = async (enabled) => {
    setBusy(true);
    try {
      const report = await api("disk-schedule", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(enabled ? { enabled, start, end } : { enabled }),
      });
      setSchedule(report);
      notify(
        report.window
          ? "Downloads limited to " + report.window.label
          : "Downloads run anytime",
      );
    } catch (error) {
      notify(error.message);
    } finally {
      setBusy(false);
    }
  };
  if (!schedule) return null;
  const open = schedule.active;
  return html`
    <section class="page-section" id="storage-schedule">
      <div class="section-head">
        <div>
          <h2 class="section-title">Download window</h2>
          <p class="muted">
            Limit archiving to a time window (overnight windows like 23:00–06:00
            work). A file already copying finishes; new files wait. Playback and
            its torrent fallback are never scheduled.
          </p>
        </div>
        <span class="status ${schedule.window ? (open ? "ok" : "idle") : "ok"}">
          <i class="dot ${schedule.window ? (open ? "ok" : "idle") : "ok"}"></i>
          ${
            schedule.window
              ? open
                ? "Window open"
                : "Window closed — queue waits"
              : "Downloads run anytime"
          }
        </span>
      </div>
      <div class="row tight stacked-sm">
        <label class="check">
          From
          <input
            type="time"
            value=${start}
            onInput=${(event) => setStart(event.target.value)}
          />
        </label>
        <label class="check">
          to
          <input
            type="time"
            value=${end}
            onInput=${(event) => setEnd(event.target.value)}
          />
        </label>
        <button class="primary" disabled=${busy} onClick=${() => save(true)}>
          ${schedule.window ? "Update window" : "Enable window"}
        </button>
        ${
          schedule.window
            ? html`<button
                class="secondary"
                disabled=${busy}
                onClick=${() => save(false)}
              >
                Download anytime
              </button>`
            : null
        }
      </div>
    </section>
  `;
}

function jobLabel(job, entries) {
  const entry = entries.find((candidate) => candidate.id === job.entryId);
  return entry?.name ?? job.entryId;
}

async function diskAction(entryId, action, message) {
  try {
    await api(
      "library/" + encodeURIComponent(entryId) + "/disk-copy/" + action,
      { method: "POST" },
    );
    notify(message);
    await Promise.all([load(), loadJobs()]);
  } catch (error) {
    notify(error.message);
  }
}

function Jobs({ entries }) {
  const { activity } = useStore();
  const jobs = activity.jobs;
  const copying = jobs.filter((job) => job.status === "copying").length;
  const paused = jobs.filter((job) => job.status === "paused").length;
  return html`
    <section class="page-section" id="storage-queue">
      <div class="section-head">
        <div>
          <h2 class="section-title">Downloads</h2>
          <p class="muted">
            One title copies at a time. Paused downloads stay paused until you
            resume them; a disconnected drive pauses its downloads until it is
            back.
          </p>
        </div>
        <span class="inline-note">
          ${
            jobs.length
              ? [
                  copying + " copying",
                  jobs.length - copying - paused + " waiting",
                  paused ? paused + " paused" : "",
                ]
                  .filter(Boolean)
                  .join(" · ")
              : "Idle"
          }
        </span>
      </div>
      ${
        jobs.length === 0
          ? html`<p class="empty quiet">Nothing to download right now.</p>`
          : html`<ul class="rows">
              ${jobs.map((job) => {
                const p = job.progress;
                const percent = p.totalBytes
                  ? Math.min(
                      100,
                      Math.round((p.doneBytes / p.totalBytes) * 100),
                    )
                  : 0;
                const tone =
                  job.status === "copying"
                    ? "live"
                    : job.status === "paused"
                      ? "idle"
                      : job.status === "queued"
                        ? "idle"
                        : "warn";
                const label =
                  job.status === "copying"
                    ? "Copying"
                    : job.status === "paused"
                      ? "Paused"
                      : job.status === "queued"
                        ? "Queued"
                        : job.reason || "Waiting";
                const detail =
                  fmt(p.doneBytes) +
                  " of " +
                  fmt(p.totalBytes) +
                  (p.totalFiles > 1
                    ? " · " + p.doneFiles + " of " + p.totalFiles + " files"
                    : "");
                return html`
                  <li class="rowitem" key=${job.entryId}>
                    <span class="lead"><i class="dot ${tone}"></i></span>
                    <span class="main">
                      <strong>${jobLabel(job, entries)}</strong>
                      <span class="meta">${label} · ${detail}</span>
                      <span
                        class="bar ${job.status === "copying" ? "" : "quiet"}"
                      >
                        <span
                          style=${"transform:scaleX(" + percent / 100 + ")"}
                        ></span>
                      </span>
                    </span>
                    <span class="trail">
                      <span class="value">${percent}%</span>
                      ${
                        job.status === "paused"
                          ? html`<button
                              class="secondary"
                              onClick=${() =>
                                diskAction(job.entryId, "resume", "Resumed")}
                            >
                              Resume
                            </button>`
                          : html`<button
                              class="secondary"
                              onClick=${() =>
                                diskAction(job.entryId, "pause", "Paused")}
                            >
                              Pause
                            </button>`
                      }
                    </span>
                  </li>
                `;
              })}
            </ul>`
      }
    </section>
  `;
}

async function deleteCopy(entry) {
  if (
    !confirm(
      "Delete the copied files for “" +
        entry.name +
        "” from the drive? The title stays in your library and keeps " +
        "streaming from its torrent. If the drive is offline, deletion runs " +
        "when it returns.",
    )
  )
    return;
  try {
    await api("library/" + encodeURIComponent(entry.id) + "/disk-copy", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ enabled: false, deleteFiles: true }),
    });
    notify("Disk copy removed");
    await Promise.all([load(), loadJobs()]);
  } catch (error) {
    notify(error.message);
  }
}

export function StorageSection() {
  const { entries } = useStore();
  const stored = entries.filter((entry) => entry.diskCopy?.desired === "keep");
  return html`
    <${Volumes} entries=${entries} />
    <section class="page-section" id="storage-kept">
      <div class="section-head">
        <div>
          <h2 class="section-title">Kept on disk</h2>
          <p class="muted">
            Streamed from the drive when it is connected, from the torrent when
            it is not.
          </p>
        </div>
        <span class="inline-note">
          ${stored.length} title${stored.length === 1 ? "" : "s"}
        </span>
      </div>
      ${
        stored.length === 0
          ? html`<p class="empty quiet">
              None yet — open a title and switch on “Keep on disk”.
            </p>`
          : html`<ul class="rows">
              ${stored.map((entry) => {
                const files = entry.diskCopy.files.filter(
                  (file) => file.included,
                );
                const complete = files.filter(
                  (file) => file.state === "complete",
                ).length;
                const done = complete === files.length;
                const open = () =>
                  setState({ selected: entry, tab: "storage" });
                return html`
                  <li
                    class="rowitem clickable"
                    role="button"
                    tabindex="0"
                    title="Open in the entry sheet"
                    key=${entry.id}
                    onClick=${open}
                    onKeyDown=${(e) => {
                      if (e.key === "Enter" || e.key === " ") {
                        e.preventDefault();
                        open();
                      }
                    }}
                  >
                    <span class="lead"
                      ><i class="dot ${done ? "ok" : "idle"}"></i
                    ></span>
                    <span class="main">
                      <strong>${entry.name}</strong>
                      <span class="meta">
                        ${
                          done
                            ? "On disk"
                            : complete + " of " + files.length + " files"
                        }
                      </span>
                    </span>
                    <span class="trail">
                      <span class="value">
                        ${fmt(files.reduce((sum, file) => sum + file.length, 0))}
                      </span>
                      <button
                        class="danger"
                        title="Delete the copied files from the drive"
                        onClick=${(event) => {
                          event.stopPropagation();
                          deleteCopy(entry);
                        }}
                      >
                        Delete files
                      </button>
                    </span>
                  </li>
                `;
              })}
            </ul>`
      }
    </section>
    <${Jobs} entries=${entries} />
    <${Schedule} />
  `;
}

export function StorageView() {
  return html`
    <${Shell} title="Storage">
      <${StorageSection} />
    <//>
  `;
}
