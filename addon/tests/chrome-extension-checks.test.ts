import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  checkActions,
  checkBadge,
  checkDetails,
  checkSummary,
  createCheckPoller,
  hasReadableSample,
  startCheckPayload,
} from "../assets/chrome-extension/lib/checks.js";
import { NativeClient } from "../src/browser/client.ts";
import { nativeRequestSchema } from "../src/browser/protocol.ts";

const sampled = {
  phase: "complete",
  outcome: "observed",
  probe: true,
  checkedFiles: 1,
  totalFiles: 9,
  fileId: 4,
  filePath: "season/episode04.mp4",
  updatedAt: "2026-09-07T08:00:00Z",
  technical: {
    sizeBytes: 12345,
    decodedVideoFrames: 1,
    container: "mov",
    videoCodec: "h264",
    videoProfile: "Main",
    pixelFormat: "yuv420p",
    audioCodec: "aac",
  },
  browserSupport: "likely",
};

afterEach(() => vi.restoreAllMocks());

describe("companion evidence labels", () => {
  it.each(["probe_timeout", "metadata_timeout", "check_timeout", "timeout"])(
    "shows a legacy %s as inconclusive",
    (code) => {
      const check = { phase: "failed", code, probe: true };
      expect(checkBadge(check)).toEqual({
        tone: "warn",
        label: "Check inconclusive",
      });
      expect(checkSummary(check)).toContain(
        "does not mean the source is unplayable",
      );
    },
  );

  it("separates a decoded host sample from the browser support hint", () => {
    for (const browserSupport of ["likely", "limited", "unknown"]) {
      const check = { ...sampled, browserSupport };
      expect(checkBadge(check)).toEqual({ tone: "ok", label: "Sample read" });
      expect(checkSummary(check, "series")).toContain("one episode");
      expect(checkSummary(check)).toContain("not a ready-to-play guarantee");
      expect(checkDetails(check)).toContain("Sample coverage: 1 of 9 files");
      expect(checkDetails(check)).toContain(sampled.filePath);
      expect(checkDetails(check)).toContain(sampled.updatedAt);
      expect(checkDetails(check)).toContain("Browser hint:");
    }
    expect(checkDetails({ ...sampled, browserSupport: "unknown" })).toContain(
      "Browser hint: Uncertain",
    );
    expect(checkDetails({ ...sampled, browserSupport: undefined })).toContain(
      "Browser hint: Uncertain",
    );
  });

  it("never turns retained codec facts into a successful latest attempt", () => {
    for (const outcome of ["inconclusive", "unavailable", "invalid"]) {
      const check = { ...sampled, outcome, stage: "sample" };
      expect(checkBadge(check).tone).not.toBe("ok");
      expect(hasReadableSample(check)).toBe(false);
      expect(checkDetails(check)).toContain("Sample coverage: 0 of 9 files");
    }
    expect(checkBadge({ ...sampled, outcome: "unavailable" }).label).toBe(
      "Check unavailable",
    );
  });

  it("treats historical and incomplete probes as unverified", () => {
    for (const technical of [undefined, {}, { decodedVideoFrames: 0 }]) {
      const check = { ...sampled, technical };
      expect(checkBadge(check)).toEqual({
        tone: "idle",
        label: "Sample unverified",
      });
      expect(checkSummary(check)).toContain("historical metadata");
      expect(checkDetails(check)).toContain("Sample coverage: 0 of 9 files");
    }
    const metadata = { ...sampled, probe: false, checkedFiles: 0 };
    expect(checkBadge(metadata)).toEqual({
      tone: "idle",
      label: "Metadata found",
    });
    expect(checkSummary(metadata)).toContain("playback has not been checked");
  });
});

describe("explicit longer checks", () => {
  it("offers extended retry only in terminal states, never during polling or first automatic check", () => {
    expect(checkActions()).toEqual([
      {
        label: "Start check",
        command: "panel:startCheck",
        payload: { mode: "basic" },
      },
    ]);
    for (const phase of ["queued", "inspecting", "probing"]) {
      expect(checkActions({ phase }).map((action) => action.command)).toEqual([
        "panel:getCheck",
        "panel:cancelCheck",
      ]);
    }
    for (const phase of ["complete", "failed", "cancelled", "interrupted"]) {
      expect(checkActions({ phase })).toContainEqual({
        label: "Retry longer (up to 3 min)",
        command: "panel:startCheck",
        payload: { mode: "extended" },
      });
    }
  });

  it("preserves the last requested file, including zero, and never automatically escalates", () => {
    const entry = { id: "hoshi:fixture", checkFileId: 8 };
    expect(startCheckPayload(entry, { fileId: 0, mode: "extended" })).toEqual({
      entryId: entry.id,
      fileId: 0,
      mode: "basic",
    });
    expect(startCheckPayload(entry, { fileId: 4 }, "extended")).toEqual({
      entryId: entry.id,
      fileId: 4,
      mode: "extended",
    });
    expect(startCheckPayload(entry, undefined, "extended").fileId).toBe(8);
    expect(() => startCheckPayload(entry, undefined, "unlimited")).toThrow();
  });

  it.each([undefined, "basic", "extended"] as const)(
    "validates and forwards %s through the native bridge without changing the target",
    async (mode) => {
      const client = new NativeClient({
        version: 1,
        extensionId: "a".repeat(32),
        projectRoot: process.cwd(),
      });
      const internals = client as unknown as {
        settings(): Promise<void>;
        api(path: string, method: string, body: unknown): Promise<unknown>;
      };
      vi.spyOn(internals, "settings").mockResolvedValue();
      const api = vi.spyOn(internals, "api").mockResolvedValue({
        entryId: "hoshi:fixture",
        jobId: randomUUID(),
        revision: "a".repeat(64),
        phase: "queued",
        probe: true,
        updatedAt: sampled.updatedAt,
        message: "Queued",
        fileId: 0,
        mode: mode ?? "basic",
      });
      const message = nativeRequestSchema.parse({
        version: 1,
        id: randomUUID(),
        command: "startCheck",
        payload: {
          entryId: "hoshi:fixture",
          fileId: 0,
          ...(mode ? { mode } : {}),
        },
      });
      await client.handle(message);
      expect(api).toHaveBeenCalledWith(
        "library/hoshi%3Afixture/check",
        "POST",
        {
          probe: true,
          fileId: 0,
          ...(mode ? { mode } : {}),
        },
      );
    },
  );

  it("rejects unsupported extended modes at the native boundary", () => {
    expect(
      nativeRequestSchema.safeParse({
        version: 1,
        id: randomUUID(),
        command: "startCheck",
        payload: { entryId: "hoshi:fixture", mode: "unlimited" },
      }).success,
    ).toBe(false);
  });

  it("wires the panel action to the worker mode without adding an automatic longer check", async () => {
    const [panel, worker] = await Promise.all(
      ["panel.js", "service-worker.js"].map((path) =>
        readFile(
          new URL(`../assets/chrome-extension/${path}`, import.meta.url),
          "utf8",
        ),
      ),
    );
    expect(panel).toContain("checkActions(check).map");
    expect(panel).toContain("runRequest(command, payload)");
    expect(worker).toContain("startCheckState(message.payload?.mode)");
    expect(worker).toContain(
      "startCheckPayload(entry, state.save.check ?? entry.sourceCheck, mode)",
    );
  });
});

describe("companion phase polling", () => {
  it("polls active phases, stops at inconclusive completion, and does not start a retry", async () => {
    const callbacks: Array<() => Promise<void>> = [];
    const load = vi
      .fn()
      .mockResolvedValueOnce({ phase: "probing" })
      .mockResolvedValueOnce({ phase: "complete", outcome: "inconclusive" });
    const publish = vi.fn();
    const poller = createCheckPoller(load, publish, {
      schedule(callback) {
        callbacks.push(callback);
        return callback;
      },
      clear() {},
    });
    poller.update({ phase: "queued" });
    await callbacks.shift()!();
    await callbacks.shift()!();
    expect(callbacks).toHaveLength(0);
    expect(load).toHaveBeenCalledTimes(2);
    expect(publish).toHaveBeenLastCalledWith({
      phase: "complete",
      outcome: "inconclusive",
    });
    poller.stop();
  });

  it("suppresses a cancelled in-flight result and does not load cleared callbacks", async () => {
    const callbacks: Array<() => Promise<void>> = [];
    let finish!: (result: unknown) => void;
    const load = vi.fn(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const publish = vi.fn();
    const poller = createCheckPoller(load, publish, {
      schedule(callback) {
        callbacks.push(callback);
        return callback;
      },
      clear() {},
    });
    poller.update({ phase: "probing" });
    const pending = callbacks.shift()!();
    poller.stop();
    finish(sampled);
    await pending;
    expect(publish).not.toHaveBeenCalled();
    poller.update({ phase: "queued" });
    poller.stop();
    await callbacks.shift()!();
    expect(load).toHaveBeenCalledTimes(1);
  });
});
