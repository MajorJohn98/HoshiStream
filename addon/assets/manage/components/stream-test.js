// Pre-add stream test card (decision 0029). Before the owner saves a torrent,
// it measures how fast the file plays, how fast its peers deliver it here and
// which limit is to blame. The verdict is advice only; Save never waits for
// it. Unmounting the card ends its test, so closing the Add sheet, changing
// the source and saving all clean up after it.
import { html, useEffect, useRef, useState } from "../vendor/preact-htm.js";
import { api } from "../api.js";
import { createRequestGate, sourceHints } from "../import-state.js";
import {
  isStreamTestActive,
  mbpsLabel,
  streamTestBadge,
  streamTestFigures,
  streamTestFileLabel,
  streamTestNotes,
  streamTestProgress,
  streamTestRemedies,
  streamTestRows,
  streamTestSummary,
} from "./stream-test-text.js";

export * from "./stream-test-text.js";

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
