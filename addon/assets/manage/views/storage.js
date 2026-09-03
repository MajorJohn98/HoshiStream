// Storage view: registered volumes (external drives or folders identified by
// their on-disk marker), live online state and free space, plus the archive
// queue. Volume status polls also trigger deferred-cleanup sweeps server-side.
import { html, useEffect, useState } from "../vendor/preact-htm.js";
import { api, fmt, notify } from "../api.js";
import { setState, useStore } from "../store.js";
import { Shell, Pill } from "../components/shell.js";

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
  online: "● Online",
  offline: "○ Offline",
  ambiguous: "! Two drives carry this volume",
  "permission-denied": "! Not readable",
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
    <div class="panel" style="margin-top:18px">
      <h2>Storage volumes</h2>
      <p class="muted">
        Drives and folders where entries can keep a playable copy. A drive is
        recognized by a marker file, not its name — renamed or remounted drives
        are found again, look-alikes never are.
      </p>
      ${
        volumes.length === 0
          ? html`<p class="muted">No storage registered yet.</p>`
          : html`<div class="metrics">
              ${volumes.map((volume) => {
                const stored = entriesOn(entries, volume.id);
                return html`
                  <div class="metric">
                    <${Pill}
                      online=${volume.state === "online"}
                      warn=${
                        volume.state !== "online" && volume.state !== "offline"
                      }
                    >
                      ${STATE_LABELS[volume.state] || volume.state}
                    <//>
                    <strong>${volume.label}</strong>
                    <span class="muted">
                      ${
                        volume.state === "online"
                          ? fmt(volume.freeBytes ?? 0) +
                            " free of " +
                            fmt(volume.totalBytes ?? 0) +
                            " · "
                          : ""
                      }
                      ${stored.length} entr${stored.length === 1 ? "y" : "ies"}
                      stored
                    </span>
                    ${
                      volume.state === "online"
                        ? html`<span class="muted">${volume.root}</span>`
                        : null
                    }
                    <span>
                      <button class="secondary" onClick=${() => forget(volume)}>
                        Forget
                      </button>
                    </span>
                  </div>
                `;
              })}
            </div>`
      }
      <div style="margin-top:12px">
        <button class="primary" disabled=${busy} onClick=${add}>
          ${busy ? "Choose a folder in Finder…" : "+ Add drive or folder"}
        </button>
      </div>
    </div>
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
  return html`
    <div class="panel" style="margin-top:18px">
      <h2>Download schedule</h2>
      <p class="muted">
        Limit archiving to a time window (overnight windows like 23:00–06:00
        work). A file already copying finishes; new files wait for the window.
        Playback and its torrent fallback are never scheduled.
      </p>
      <div class="row" style="gap:8px;align-items:center;flex-wrap:wrap">
        <label style="display:flex;gap:6px;align-items:center">
          From
          <input
            type="time"
            value=${start}
            onInput=${(event) => setStart(event.target.value)}
          />
        </label>
        <label style="display:flex;gap:6px;align-items:center">
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
        ${
          schedule.window
            ? html`<${Pill} online=${schedule.active} warn=${!schedule.active}>
                ${
                  schedule.active
                    ? "● Window open — downloading allowed"
                    : "◌ Window closed — queue waits"
                }
              <//>`
            : html`<${Pill} online>● No window — downloads run anytime<//>`
        }
      </div>
    </div>
  `;
}

function jobLabel(job, entries) {
  const entry = entries.find((candidate) => candidate.id === job.entryId);
  return entry?.name ?? job.entryId;
}

function Jobs({ entries }) {
  const report = usePoll("disk-jobs", 3000);
  const jobs = report?.jobs ?? [];
  return html`
    <div class="panel" style="margin-top:18px">
      <h2>Archive queue</h2>
      ${
        jobs.length === 0
          ? html`<p class="muted">Nothing copying right now.</p>`
          : html`<div class="metrics">
              ${jobs.map((job) => {
                const percent = job.file?.length
                  ? Math.min(
                      100,
                      Math.round((job.file.received / job.file.length) * 100),
                    )
                  : 0;
                return html`
                  <div class="metric">
                    <span
                      class=${job.status === "copying" ? "online" : "muted"}
                    >
                      ${
                        job.status === "copying"
                          ? "● Copying " + percent + "%"
                          : job.status === "queued"
                            ? "○ Queued"
                            : "◌ " + (job.reason || "Waiting")
                      }
                    </span>
                    <strong>${jobLabel(job, entries)}</strong>
                    ${
                      job.file
                        ? html`<span class="muted">
                            ${fmt(job.file.received)} of ${fmt(job.file.length)}
                          </span>`
                        : null
                    }
                  </div>
                `;
              })}
            </div>`
      }
    </div>
  `;
}

export function StorageView() {
  const { entries } = useStore();
  const stored = entries.filter((entry) => entry.diskCopy?.desired === "keep");
  return html`
    <${Shell} title="Storage">
      <p class="muted">
        Keep entries playable from disk — streamed from the drive when it is
        connected, from the torrent when it is not.
      </p>
      <${Volumes} entries=${entries} />
      <${Schedule} />
      <${Jobs} entries=${entries} />
      <div class="panel" style="margin-top:18px">
        <h2>Entries kept on disk</h2>
        ${
          stored.length === 0
            ? html`<p class="muted">
                None yet — open an entry and switch on “Keep on disk” in its
                Storage tab.
              </p>`
            : html`<div class="metrics">
                ${stored.map((entry) => {
                  const files = entry.diskCopy.files.filter(
                    (file) => file.included,
                  );
                  const complete = files.filter(
                    (file) => file.state === "complete",
                  ).length;
                  return html`
                    <div
                      class="metric"
                      style="cursor:pointer"
                      onClick=${() =>
                        setState({ selected: entry, tab: "storage" })}
                    >
                      <span
                        class=${complete === files.length ? "online" : "muted"}
                      >
                        ${
                          complete === files.length
                            ? "● On disk"
                            : "◌ " + complete + " of " + files.length + " files"
                        }
                      </span>
                      <strong>${entry.name}</strong>
                      <span class="muted">
                        ${fmt(
                          files.reduce((sum, file) => sum + file.length, 0),
                        )}
                      </span>
                    </div>
                  `;
                })}
              </div>`
        }
      </div>
    <//>
  `;
}
