import { afterEach, describe, expect, it, vi } from "vitest";

globalThis.location = {
  pathname: "/manage/fixture-token",
} as Location;

const module = await import("../assets/manage/components/source-check.js");
const {
  createSourceCheckController,
  pickSourceCheckFileId,
  sourceCheckBadge,
  sourceCheckSummary,
  sourceCheckKey,
} = module;
const { state, markSourceCheckRequested, refreshSourceCheckReports } =
  await import("../assets/manage/store.js");

afterEach(() => {
  vi.unstubAllGlobals();
  state.entries = [];
  state.selected = null;
  state.checkRequests = [];
  state.checkStatusErrors = {};
});

describe("source check UI helpers", () => {
  it("maps source-check phases to truthful short badges", () => {
    expect(sourceCheckBadge()).toEqual({ tone: "idle", label: "Unchecked" });
    expect(sourceCheckBadge({ phase: "queued" })).toEqual({
      tone: "warn",
      label: "Queued",
    });
    expect(
      sourceCheckBadge({
        phase: "complete",
        probe: true,
        browserSupport: "limited",
      }),
    ).toEqual({
      tone: "warn",
      label: "Browser limited",
    });
  });

  it("keeps the final summary honest about one checked file not guaranteeing all playback", () => {
    expect(
      sourceCheckSummary({
        phase: "complete",
        probe: true,
        browserSupport: "likely",
      }),
    ).toContain("not a ready-to-play guarantee");
    expect(
      sourceCheckSummary({
        phase: "complete",
        probe: false,
      }),
    ).toContain("playback has not been checked");
  });

  it("prefers the newest server-owned source hash when choosing a representative file", () => {
    expect(
      pickSourceCheckFileId({
        sourceHash: "older-server",
        searchImport: { hash: "older-legacy" },
        extraSources: [
          {
            sourceHash: "newest-server",
            searchImport: { hash: "newest-legacy" },
          },
        ],
        inspectionCache: {
          selectedFiles: [
            { id: 1, hash: "older-server" },
            { id: 2, hash: "newest-server" },
          ],
        },
      }),
    ).toBe(2);
    expect(
      pickSourceCheckFileId({
        searchImport: { hash: "legacy-only" },
        inspectionCache: { selectedFiles: [{ id: 5, hash: "legacy-only" }] },
      }),
    ).toBe(5);
    expect(
      pickSourceCheckFileId({
        inspectionCache: { selectedFiles: [{ id: 7 }] },
      }),
    ).toBe(7);
  });

  it("stops polling cleanly on unmount-style cancellation", async () => {
    const publish = vi.fn();
    const clear = vi.fn();
    const pending: Array<() => Promise<void>> = [];
    const load = vi.fn().mockResolvedValue({ phase: "complete" });
    const controller = createSourceCheckController(load, publish, {
      schedule(callback) {
        pending.push(callback);
        return callback;
      },
      clear,
    });
    controller.update({ phase: "queued" });
    controller.stop();
    expect(clear).toHaveBeenCalled();
    expect(load).not.toHaveBeenCalled();
    await Promise.all(pending.map((callback) => callback()));
    expect(publish).not.toHaveBeenCalled();
  });

  it("surfaces polling failures and stops after a bounded retry sequence", async () => {
    const callbacks: Array<() => Promise<void>> = [];
    const load = vi.fn().mockRejectedValue(new Error("offline"));
    const onError = vi.fn();
    const controller = createSourceCheckController(load, vi.fn(), {
      schedule(callback) {
        callbacks.push(callback);
        return callback;
      },
      clear: vi.fn(),
      onError,
    });
    controller.update({ phase: "queued" });
    await callbacks.shift()!();
    await callbacks.shift()!();
    await callbacks.shift()!();
    expect(load).toHaveBeenCalledTimes(3);
    expect(onError).toHaveBeenCalledTimes(3);
    expect(callbacks).toHaveLength(0);
    controller.stop();
  });

  it("keys check lifetimes by source selection, not title or check progress", () => {
    const entry = { id: "one", type: "movie", magnetUri: "magnet:?xt=fixture" };
    expect(
      sourceCheckKey({
        ...entry,
        name: "Renamed",
        sourceCheck: { phase: "complete" },
      }),
    ).toBe(sourceCheckKey(entry));
    expect(sourceCheckKey({ ...entry, preferredFileIndex: 2 })).not.toBe(
      sourceCheckKey(entry),
    );
    expect(sourceCheckKey({ ...entry, sourceHash: "server-hash" })).not.toBe(
      sourceCheckKey(entry),
    );
  });

  it("updates queued library badges after a check panel is closed", async () => {
    state.entries = [{ id: "one", name: "Fixture" }];
    markSourceCheckRequested("one");
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            entryId: "one",
            phase: "complete",
            message: "Checked",
            probe: true,
            browserSupport: "likely",
          }),
        ),
      ),
    );
    await refreshSourceCheckReports();
    expect(state.entries[0].sourceCheck.phase).toBe("complete");
    expect(state.checkRequests).toEqual([]);
  });

  it("does not overwrite an edited entry or clear its new pending request with stale status", async () => {
    state.entries = [{ id: "two", name: "Before" }];
    markSourceCheckRequested("two");
    let finish!: (response: Response) => void;
    vi.stubGlobal(
      "fetch",
      vi.fn(
        () =>
          new Promise((resolve) => {
            finish = resolve;
          }),
      ),
    );
    const pending = refreshSourceCheckReports();
    state.entries = [{ id: "two", name: "After", preferredFileIndex: 2 }];
    finish(
      new Response(
        JSON.stringify({
          entryId: "two",
          phase: "complete",
          message: "Old check",
        }),
      ),
    );
    await pending;
    expect(state.entries[0].name).toBe("After");
    expect(state.entries[0].sourceCheck).toBeUndefined();
    expect(state.checkRequests).toEqual(["two"]);
  });
});
