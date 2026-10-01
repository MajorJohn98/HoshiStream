import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createCheckPoller } from "../assets/chrome-extension/lib/checks.js";
import {
  PANEL_STATE_KEY,
  PANEL_UPDATE_MESSAGE,
} from "../assets/chrome-extension/lib/constants.js";
import {
  applyCommitSuccess,
  applyDraftResult,
  applyStreamTestReport,
  applyStreamTestStarted,
  buildStreamTestRequest,
  clearStreamTest,
  createInitialState,
  markStreamTestPending,
  recoverState,
  reviewToken,
  selectSource,
  settleStreamTest,
  streamTestBlocker,
  streamTestFields,
  streamTestStale,
} from "../assets/chrome-extension/lib/state.js";
import { isStreamTestActive } from "../assets/chrome-extension/lib/stream-test-text.js";

type PanelState = ReturnType<typeof createInitialState>;
type NativeCall = { command: string; payload: Record<string, unknown> };
type Reply = {
  ok: boolean;
  state: PanelState;
  error?: { code: string; message: string };
};
type Listener = (
  message: unknown,
  sender: unknown,
  respond: (reply: Reply) => void,
) => unknown;

const ORIGIN = "chrome-extension://haijooeeommbnonlnkmcihmcgjmbfjgo/";
const BLANK = {
  status: "idle",
  test: null,
  fields: null,
  note: "",
  message: "",
  code: "",
};

afterEach(() => {
  delete (globalThis as { chrome?: unknown }).chrome;
  vi.restoreAllMocks();
});

function readyState(): PanelState {
  const state = createInitialState();
  state.source = {
    kind: "magnet",
    magnetUri: "magnet:?xt=urn:btih:abc123&dn=Fixture",
    titleSuggestion: "Fixture",
    captureLabel: "Fixture",
  };
  state.draft = {
    status: "ready",
    draftId: randomUUID(),
    expiresAt: new Date(Date.now() + 600_000).toISOString(),
    hash: "a".repeat(40),
    suggestedName: "Fixture",
    existingEntries: [],
    message: "",
    code: "",
  };
  state.form.name = "Fixture";
  return state;
}

function report(testId: string, phase = "queued", fields = {}) {
  return {
    testId,
    phase,
    message: phase === "done" ? "Test finished." : "Waiting for its turn…",
    mode: "basic",
    elapsedSeconds: 0,
    budgetSeconds: 90,
    expiresAt: new Date(Date.now() + 600_000).toISOString(),
    ...fields,
  };
}

function withTest(
  state: PanelState,
  phase: string,
  fields: Record<string, unknown> = { type: "movie" },
): PanelState {
  return {
    ...state,
    streamTest: {
      ...state.streamTest,
      status: "ready",
      test: report(randomUUID(), phase),
      fields,
    },
  };
}

function errorOf(action: () => unknown) {
  try {
    action();
  } catch (error) {
    return error;
  }
  throw new Error("Expected an error.");
}

function failure(code: string, message: string) {
  return Object.assign(new Error(message), { code });
}

/** A fake native port that answers each request with `native`'s result. */
function nativePort(
  native: (call: NativeCall) => unknown,
  calls: NativeCall[],
) {
  const listeners = new Set<(response: unknown) => void>();
  const ignored = { addListener() {}, removeListener() {} };
  return {
    onMessage: {
      addListener: (listener: (response: unknown) => void) =>
        listeners.add(listener),
      removeListener: (listener: (response: unknown) => void) =>
        listeners.delete(listener),
    },
    onDisconnect: ignored,
    disconnect() {},
    postMessage(request: NativeCall & { id: string }) {
      const call = { command: request.command, payload: request.payload };
      calls.push(call);
      void (async () => {
        let response: Record<string, unknown>;
        try {
          const data = await native(call);
          response = { version: 1, id: request.id, ok: true, data };
        } catch (error) {
          const { code, message } = error as { code: string; message: string };
          response = {
            version: 1,
            id: request.id,
            ok: false,
            error: { code, message },
          };
        }
        for (const listener of [...listeners]) listener(response);
      })();
    },
  };
}

/** Loads the real service worker against a fake `chrome` seeded with `seed`. */
async function companion(
  seed: PanelState,
  native: (call: NativeCall, stored: PanelState) => unknown = () => ({}),
) {
  const session = new Map<string, unknown>([
    [PANEL_STATE_KEY, structuredClone(seed)],
  ]);
  const local = new Map<string, unknown>();
  const area = (map: Map<string, unknown>) => ({
    get: async (key: string) =>
      map.has(key) ? { [key]: structuredClone(map.get(key)) } : {},
    set: async (values: Record<string, unknown>) => {
      for (const [key, value] of Object.entries(values))
        map.set(key, structuredClone(value));
    },
  });
  const stored = () => session.get(PANEL_STATE_KEY) as PanelState;
  const calls: NativeCall[] = [];
  const broadcasts: unknown[] = [];
  const ignored = { addListener() {} };
  let listener: Listener | undefined;
  (globalThis as { chrome?: unknown }).chrome = {
    runtime: {
      getURL: (path: string) => ORIGIN + path,
      onInstalled: ignored,
      onMessage: {
        addListener: (value: Listener) => {
          listener = value;
        },
      },
      sendMessage: async (message: unknown) => {
        broadcasts.push(message);
      },
      connectNative: () => nativePort((call) => native(call, stored()), calls),
    },
    storage: { session: area(session), local: area(local) },
    action: { onClicked: ignored },
    contextMenus: { onClicked: ignored },
  };
  vi.resetModules();
  await import("../assets/chrome-extension/service-worker.js");
  return {
    calls,
    broadcasts,
    stored,
    send: (type: string, payload?: unknown) =>
      new Promise<Reply>((resolve) => {
        listener!({ type, payload }, { url: ORIGIN + "panel.html" }, resolve);
      }),
  };
}

describe("companion stream test state", () => {
  it("starts blank and resets whenever the source, draft or save changes", () => {
    expect(createInitialState().streamTest).toEqual(BLANK);
    const tested = withTest(readyState(), "done");
    expect(
      selectSource(tested, {
        kind: "magnet",
        magnetUri: "magnet:?xt=urn:btih:def456&dn=Other",
        titleSuggestion: "Other",
        captureLabel: "Other",
      }).streamTest,
    ).toEqual(BLANK);
    expect(
      applyDraftResult(tested, {
        draftId: randomUUID(),
        expiresAt: new Date(Date.now() + 600_000).toISOString(),
        hash: "b".repeat(40),
        suggestedName: "Other",
        existingEntries: [],
      }).streamTest,
    ).toEqual(BLANK);
    expect(
      applyCommitSuccess(tested, {
        outcome: "created",
        entry: { id: "hoshi:fixture", name: "Fixture", type: "movie" },
      }).streamTest,
    ).toEqual(BLANK);
  });

  it("runs with the form's type and numbering and refuses bad hints", () => {
    const state = readyState();
    state.form.seasonHint = "2";
    expect(streamTestFields(state)).toEqual({ type: "movie" });
    state.form.type = "series";
    expect(streamTestFields(state)).toEqual({ type: "series", seasonHint: 2 });
    state.form.seasonHint = "0";
    state.form.episodeHint = "12";
    expect(streamTestFields(state)).toEqual({
      type: "series",
      seasonHint: 0,
      episodeHint: 12,
    });
    state.form.episodeHint = "0";
    expect(errorOf(() => streamTestFields(state))).toMatchObject({
      code: "invalid_episode_hint",
    });
    state.form.episodeHint = "";
    state.form.seasonHint = "-1";
    expect(errorOf(() => streamTestFields(state))).toMatchObject({
      code: "invalid_season_hint",
    });
  });

  it("explains why the draft can't be tested yet", () => {
    const state = readyState();
    const now = Date.now();
    expect(streamTestBlocker(state, now)).toBe("");
    expect(
      streamTestBlocker(
        { ...state, draft: { ...state.draft, status: "preparing" } },
        now,
      ),
    ).toBe("Wait for the source to finish preparing.");
    expect(
      streamTestBlocker(
        { ...state, draft: { ...state.draft, status: "leased", draftId: "" } },
        now,
      ),
    ).toBe(
      "The series preview holds this draft. To test it, cancel the preview and prepare the source again.",
    );
    expect(
      streamTestBlocker(state, Date.parse(state.draft.expiresAt) + 1),
    ).toBe("Prepare the source again to test it.");
    expect(streamTestBlocker(createInitialState(), now)).toBe(
      "Prepare the source again to test it.",
    );
  });

  it("builds the request from the form, or reuses the shown test's numbering", () => {
    const state = readyState();
    state.form.type = "series";
    state.form.episodeHint = "4";
    const { draftId } = state.draft;
    expect(buildStreamTestRequest(state)).toEqual({
      payload: { draftId, type: "series", episodeHint: 4, mode: "basic" },
      fields: { type: "series", episodeHint: 4 },
    });
    const tested = withTest(state, "done", {
      type: "series",
      seasonHint: 1,
      episodeHint: 2,
    });
    expect(
      buildStreamTestRequest(tested, {
        mode: "extended",
        fileId: 0,
        reuse: true,
      }).payload,
    ).toEqual({
      draftId,
      type: "series",
      seasonHint: 1,
      episodeHint: 2,
      fileId: 0,
      mode: "extended",
    });
    expect(
      buildStreamTestRequest(tested, { mode: "extended" }).payload,
    ).toEqual({ draftId, type: "series", episodeHint: 4, mode: "extended" });
    for (const [options, code] of [
      [{ mode: "turbo" }, "invalid_mode"],
      [{ fileId: -1 }, "invalid_file"],
      [{ fileId: 1.5 }, "invalid_file"],
    ] as const)
      expect(
        errorOf(() => buildStreamTestRequest(state, options)),
      ).toMatchObject({ code });
    const expired = {
      ...state,
      draft: { ...state.draft, expiresAt: new Date(0).toISOString() },
    };
    expect(errorOf(() => buildStreamTestRequest(expired))).toMatchObject({
      code: "draft_expired",
    });
    const leased = { ...state, draft: { ...state.draft, status: "leased" } };
    expect(errorOf(() => buildStreamTestRequest(leased))).toMatchObject({
      code: "draft_missing",
    });
  });

  it("dates a result once the type or numbering changes", () => {
    expect(streamTestStale(readyState())).toBe(false);
    const movie = withTest(readyState(), "done");
    expect(streamTestStale(movie)).toBe(false);
    movie.form.type = "series";
    expect(streamTestStale(movie)).toBe(true);
    const series = withTest(readyState(), "done", {
      type: "series",
      episodeHint: 2,
    });
    series.form.type = "series";
    series.form.episodeHint = "2";
    expect(streamTestStale(series)).toBe(false);
    series.form.episodeHint = "3";
    expect(streamTestStale(series)).toBe(true);
    series.form.episodeHint = "two";
    expect(streamTestStale(series)).toBe(true);
  });

  it("applies reports of the shown test only and settles pending actions", () => {
    const state = withTest(readyState(), "queued");
    const testId = state.streamTest.test!.testId;
    const measuring = report(testId, "measuring");
    expect(applyStreamTestReport(state, measuring).streamTest.test).toEqual(
      measuring,
    );
    expect(applyStreamTestReport(state, report(randomUUID(), "done"))).toBe(
      state,
    );
    const pending = markStreamTestPending(
      {
        ...state,
        streamTest: { ...state.streamTest, message: "Old", code: "old" },
      },
      "cancelling",
    );
    expect(pending.streamTest).toMatchObject({
      status: "cancelling",
      test: { testId },
      message: "",
      code: "",
    });
    expect(settleStreamTest(pending).streamTest).toMatchObject({
      status: "ready",
      test: { testId },
    });
    expect(
      settleStreamTest(pending, new Error("Offline")).streamTest,
    ).toMatchObject({
      status: "ready",
      message: "Offline",
      code: "request_failed",
    });
    expect(
      settleStreamTest(markStreamTestPending(readyState(), "starting"))
        .streamTest.status,
    ).toBe("idle");
    expect(
      applyStreamTestStarted(pending, measuring, { type: "movie" }).streamTest,
    ).toEqual({
      ...BLANK,
      status: "ready",
      test: measuring,
      fields: { type: "movie" },
    });
    expect(
      clearStreamTest(state, { note: "Test cancelled." }).streamTest,
    ).toEqual({ ...BLANK, note: "Test cancelled." });
  });

  it("recovers a section left mid-action or missing from older saved state", () => {
    const older: Partial<PanelState> = readyState();
    delete older.streamTest;
    expect(recoverState(older).streamTest).toEqual(BLANK);
    expect(
      recoverState({ ...readyState(), streamTest: { status: "bogus" } })
        .streamTest,
    ).toEqual(BLANK);
    expect(
      recoverState(markStreamTestPending(readyState(), "starting")).streamTest,
    ).toEqual({
      ...BLANK,
      code: "stream_test_interrupted",
      message: "Starting the stream test was interrupted. Test again.",
    });
    expect(
      recoverState(
        markStreamTestPending(withTest(readyState(), "done"), "starting"),
      ).streamTest,
    ).toMatchObject({
      status: "ready",
      test: { phase: "done" },
      code: "stream_test_interrupted",
    });
    expect(
      recoverState(
        markStreamTestPending(
          withTest(readyState(), "measuring"),
          "cancelling",
        ),
      ).streamTest,
    ).toMatchObject({
      status: "ready",
      test: { phase: "measuring" },
      code: "",
    });
  });
});

describe("companion stream test polling", () => {
  it("polls while queued, finding peers or measuring, and stops at a result", async () => {
    const callbacks: Array<() => Promise<void>> = [];
    const delays: number[] = [];
    const testId = randomUUID();
    const load = vi
      .fn()
      .mockResolvedValueOnce(report(testId, "metadata"))
      .mockResolvedValueOnce(report(testId, "measuring"))
      .mockResolvedValueOnce(report(testId, "done"));
    const publish = vi.fn();
    const schedule = (callback: () => Promise<void>, delay: number) => {
      callbacks.push(callback);
      delays.push(delay);
      return callback;
    };
    // The phase sets differ: a source check's default would stop at once.
    expect(isStreamTestActive({ phase: "probing" })).toBe(false);
    const checks = createCheckPoller(load, publish, { schedule, clear() {} });
    checks.update(report(testId, "measuring"));
    expect(callbacks).toHaveLength(0);

    const poller = createCheckPoller(load, publish, {
      schedule,
      clear() {},
      delayMs: 2_000,
      isActive: isStreamTestActive,
    });
    poller.update(report(testId, "queued"));
    while (callbacks.length) await callbacks.shift()!();
    expect(publish.mock.calls.map(([test]) => test.phase)).toEqual([
      "metadata",
      "measuring",
      "done",
    ]);
    expect(delays).toEqual([2_000, 2_000, 2_000]);
    poller.stop();
  });
});

describe("companion service worker stream tests", () => {
  it("saves the start, then tests the draft with the form's type and numbering", async () => {
    const seed = readyState();
    seed.form.type = "series";
    seed.form.seasonHint = "2";
    seed.form.episodeHint = "5";
    const testId = randomUUID();
    let during = "";
    const worker = await companion(seed, (_call, stored) => {
      during = stored.streamTest.status;
      return report(testId);
    });
    const reply = await worker.send("panel:startStreamTest", {
      mode: "basic",
    });
    expect(during).toBe("starting");
    expect(worker.calls).toEqual([
      {
        command: "startStreamTest",
        payload: {
          draftId: seed.draft.draftId,
          type: "series",
          seasonHint: 2,
          episodeHint: 5,
          mode: "basic",
        },
      },
    ]);
    expect(reply).toMatchObject({
      ok: true,
      state: {
        streamTest: {
          status: "ready",
          test: { testId, phase: "queued" },
          fields: { type: "series", seasonHint: 2, episodeHint: 5 },
        },
      },
    });
    expect(worker.stored().streamTest.test?.testId).toBe(testId);
    expect(worker.broadcasts).toEqual([
      { type: PANEL_UPDATE_MESSAGE },
      { type: PANEL_UPDATE_MESSAGE },
    ]);
  });

  it("refuses to start without a ready draft or with bad numbering", async () => {
    const leased = readyState();
    leased.draft = {
      ...leased.draft,
      status: "leased",
      draftId: "",
      code: "draft_consumed",
    };
    let worker = await companion(leased);
    let reply = await worker.send("panel:startStreamTest", { mode: "basic" });
    expect(reply.state.streamTest).toMatchObject({
      status: "idle",
      code: "draft_missing",
      message:
        "The series preview holds this draft. To test it, cancel the preview and prepare the source again.",
    });
    expect(worker.calls).toEqual([]);

    const numbered = readyState();
    numbered.form.type = "series";
    numbered.form.episodeHint = "0";
    worker = await companion(numbered);
    reply = await worker.send("panel:startStreamTest", { mode: "basic" });
    expect(reply.state.streamTest).toMatchObject({
      status: "idle",
      code: "invalid_episode_hint",
    });
    expect(worker.calls).toEqual([]);
  });

  it("replaces a test only after the new one starts, keeping its numbering for a longer run", async () => {
    const seed = withTest(readyState(), "done", {
      type: "series",
      episodeHint: 3,
    });
    const previous = seed.streamTest.test!.testId;
    const testId = randomUUID();
    const worker = await companion(seed, ({ command }) =>
      command === "startStreamTest" ? report(testId) : { cancelled: true },
    );
    const reply = await worker.send("panel:startStreamTest", {
      mode: "extended",
      fileId: 4,
      reuse: true,
    });
    expect(worker.calls).toEqual([
      {
        command: "startStreamTest",
        payload: {
          draftId: seed.draft.draftId,
          type: "series",
          episodeHint: 3,
          fileId: 4,
          mode: "extended",
        },
      },
      { command: "cancelStreamTest", payload: { testId: previous } },
    ]);
    expect(reply.state.streamTest).toMatchObject({
      status: "ready",
      test: { testId },
      fields: { type: "series", episodeHint: 3 },
    });
  });

  it("keeps the shown result when a start fails, and asks an older app to update", async () => {
    const seed = withTest(readyState(), "done");
    const shown = seed.streamTest.test!.testId;
    let worker = await companion(seed, () => {
      throw failure(
        "invalid_request",
        "The companion request is invalid. Update the extension and retry.",
      );
    });
    let reply = await worker.send("panel:startStreamTest", { mode: "basic" });
    expect(reply.state.streamTest).toMatchObject({
      status: "ready",
      test: { testId: shown },
      code: "invalid_request",
      message:
        "Update the HoshiStream app to test streaming from the companion.",
    });
    expect(worker.calls.map(({ command }) => command)).toEqual([
      "startStreamTest",
    ]);

    worker = await companion(seed, () => {
      throw failure(
        "draft_expired",
        "This import draft expired. Prepare the source again.",
      );
    });
    reply = await worker.send("panel:startStreamTest", { mode: "basic" });
    expect(reply.state).toMatchObject({
      draft: { status: "expired", code: "draft_expired" },
      streamTest: { status: "ready", test: { testId: shown } },
    });
  });

  it("polls without a broadcast, ignores other tests and forgets one the server lost", async () => {
    const seed = withTest(readyState(), "queued");
    const testId = seed.streamTest.test!.testId;
    let next: unknown = report(testId, "measuring", {
      progress: { downloadMbps: 4, bytes: 1_000_000 },
    });
    const worker = await companion(seed, () => {
      if (next instanceof Error) throw next;
      return next;
    });
    let reply = await worker.send("panel:getStreamTest", { testId });
    expect(reply.state.streamTest).toMatchObject({
      status: "ready",
      test: { phase: "measuring", progress: { downloadMbps: 4 } },
    });
    reply = await worker.send("panel:getStreamTest", { testId: randomUUID() });
    expect(worker.calls).toHaveLength(1);
    expect(reply.state.streamTest.test?.testId).toBe(testId);

    next = failure(
      "app_unavailable",
      "HoshiStream could not be reached. Open the app and retry the same request.",
    );
    reply = await worker.send("panel:getStreamTest", { testId });
    expect(reply).toMatchObject({
      ok: false,
      error: { code: "app_unavailable" },
    });
    expect(worker.stored().streamTest.test?.phase).toBe("measuring");

    next = failure(
      "not_found",
      "The test expired or the server restarted. Test again.",
    );
    reply = await worker.send("panel:getStreamTest", { testId });
    expect(reply.state.streamTest).toEqual({
      ...BLANK,
      message: "The test expired or the server restarted. Test again.",
      code: "not_found",
    });
    expect(worker.broadcasts).toEqual([]);
  });

  it("cancels a running test, and a finished one keeps its result", async () => {
    const running = withTest(readyState(), "measuring");
    const testId = running.streamTest.test!.testId;
    let worker = await companion(running, () => ({ cancelled: true }));
    let reply = await worker.send("panel:cancelStreamTest");
    expect(worker.calls).toEqual([
      { command: "cancelStreamTest", payload: { testId } },
    ]);
    expect(reply.state.streamTest).toEqual({
      ...BLANK,
      note: "Test cancelled.",
    });

    worker = await companion(running, () => {
      throw failure("not_found", "The test expired or the server restarted.");
    });
    reply = await worker.send("panel:cancelStreamTest");
    expect(reply.state.streamTest).toEqual({
      ...BLANK,
      note: "Test cancelled.",
    });

    worker = await companion(running, () => {
      throw failure("app_unavailable", "HoshiStream could not be reached.");
    });
    reply = await worker.send("panel:cancelStreamTest");
    expect(reply.state.streamTest).toMatchObject({
      status: "ready",
      test: { testId, phase: "measuring" },
      code: "app_unavailable",
    });

    worker = await companion(withTest(readyState(), "done"));
    reply = await worker.send("panel:cancelStreamTest");
    expect(worker.calls).toEqual([]);
    expect(reply.state.streamTest).toMatchObject({
      status: "ready",
      test: { phase: "done" },
    });
  });

  it("ends the test after the draft when the source is cleared, replaced or saved", async () => {
    const seed = withTest(readyState(), "measuring");
    const { draftId } = seed.draft;
    const testId = seed.streamTest.test!.testId;
    let worker = await companion(seed);
    let reply = await worker.send("panel:discardImport");
    expect(worker.calls).toEqual([
      { command: "discardDraft", payload: { draftId } },
      { command: "cancelStreamTest", payload: { testId } },
    ]);
    expect(reply.state.streamTest).toEqual(BLANK);

    worker = await companion(seed, ({ command }) =>
      command === "prepareMagnet"
        ? {
            draftId: randomUUID(),
            expiresAt: new Date(Date.now() + 600_000).toISOString(),
            hash: "b".repeat(40),
            suggestedName: "Other",
            existingEntries: [],
          }
        : {},
    );
    reply = await worker.send("panel:prepareMagnet", {
      magnetUri: `magnet:?xt=urn:btih:${"b".repeat(40)}&dn=Other`,
    });
    expect(worker.calls.map(({ command }) => command)).toEqual([
      "discardDraft",
      "cancelStreamTest",
      "prepareMagnet",
    ]);
    expect(reply.state).toMatchObject({
      draft: { status: "ready" },
      streamTest: BLANK,
    });

    worker = await companion(seed, ({ command }) =>
      command === "createEntry"
        ? {
            outcome: "created",
            entry: { id: "hoshi:fixture", name: "Fixture", type: "movie" },
          }
        : { cancelled: true },
    );
    reply = await worker.send("panel:primaryAction", {
      reviewToken: reviewToken(seed),
    });
    expect(worker.calls.map(({ command }) => command)).toEqual([
      "createEntry",
      "cancelStreamTest",
    ]);
    expect(worker.calls[1].payload).toEqual({ testId });
    expect(reply.state).toMatchObject({
      save: { status: "saved" },
      streamTest: BLANK,
    });
  });
});
