import { afterEach, describe, expect, it, vi } from "vitest";
import { readFile } from "node:fs/promises";

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
  sourceCheckRows,
  lineFitLabel,
  sourceCheckRequestOptions,
  hasReadableSample,
} = module;
const { unanalyzedCount, analysisEvidenceCounts } =
  await import("../assets/manage/views/analysis.js");
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
      tone: "idle",
      label: "Sample unverified",
    });
  });

  it("keeps the final summary honest about one checked file not guaranteeing all playback", () => {
    expect(
      sourceCheckSummary({
        phase: "complete",
        probe: true,
        browserSupport: "likely",
        technical: { decodedVideoFrames: 1 },
      }),
    ).toContain("not a ready-to-play guarantee");
    expect(
      sourceCheckSummary({
        phase: "complete",
        probe: false,
      }),
    ).toContain("playback has not been checked");
  });

  it.each(["probe_timeout", "metadata_timeout", "check_timeout", "timeout"])(
    "treats legacy %s as inconclusive, not a red source failure",
    (code) => {
      const check = { phase: "failed", probe: true, code };
      expect(sourceCheckBadge(check)).toEqual({
        tone: "warn",
        label: "Check inconclusive",
      });
      expect(sourceCheckSummary(check)).toContain(
        "does not mean the source is unplayable",
      );
    },
  );

  it("keeps sample evidence separate from browser hints and latest attempt outcome", () => {
    const check = {
      phase: "complete",
      outcome: "observed",
      probe: true,
      checkedFiles: 1,
      totalFiles: 12,
      fileId: 4,
      filePath: "season/episode04.mp4",
      updatedAt: "2026-09-07T08:00:00Z",
      technical: { decodedVideoFrames: 1, videoCodec: "h264" },
      browserSupport: "unknown",
    };
    expect(sourceCheckBadge(check)).toEqual({
      tone: "ok",
      label: "Sample read",
    });
    expect(sourceCheckRows(check)).toContainEqual([
      "Browser hint",
      "Uncertain",
    ]);
    expect(sourceCheckRows(check)).toContainEqual([
      "Sample coverage",
      "1 of 12 files",
    ]);
    expect(sourceCheckRows(check)).toContainEqual(["File", check.filePath]);
    expect(
      sourceCheckRows(check).find(([label]) => label === "Last attempt")?.[1],
    ).toContain(check.updatedAt);
    expect(sourceCheckSummary(check, "series")).toContain("one episode");
    for (const outcome of ["inconclusive", "unavailable", "invalid"]) {
      const latest = { ...check, outcome, stage: "sample" };
      expect(sourceCheckBadge(latest).tone).not.toBe("ok");
      expect(hasReadableSample(latest)).toBe(false);
      expect(sourceCheckRows(latest)).toContainEqual([
        "Sample coverage",
        "0 of 12 files",
      ]);
      expect(sourceCheckRows(latest)).toContainEqual(["Video", "H264"]);
    }
  });

  it.each([undefined, 0])(
    "does not promote absent or zero decoded frames (%s) to sample evidence",
    (frames) => {
      const check = {
        phase: "complete",
        probe: true,
        browserSupport: "likely",
        technical: { decodedVideoFrames: frames, videoCodec: "h264" },
        checkedFiles: 1,
        totalFiles: 1,
      };
      expect(hasReadableSample(check)).toBe(false);
      expect(sourceCheckBadge(check).label).toBe("Sample unverified");
      expect(sourceCheckSummary(check)).toContain("historical metadata");
      expect(sourceCheckRows(check)).toContainEqual([
        "Sample coverage",
        "0 of 1 file",
      ]);
    },
  );

  it("shows a line-fit verdict only when the server rule and a bitrate are known", () => {
    const check = {
      phase: "complete",
      technical: { bitrateMbps: 12 },
    };
    expect(sourceCheckRows(check)).not.toContainEqual(
      expect.arrayContaining(["Line fit"]),
    );
    expect(
      sourceCheckRows(check, { lineMbps: 9.4, fitMbps: 7.5 }),
    ).toContainEqual(["Line fit", "Heavy · needs 12.0 Mbps, line ~9 Mbps"]);
    expect(lineFitLabel(4, { lineMbps: 9.4, fitMbps: 7.5 })).toBe(
      "Fits · needs 4.0 Mbps of ~9 Mbps",
    );
    expect(lineFitLabel(7.5, { lineMbps: 9.4, fitMbps: 7.5 })).toContain(
      "Fits",
    );
    expect(lineFitLabel(undefined, { lineMbps: 9.4, fitMbps: 7.5 })).toBe(
      undefined,
    );
    expect(lineFitLabel(4, undefined)).toBe(undefined);
  });

  it("reports metadata-only observations without a playback success badge", () => {
    const check = {
      phase: "complete",
      probe: false,
      outcome: "observed",
      checkedFiles: 0,
      totalFiles: 3,
    };
    expect(sourceCheckBadge(check)).toEqual({
      tone: "idle",
      label: "Metadata found",
    });
    expect(sourceCheckRows(check)).toContainEqual([
      "Sample coverage",
      "0 of 3 files",
    ]);
    expect(sourceCheckRows(check)).toContainEqual([
      "Browser hint",
      "Uncertain",
    ]);
    expect(sourceCheckSummary(check)).toContain(
      "File listings do not establish media availability",
    );
  });

  it("counts current check records rather than historical directPlay verdicts", () => {
    const entries = [
      { directPlay: { compatibility: "direct" } },
      { directPlay: { compatibility: "unknown" } },
      { sourceCheck: { phase: "complete", probe: false } },
      {
        directPlay: { compatibility: "direct" },
        sourceCheck: { phase: "failed", code: "probe_timeout" },
      },
    ];
    expect(unanalyzedCount(entries)).toBe(2);
    expect(analysisEvidenceCounts(entries)).toEqual([
      { label: "Unchecked", tone: "idle", count: 2 },
      { label: "Metadata found", tone: "idle", count: 1 },
      { label: "Check inconclusive", tone: "warn", count: 1 },
    ]);
  });

  it("keeps default and automatic checks basic and extends only an explicit retry without changing file", async () => {
    expect(
      sourceCheckRequestOptions(
        { mode: "extended" },
        { fileId: 3, mode: "extended" },
      ),
    ).toEqual({
      probe: true,
      fileId: 3,
      mode: "basic",
    });
    expect(
      sourceCheckRequestOptions({ probe: true }, { fileId: 0 }, "extended"),
    ).toEqual({
      probe: true,
      fileId: 0,
      mode: "extended",
    });
    expect(
      sourceCheckRequestOptions(
        { probe: false, fileId: 7 },
        { fileId: 2 },
        "extended",
      ),
    ).toEqual({
      probe: false,
      fileId: 2,
      mode: "extended",
    });
    const script = await readFile(
      new URL("../assets/manage/components/source-check.js", import.meta.url),
      "utf8",
    );
    expect(script).toContain('onClick=${() => run("extended")}');
    expect(script).toContain("Retry longer (up to 3 min)");
    expect(script).toContain(
      '!isSourceCheckActive(check) && phase !== "unchecked"',
    );
    expect(script).toContain("Earlier file facts");
  });

  it("labels raw stream opening as an action rather than a playback assessment", async () => {
    const script = await readFile(
      new URL("../assets/manage/views/detail.js", import.meta.url),
      "utf8",
    );
    expect(script).toContain("Open direct stream");
    expect(script).not.toContain("Test playback");
    expect(script).toContain("Always offer the Compatible stream");
    expect(script).toContain("Relink on this computer");
  });

  it("preserves the requested file instead of switching to another source when retrying", () => {
    expect(
      sourceCheckRequestOptions({ fileId: 2 }, { fileId: 1 }, "extended")
        .fileId,
    ).toBe(1);
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
