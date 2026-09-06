import { describe, expect, it, vi } from "vitest";
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore plain browser ES module shared with the management UI
import * as importState from "../assets/manage/import-state.js";

const {
  additionalSourceImportProblems,
  createRequestGate,
  editableSource,
  manualSubmission,
  stripServerMetadata,
} = importState;

describe("management request gate", () => {
  it("aborts replaced requests and rejects their late responses", async () => {
    const gate = createRequestGate();
    const first = gate.start();
    let resolveFirst!: (value: string) => void;
    const response = new Promise<string>((resolve) => {
      resolveFirst = resolve;
    });
    const published: string[] = [];
    const completion = response.then((value) => {
      if (first.isCurrent()) published.push(value);
    });
    const second = gate.start();
    expect(first.signal.aborted).toBe(true);
    expect(second.signal.aborted).toBe(false);
    resolveFirst("stale entry");
    await completion;
    expect(published).toEqual([]);
    expect(first.isCurrent()).toBe(false);
    expect(second.isCurrent()).toBe(true);
  });

  it("invalidates a request on cancel/close and permits a fresh retry", () => {
    const gate = createRequestGate();
    const request = gate.start();
    gate.cancel();
    gate.cancel();
    expect(request.signal.aborted).toBe(true);
    expect(request.isCurrent()).toBe(false);
    const retry = gate.start();
    expect(retry.isCurrent()).toBe(true);
    expect(retry.signal.aborted).toBe(false);
  });
});

describe("manual add submission state", () => {
  it("reuses the same create payload and idempotency key on retry", () => {
    const uuid = vi
      .fn()
      .mockReturnValueOnce("manual-first")
      .mockReturnValueOnce("manual-second");
    const payload = {
      name: "Manual add",
      type: "movie",
      localFilePath: "/managed/manual.mp4",
    };
    const first = manualSubmission(null, payload, uuid);
    const retry = manualSubmission(first, { ...payload }, uuid);
    const changed = manualSubmission(
      retry,
      { ...payload, name: "Manual add (edited)" },
      uuid,
    );
    expect(retry).toBe(first);
    expect(first.body.idempotencyKey).toBe("manual-first");
    expect(changed.body.idempotencyKey).toBe("manual-second");
  });
});

describe("ordinary JSON metadata", () => {
  it("flags exported file-backed extras as nonportable rather than silently omitting them", () => {
    const entry = {
      name: "Series",
      magnetUri: "magnet:main",
      extraSources: [
        { magnetUri: "magnet:extra", seasonHint: 1 },
        { id: "file-extra", seasonHint: 2 },
      ],
    };
    const problems = additionalSourceImportProblems(entry);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("Additional source 2");
    expect(problems[0]).toContain("Browser JSON omits managed .torrent files");
    expect(problems[0]).toContain("library.json and managed media");
    expect(entry.extraSources).toHaveLength(2);
  });

  it("accepts present extra-source locators and flags invalid or missing ones", () => {
    expect(additionalSourceImportProblems({})).toEqual([]);
    expect(
      additionalSourceImportProblems({
        extraSources: [
          { torrentFilePath: "/managed/source.torrent" },
          { magnetUri: "magnet:extra" },
        ],
      }),
    ).toEqual([]);
    expect(
      additionalSourceImportProblems({
        extraSources: [null, {}, { magnetUri: " " }],
      }),
    ).toHaveLength(3);
    expect(additionalSourceImportProblems({ extraSources: {} })).toEqual([
      "Additional sources must be a list.",
    ]);
  });

  it("leaves malformed source shapes for the API boundary to reject", () => {
    expect(
      stripServerMetadata({
        name: "Invalid sources",
        extraSources: [null, "invalid", []],
      }),
    ).toEqual({
      name: "Invalid sources",
      extraSources: [null, "invalid", []],
    });
  });

  it("strips server-owned metadata and source hashes from entries and nested extra sources without mutation", () => {
    const entry = {
      name: "Series",
      managedMedia: true,
      searchImport: { hash: "legacy-top-level" },
      searchReceipts: [{ idempotencyKey: "internal" }],
      sourceHash: "server-top-level",
      sourceCheck: { phase: "complete", probe: true },
      extraSources: [
        {
          id: "extra",
          torrentFilePath: "/managed/extra.torrent",
          managedMedia: true,
          searchImport: { hash: "legacy-nested" },
          searchReceipts: [{ idempotencyKey: "nested-internal" }],
          sourceHash: "server-nested",
          sourceCheck: { phase: "complete", probe: true },
        },
      ],
    };
    expect(stripServerMetadata(entry)).toEqual({
      name: "Series",
      extraSources: [
        { id: "extra", torrentFilePath: "/managed/extra.torrent" },
      ],
    });
    expect(entry.searchImport.hash).toBe("legacy-top-level");
    expect(entry.sourceHash).toBe("server-top-level");
    expect(entry.extraSources[0].searchImport.hash).toBe("legacy-nested");
    expect(entry.extraSources[0].sourceHash).toBe("server-nested");
    expect(entry.extraSources[0].managedMedia).toBe(true);
    expect(entry.sourceCheck.phase).toBe("complete");
  });

  it("ordinary source PATCH payloads allow only source locators and editable mapping", () => {
    const source = {
      id: "server-owned-id",
      torrentFilePath: "/managed/source.torrent",
      managedMedia: true,
      searchImport: { hash: "legacy-source-hash" },
      searchReceipts: [{ idempotencyKey: "internal" }],
      sourceHash: "server-source-hash",
      seasonHint: 0,
      fileOverrides: [{ id: 1, included: true, season: 0, episode: 1 }],
      unexpected: "must not be sent",
    };
    expect(editableSource(source)).toEqual({
      torrentFilePath: source.torrentFilePath,
      seasonHint: 0,
      fileOverrides: source.fileOverrides,
    });
    expect(
      editableSource({ magnetUri: "magnet:authorized", seasonHint: 2 }),
    ).toEqual({
      magnetUri: "magnet:authorized",
      seasonHint: 2,
    });
    expect(source.sourceHash).toBe("server-source-hash");
    expect(source.managedMedia).toBe(true);
  });
});
