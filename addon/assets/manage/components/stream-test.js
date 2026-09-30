// Pre-add stream test card (decision 0029). Before the owner saves a torrent,
// it measures how fast the file plays, how fast its peers deliver it here and
// which limit is to blame. The verdict is advice only; Save never waits for
// it. Unmounting the card ends its test, so closing the Add sheet, changing
// the source and saving all clean up after it.
import { html, useEffect, useRef, useState } from "../vendor/preact-htm.js";
import { api, fmt } from "../api.js";
import { createRequestGate, sourceHints } from "../import-state.js";

export const ACTIVE_STREAM_TEST_PHASES = new Set([
  "queued",
  "metadata",
  "measuring",
]);

export function isStreamTestActive(test) {
  return ACTIVE_STREAM_TEST_PHASES.has(test?.phase);
}

const ACTIVE_BADGES = {
  queued: { tone: "warn", label: "Queued" },
  metadata: { tone: "warn", label: "Finding peers" },
  measuring: { tone: "warn", label: "Measuring" },
};

const VERDICT_BADGES = {
  smooth: { tone: "ok", label: "Smooth" },
  tight: { tone: "warn", label: "Tight" },
  too_slow: { tone: "bad", label: "Won't keep up" },
  inconclusive: { tone: "idle", label: "Inconclusive" },
};

export function streamTestBadge(test) {
  if (!test) return { tone: "idle", label: "Not tested" };
  if (isStreamTestActive(test)) return ACTIVE_BADGES[test.phase];
  const verdict = VERDICT_BADGES[test.verdict?.level];
  if (verdict) return verdict;
  if (test.phase === "failed") return { tone: "bad", label: "Test failed" };
  if (test.phase === "cancelled") return { tone: "idle", label: "Cancelled" };
  return { tone: "idle", label: "Finished" };
}

export function mbpsLabel(value) {
  const rounded =
    value >= 100 ? Math.round(value) : Math.round(value * 10) / 10;
  return rounded + " Mbps";
}

export function durationLabel(seconds) {
  const minutes = Math.max(1, Math.round(seconds / 60));
  if (minutes < 60) return minutes + " min";
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest ? `${hours} h ${rest} min` : `${hours} h`;
}

const INCONCLUSIVE = {
  no_metadata: "Inconclusive: no peers sent the torrent's file list in time.",
  no_peers: "Inconclusive: no peers sent any data.",
  few_samples: "Inconclusive: the test ended before it had enough readings.",
  unknown_bitrate:
    "Inconclusive: the file's bitrate couldn't be read. Compare the figures below.",
  stream_started: "Inconclusive: playback started, so the test stopped early.",
};

const BOTTLENECKS = {
  swarm: "The swarm is the limit.",
  line: "Your line is the limit.",
  limit: "TorrServer's download limit is the limit.",
};

export function streamTestSummary(test) {
  if (!test)
    return "Checks whether this torrent downloads faster than it plays, before you save it. The test contacts peers and takes up to 90 seconds.";
  if (isStreamTestActive(test)) return test.message || "Testing…";
  const verdict = test.verdict;
  if (!verdict) return test.message;
  if (verdict.level === "inconclusive")
    return INCONCLUSIVE[verdict.reason] ?? "Inconclusive.";
  if (verdict.level === "smooth")
    return "Should play smoothly: peers deliver it faster than it plays.";
  const lead =
    verdict.level === "tight"
      ? "Tight: it plays, with little room for slow peers or busy scenes."
      : "Won't keep up.";
  const limit = BOTTLENECKS[verdict.bottleneck];
  return limit ? lead + " " + limit : lead;
}

function peersLabel(peers) {
  return peers === undefined
    ? ""
    : ` (${peers} ${peers === 1 ? "peer" : "peers"})`;
}

/** One line of the figures behind the verdict, e.g. "Needs 9.8 Mbps · …". */
export function streamTestFigures(test) {
  if (!test || isStreamTestActive(test)) return "";
  const parts = [];
  if (test.bitrate) parts.push("needs " + mbpsLabel(test.bitrate.mbps));
  const swarm = test.swarm;
  if (swarm?.sustainedMbps !== undefined)
    parts.push(
      "peers deliver " +
        (swarm.atLeast ? "at least " : "") +
        mbpsLabel(swarm.sustainedMbps) +
        peersLabel(swarm.peers),
    );
  else if (swarm?.peakMbps !== undefined)
    parts.push(
      "peers peaked at " + mbpsLabel(swarm.peakMbps) + peersLabel(swarm.peers),
    );
  if (test.line) parts.push("your line " + mbpsLabel(test.line.mbps));
  if (test.limitMbps)
    parts.push("TorrServer limit " + mbpsLabel(test.limitMbps));
  const text = parts.join(" · ");
  return text && text[0].toUpperCase() + text.slice(1);
}

/** Live figures while a test runs. */
export function streamTestProgress(test) {
  if (!isStreamTestActive(test) || test.phase === "queued") return "";
  const parts = [`${test.elapsedSeconds} s of up to ${test.budgetSeconds} s`];
  const progress = test.progress;
  if (progress?.downloadMbps !== undefined)
    parts.push(mbpsLabel(progress.downloadMbps) + " now");
  if (progress?.peers !== undefined)
    parts.push(
      `${progress.peers} ${progress.peers === 1 ? "peer" : "peers"}` +
        (progress.seeders ? `, ${progress.seeders} seeding` : ""),
    );
  if (progress?.bytes) parts.push(fmt(progress.bytes) + " downloaded");
  if (test.bitrate) parts.push("needs " + mbpsLabel(test.bitrate.mbps));
  return parts.join(" · ");
}

/** What the owner can do when the file won't keep up, or only just does. */
export function streamTestRemedies(test) {
  const remedies = test?.verdict?.remedies;
  if (!remedies) return [];
  const list = [
    remedies.fitsCache === false
      ? `Pausing to buffer won't help: it needs ${fmt(remedies.bufferBytes)}, more than TorrServer's ${fmt(test.cacheWindowBytes)} read-ahead cache.`
      : `Start it, then pause about ${durationLabel(remedies.waitSeconds)} to buffer (${fmt(remedies.bufferBytes)}${remedies.fitsCache ? "; fits the cache" : ""}).`,
  ];
  if (remedies.copySeconds !== undefined)
    list.push(
      `Save it, then make a disk copy before watching (about ${durationLabel(remedies.copySeconds)}).`,
    );
  if (remedies.targetMbps !== undefined)
    list.push(
      `Pick a release of ${mbpsLabel(remedies.targetMbps)} or less` +
        (remedies.targetBytes
          ? ` (about ${fmt(remedies.targetBytes)} for this runtime).`
          : "."),
    );
  if (remedies.betterSeeded) list.push("Pick a release with more seeders.");
  return list;
}

/** Caveats about how firm the measurement is. */
export function streamTestNotes(test) {
  const verdict = test?.verdict;
  if (!verdict || isStreamTestActive(test)) return [];
  const notes = [];
  if (test.stoppedBy === "complete")
    notes.push("The whole file arrived during the test.");
  if (verdict.flags?.atLeast)
    notes.push(
      "The test reached its data limit early, so peers may deliver faster than shown.",
    );
  if (verdict.flags?.stillSpeedingUp)
    notes.push("Still speeding up: more peers were joining as the test ended.");
  if (verdict.flags?.sharedWithDiskCopy)
    notes.push(
      "A disk copy was downloading during the test and shared your line.",
    );
  if (verdict.lineStale)
    notes.push(
      "Peers delivered faster than your last line reading. Measure the line to update it.",
    );
  if (verdict.suggestTestLonger) notes.push("Test longer for a firmer result.");
  return notes;
}

function agoLabel(iso, now) {
  const time = Date.parse(iso);
  if (!Number.isFinite(time)) return "at an unknown time";
  const minutes = Math.max(0, Math.round((now - time) / 6e4));
  if (minutes < 1) return "just now";
  if (minutes < 60) return minutes + " min ago";
  const hours = Math.round(minutes / 60);
  return hours < 24 ? hours + " h ago" : Math.round(hours / 24) + " days ago";
}

function episodeLabel(file) {
  if (file.season === undefined || file.episode === undefined) return "";
  const pad = (value) => String(value).padStart(2, "0");
  return `S${pad(file.season)}E${pad(file.episode)} · `;
}

export function streamTestFileLabel(file) {
  return (
    episodeLabel(file) + file.name.split("/").pop() + " · " + fmt(file.size)
  );
}

export function streamTestRows(test, now = Date.now()) {
  if (!test) return [];
  const { file, swarm, line } = test;
  const finished = !isStreamTestActive(test);
  return [
    file ? ["File", episodeLabel(file) + file.name] : null,
    file ? ["File size", fmt(file.size)] : null,
    test.bitrate ? ["Average bitrate", mbpsLabel(test.bitrate.mbps)] : null,
    test.bitrate?.durationSeconds
      ? ["Duration", durationLabel(test.bitrate.durationSeconds)]
      : null,
    swarm?.sustainedMbps !== undefined
      ? [
          "Sustained swarm rate",
          (swarm.atLeast ? "At least " : "") + mbpsLabel(swarm.sustainedMbps),
        ]
      : null,
    // What peers sent, overhead and out-of-order pieces included; a limit or
    // line caps this, not the in-order rate above.
    swarm?.downloadMbps !== undefined &&
    swarm.downloadMbps !== swarm.sustainedMbps
      ? ["TorrServer download rate", mbpsLabel(swarm.downloadMbps)]
      : null,
    swarm?.peakMbps !== undefined
      ? ["Peak swarm rate", mbpsLabel(swarm.peakMbps)]
      : null,
    swarm?.peers !== undefined
      ? ["Peers", `${swarm.peers} connected · ${swarm.seeders ?? 0} seeding`]
      : null,
    line
      ? [
          "Your line",
          mbpsLabel(line.mbps) +
            (line.source === "measured"
              ? " · measured " + agoLabel(line.measuredAt, now)
              : " · configured, not yet measured"),
        ]
      : null,
    test.limitMbps
      ? ["TorrServer download limit", mbpsLabel(test.limitMbps)]
      : null,
    test.cacheWindowBytes
      ? ["Read-ahead cache", fmt(test.cacheWindowBytes)]
      : null,
    swarm?.bytes ? ["Downloaded during the test", fmt(swarm.bytes)] : null,
    finished && test.phase === "done"
      ? [
          "Test length",
          `${test.elapsedSeconds} s of up to ${test.budgetSeconds} s` +
            (test.mode === "extended" ? " · longer test" : ""),
        ]
      : null,
  ].filter(Boolean);
}

export function magnetTestSource(value) {
  const magnetUri = String(value ?? "").trim();
  if (!magnetUri) throw Error("Paste a magnet link to test.");
  // The API accepts only this prefix and would answer "Invalid request".
  if (!magnetUri.startsWith("magnet:?"))
    throw Error("A magnet link starts with magnet:? — check the pasted link.");
  return { magnetUri };
}

/**
 * The type and numbering a test shares with Save, read from the form's
 * fields. Invalid numbering throws before anything is uploaded.
 */
export function streamTestFields(snapshot) {
  const type = snapshot.type === "series" ? "series" : "movie";
  return {
    type,
    ...(type === "series"
      ? sourceHints(snapshot.seasonHint, snapshot.episodeHint)
      : {}),
  };
}

export function streamTestRequest(base, { mode = "basic", fileId } = {}) {
  return { ...base, ...(fileId === undefined ? {} : { fileId }), mode };
}

/** Ends a test and forgets it; errors are ignored because it may be gone. */
export function releaseStreamTest(
  testId,
  { keepalive = false, request = api } = {},
) {
  if (!testId) return Promise.resolve();
  return request("stream-tests/" + encodeURIComponent(testId), {
    method: "DELETE",
    keepalive,
    signal: AbortSignal.timeout(10000),
  }).then(
    () => undefined,
    () => undefined,
  );
}

export function createStreamTestController(
  load,
  publish,
  {
    schedule = (callback, delay) => setTimeout(callback, delay),
    clear = (handle) => clearTimeout(handle),
    delayMs = 2000,
    onError = () =>
      console.warn(JSON.stringify({ event: "stream_test_poll_failed" })),
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
    if (stopped || !isStreamTestActive(current)) return;
    const testId = current.testId;
    timer = schedule(
      async () => {
        timer = null;
        if (stopped) return;
        const request = gate.start();
        try {
          const next = await load(testId, request.signal);
          if (!request.isCurrent()) return;
          failures = 0;
          current = next;
          publish(next);
          queue();
        } catch (error) {
          if (!request.isCurrent()) return;
          failures++;
          onError(error);
          // A 404 means the test is gone: it expired or the server restarted.
          if (failures < 3 && error?.status !== 404) queue();
        }
      },
      Math.min(15000, delayMs * 2 ** failures),
    );
  };
  return {
    update(test) {
      // A poll for an earlier test must not overwrite this one.
      gate.cancel();
      stopped = false;
      current = test;
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

// Form fields that change what a test measures. Editing one after a test
// marks its result as out of date.
const TESTED_FIELDS = new Set([
  "magnetUri",
  "torrent",
  "type",
  "seasonHint",
  "episodeHint",
]);

/**
 * `prepare(form)` returns the request fields for the form's current source:
 * `{source, type, seasonHint?, episodeHint?}`. For a .torrent it uploads the
 * file, and Save then reuses that upload.
 */
export function StreamTestPanel({ prepare }) {
  const [test, setTest] = useState(null);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [pollError, setPollError] = useState("");
  const [note, setNote] = useState("");
  const [stale, setStale] = useState(false);
  const [fileChoice, setFileChoice] = useState("");
  const root = useRef(null);
  const testRef = useRef(null);
  const baseRef = useRef(null);
  const controller = useRef(null);
  const alive = useRef(false);

  const show = (next) => {
    testRef.current = next;
    setTest(next);
  };
  const forget = () => {
    controller.current?.stop();
    testRef.current = null;
    baseRef.current = null;
    setTest(null);
    setStale(false);
    setPollError("");
  };

  useEffect(() => {
    alive.current = true;
    controller.current = createStreamTestController(
      (testId, signal) =>
        api("stream-tests/" + encodeURIComponent(testId), {
          signal: AbortSignal.any([signal, AbortSignal.timeout(5000)]),
        }),
      (next) => {
        if (!alive.current || next.testId !== testRef.current?.testId) return;
        setPollError("");
        show(next);
      },
      {
        onError: (failure) => {
          if (!alive.current) return;
          if (failure.status === 404) {
            forget();
            setError(failure.message);
          } else setPollError("Test status is unavailable: " + failure.message);
        },
      },
    );
    const form = root.current?.closest("form");
    const onEdit = (event) => {
      if (testRef.current && TESTED_FIELDS.has(event.target?.name))
        setStale(true);
    };
    // File inputs and selects report a choice through "change".
    form?.addEventListener("input", onEdit);
    form?.addEventListener("change", onEdit);
    // Closing the tab doesn't unmount the card; end the test anyway.
    const onHide = () =>
      void releaseStreamTest(testRef.current?.testId, { keepalive: true });
    addEventListener("pagehide", onHide);
    return () => {
      alive.current = false;
      form?.removeEventListener("input", onEdit);
      form?.removeEventListener("change", onEdit);
      removeEventListener("pagehide", onHide);
      controller.current?.stop();
      void releaseStreamTest(testRef.current?.testId);
      testRef.current = null;
    };
  }, []);

  const start = async (
    event,
    { mode = "basic", fileId, reuse = false } = {},
  ) => {
    const form = event.currentTarget.form;
    const previous = testRef.current;
    setBusy("starting");
    setError("");
    setPollError("");
    setNote("");
    try {
      const base =
        reuse && baseRef.current ? baseRef.current : await prepare(form);
      if (!alive.current) return;
      const next = await api("stream-tests", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(streamTestRequest(base, { mode, fileId })),
        signal: AbortSignal.timeout(10000),
      });
      if (!alive.current) return void releaseStreamTest(next.testId);
      baseRef.current = base;
      if (!reuse) setStale(false);
      setFileChoice("");
      show(next);
      controller.current.update(next);
      // Ended only now, so the torrent stays registered for the new test.
      if (previous) void releaseStreamTest(previous.testId);
    } catch (failure) {
      if (alive.current) setError(failure.message);
    } finally {
      if (alive.current) setBusy("");
    }
  };

  const cancel = async () => {
    const current = testRef.current;
    if (!current) return;
    setBusy("cancelling");
    setError("");
    setPollError("");
    controller.current.stop();
    try {
      await api("stream-tests/" + encodeURIComponent(current.testId), {
        method: "DELETE",
        signal: AbortSignal.timeout(10000),
      });
      if (!alive.current) return;
      forget();
      setNote("Test cancelled.");
    } catch (failure) {
      if (!alive.current) return;
      if (failure.status === 404) forget();
      else controller.current.update(current);
      setError(failure.message);
    } finally {
      if (alive.current) setBusy("");
    }
  };

  const refresh = () => {
    setPollError("");
    if (testRef.current) controller.current.update(testRef.current);
  };

  const measureLine = async () => {
    setBusy("line");
    setError("");
    setNote("");
    try {
      const result = await api("speedtest", { method: "POST" });
      if (alive.current)
        setNote(
          `Your line measured ${mbpsLabel(result.mbps)}. Test again to use the new reading.`,
        );
    } catch (failure) {
      if (alive.current) setError(failure.message);
    } finally {
      if (alive.current) setBusy("");
    }
  };

  const active = isStreamTestActive(test);
  const badge = streamTestBadge(test);
  const figures = streamTestFigures(test);
  const progress = streamTestProgress(test);
  const remedies = streamTestRemedies(test);
  const notes = streamTestNotes(test);
  const rows = streamTestRows(test);
  const files = !active && test?.phase === "done" ? (test.files ?? []) : [];
  const chosen = fileChoice || String(test?.file?.id ?? "");
  const waiting = Boolean(busy);

  return html`
    <div class="span2 stream-test" ref=${root}>
      <div class="stream-test-head">
        <span class="field-label">Stream test</span>
        <span class="status ${badge.tone}">
          <i class="dot ${badge.tone}"></i>${badge.label}
        </span>
      </div>
      <p class="muted stream-test-summary" role="status" aria-live="polite">
        ${streamTestSummary(test)}
      </p>
      ${progress ? html`<p class="inline-note stacked-xs">${progress}</p>` : null}
      ${figures ? html`<p class="stacked-xs">${figures}</p>` : null}
      ${
        remedies.length
          ? html`<ul class="muted stacked-xs" aria-label="Options">
              ${remedies.map((remedy) => html`<li key=${remedy}>${remedy}</li>`)}
            </ul>`
          : null
      }
      ${
        stale && test
          ? html`<p class="inline-note stacked-xs">
              The source or its numbering changed after this test. Test again to
              check the new one.
            </p>`
          : null
      }
      ${notes.map(
        (text) =>
          html`<p class="inline-note stacked-xs" key=${text}>${text}</p>`,
      )}
      ${note ? html`<p class="inline-note stacked-xs">${note}</p>` : null}
      ${
        error || pollError
          ? html`<p class="danger stacked-xs" role="alert">
              ${error || pollError}
            </p>`
          : null
      }
      ${
        rows.length && !active
          ? html`<details class="more-details">
              <summary>Test details</summary>
              <dl class="kv stacked-xs">
                ${rows.map(
                  ([label, value]) => html`
                    <div key=${label}>
                      <dt>${label}</dt>
                      <dd>${value}</dd>
                    </div>
                  `,
                )}
              </dl>
            </details>`
          : null
      }
      <div class="actions stacked-sm">
        ${
          active
            ? html`<button
                type="button"
                class="secondary"
                disabled=${waiting}
                onClick=${cancel}
              >
                ${busy === "cancelling" ? "Cancelling…" : "Cancel test"}
              </button>`
            : html`<button
                type="button"
                class="secondary"
                disabled=${waiting}
                onClick=${(event) => start(event)}
              >
                ${
                  busy === "starting"
                    ? "Starting…"
                    : test
                      ? "Test again"
                      : "Test streaming"
                }
              </button>`
        }
        ${
          test && !active
            ? html`<button
                type="button"
                class="secondary"
                disabled=${waiting}
                onClick=${(event) =>
                  start(event, {
                    mode: "extended",
                    fileId: test.file?.id,
                    reuse: true,
                  })}
              >
                Test longer (up to 3 min)
              </button>`
            : null
        }
        ${
          test?.verdict?.lineStale && !active
            ? html`<button
                type="button"
                class="secondary"
                disabled=${waiting}
                onClick=${measureLine}
              >
                ${busy === "line" ? "Measuring line…" : "Measure line"}
              </button>`
            : null
        }
        ${
          pollError && active
            ? html`<button
                type="button"
                class="secondary"
                disabled=${waiting}
                onClick=${refresh}
              >
                Refresh status
              </button>`
            : null
        }
      </div>
      ${
        files.length > 1
          ? html`<div class="picker-row stacked-sm">
              <select
                aria-label="File to test"
                value=${chosen}
                disabled=${waiting}
                onChange=${(event) => setFileChoice(event.target.value)}
              >
                ${files.map(
                  (file) =>
                    html`<option key=${file.id} value=${String(file.id)}>
                      ${streamTestFileLabel(file)}
                    </option>`,
                )}
              </select>
              <button
                type="button"
                class="secondary"
                disabled=${waiting || chosen === String(test.file?.id ?? "")}
                onClick=${(event) =>
                  start(event, { fileId: Number(chosen), reuse: true })}
              >
                Test this file
              </button>
            </div>`
          : null
      }
    </div>
  `;
}
