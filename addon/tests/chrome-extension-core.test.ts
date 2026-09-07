import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import {
  MAX_TORRENT_BYTES,
  PROTOCOL_VERSION,
} from "../assets/chrome-extension/lib/constants.js";
import {
  checkBadge,
  createCheckPoller,
} from "../assets/chrome-extension/lib/checks.js";
import { normalizeCapturedLinks } from "../assets/chrome-extension/lib/capture.js";
import {
  createNativeRequest,
  decodeTorrentBytesBase64,
  encodeBytesBase64,
  isMagnetUri,
  parseMagnetTitle,
} from "../assets/chrome-extension/lib/protocol.js";
import {
  applyPreviewResult,
  buildCreateEntryPayload,
  buildSeriesCommitPayload,
  buildSeriesPreviewPayload,
  clearPreviewAndRequireFreshDraft,
  createInitialState,
  ensurePendingCommit,
  primaryButtonSpec,
  recoverState,
  restorePendingCommit,
  reviewToken,
} from "../assets/chrome-extension/lib/state.js";

function readyDraftState() {
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
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    hash: "a".repeat(40),
    suggestedName: "Fixture",
    existingEntries: [],
    message: "",
    code: "",
  };
  state.form.name = "Fixture";
  return state;
}

describe("chrome companion panel shell", () => {
  it("preserves every wired control and unique element ID", async () => {
    const [html, script] = await Promise.all(
      ["panel.html", "panel.js"].map((file) =>
        readFile(
          new URL(`../assets/chrome-extension/${file}`, import.meta.url),
          "utf8",
        ),
      ),
    );
    const ids = [...html.matchAll(/\bid="([^"]+)"/g)].map((match) => match[1]);
    expect(new Set(ids).size).toBe(ids.length);
    const controls = [...script.matchAll(/getElementById\("([^"]+)"\)/g)];
    for (const [, id] of controls) expect(ids).toContain(id);
  });

  it("keeps file selection keyboard-accessible and labels icon-only controls", async () => {
    const html = await readFile(
      new URL("../assets/chrome-extension/panel.html", import.meta.url),
      "utf8",
    );
    const fileInput = html.match(
      /<input\b[^>]*\bid="torrent-input"[^>]*>/s,
    )?.[0];
    expect(fileInput).toBeDefined();
    expect(fileInput).not.toMatch(/\shidden(?:\s|>|=)/);
    expect(fileInput).toContain('aria-label="Choose a .torrent file"');
    expect(html).toContain('aria-label="Refresh connection"');
    expect(html).toMatch(/id="global-alert"[^>]*role="alert"/s);
  });
});

describe("chrome companion protocol helpers", () => {
  it("builds versioned native envelopes", () => {
    expect(createNativeRequest("status", {})).toMatchObject({
      version: PROTOCOL_VERSION,
      command: "status",
      payload: {},
    });
  });

  it("accepts only valid magnet sources and decodes magnet titles", () => {
    expect(isMagnetUri("magnet:?xt=urn:btih:abc&dn=Title")).toBe(true);
    expect(isMagnetUri("https://example.com/file.torrent")).toBe(false);
    expect(parseMagnetTitle("magnet:?xt=urn:btih:abc&dn=One%20Piece")).toBe(
      "One Piece",
    );
  });

  it("rejects oversized torrent payloads", () => {
    const oversized = encodeBytesBase64(new Uint8Array(MAX_TORRENT_BYTES + 1));
    expect(() => decodeTorrentBytesBase64(oversized)).toThrow(
      "Choose a valid .torrent file no larger than 1 MB.",
    );
  });

  it("round-trips valid torrent bytes", () => {
    const bytes = Uint8Array.from([1, 2, 3, 4, 5]);
    expect([...decodeTorrentBytesBase64(encodeBytesBase64(bytes))]).toEqual([
      1, 2, 3, 4, 5,
    ]);
  });
});

describe("chrome companion capture normalization", () => {
  it("filters to magnets and torrent hints while removing duplicates", () => {
    const candidates = normalizeCapturedLinks({
      pageTitle: "Fixture page",
      pageUrl: "https://example.com/watch",
      links: [
        {
          href: " magnet:?xt=urn:btih:ABC123&dn=Captured%20Title ",
          text: "Magnet",
        },
        {
          href: "magnet:?xt=urn:btih:abc123&dn=Duplicate",
          text: "Duplicate magnet",
        },
        {
          href: "https://example.com/downloads/fixture.torrent",
          text: "Download torrent",
        },
        {
          href: "https://example.com/downloads/fixture.torrent",
          text: "Duplicate torrent",
        },
        {
          href: "https://example.com/video.mp4",
          text: "Ignore video",
        },
      ],
    });
    expect(candidates).toHaveLength(2);
    expect(candidates[0]).toMatchObject({
      kind: "magnet",
      titleSuggestion: "Captured Title",
    });
    expect(candidates[1]).toMatchObject({
      kind: "torrent-link-hint",
      titleSuggestion: "fixture",
    });
  });
});

describe("chrome companion save workflow", () => {
  it("keeps a stable idempotency key across replayed commit bodies", () => {
    const state = readyDraftState();
    const first = ensurePendingCommit(
      null,
      "createEntry",
      buildCreateEntryPayload(state),
    );
    const replay = ensurePendingCommit(
      first,
      "createEntry",
      buildCreateEntryPayload(state),
    );
    expect(replay.id).toBe(first.id);
    expect(replay.payload.idempotencyKey).toBe(first.payload.idempotencyKey);
    expect(() =>
      ensurePendingCommit(
        first,
        "createEntry",
        buildCreateEntryPayload({
          ...state,
          form: { ...state.form, name: "Changed locally" },
        }),
      ),
    ).toThrow("original add");
  });

  it("recovers a pending confirmation after browser session storage is lost", () => {
    const state = readyDraftState();
    const record = {
      ...ensurePendingCommit(
        null,
        "createEntry",
        buildCreateEntryPayload(state),
      ),
      source: state.source,
      form: state.form,
    };
    const recovered = restorePendingCommit(createInitialState(), {
      [record.id]: record,
    });
    expect(recovered.save.status).toBe("retry");
    expect(recovered.save.pendingId).toBe(record.id);
    expect(recovered.source).toEqual(state.source);
    expect(
      reviewToken({
        ...recovered,
        status: { ...recovered.status, connected: true },
      }),
    ).toBe(reviewToken(recovered));
  });

  it("marks interrupted pending saves as retry-only after recovery", () => {
    const state = readyDraftState();
    state.save = {
      status: "saving",
      pendingId: randomUUID(),
      outcome: "",
      entry: null,
      check: null,
      checkError: null,
      message: "Waiting for HoshiStream…",
      code: "",
      uncertain: false,
    };
    expect(recoverState(state).save).toMatchObject({
      status: "retry",
      uncertain: true,
    });
  });

  it("keeps expiry and series-consent boundaries explicit", () => {
    const expired = readyDraftState();
    expired.draft.expiresAt = new Date(Date.now() - 1_000).toISOString();
    expect(() => buildCreateEntryPayload(expired)).toThrow(
      "This import draft expired. Prepare the source again.",
    );

    const series = readyDraftState();
    series.form.type = "series";
    series.form.seriesMode = "existing";
    series.catalog.series = [
      { id: "entry-1", name: "Existing", inspected: true, sourceCount: 1 },
    ];
    series.form.targetEntryId = "entry-1";
    expect(buildSeriesPreviewPayload(series)).toMatchObject({
      entryId: "entry-1",
    });
    series.preview = {
      status: "ready",
      previewId: randomUUID(),
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      entryId: "entry-1",
      entryName: "Existing",
      seasonHint: "",
      addedEpisodes: [],
      replacements: [
        {
          season: 1,
          episode: 2,
          previousPath: "old.mkv",
          incomingPath: "new.mkv",
        },
      ],
      message: "",
      code: "",
    };
    expect(() => buildSeriesCommitPayload(series)).toThrow(
      "Confirm replacements before adding this source.",
    );
  });

  it("consumes the draft after preview and requires reprepare before a fresh review", () => {
    const series = readyDraftState();
    series.form.replaceConsent = true;
    series.form.type = "series";
    series.form.seriesMode = "existing";
    series.catalog.series = [
      { id: "entry-1", name: "Existing", inspected: true, sourceCount: 1 },
    ];
    series.form.targetEntryId = "entry-1";
    const previewed = applyPreviewResult(series, {
      previewId: randomUUID(),
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      entryId: "entry-1",
      entryName: "Existing",
      addedEpisodes: [],
      replacements: [],
    });
    expect(previewed.draft).toMatchObject({
      status: "leased",
      code: "draft_consumed",
      draftId: "",
    });
    expect(previewed.form.replaceConsent).toBe(false);
    expect(primaryButtonSpec(previewed)).toMatchObject({
      label: "Add to series",
      disabled: false,
    });

    const invalidated = clearPreviewAndRequireFreshDraft(
      previewed,
      "This series preview no longer matches your changes. Re-prepare the original source before requesting a fresh preview or save.",
    );
    expect(invalidated.preview.status).toBe("idle");
    expect(invalidated.draft).toMatchObject({
      status: "error",
      code: "draft_refresh_required",
    });
    expect(primaryButtonSpec(invalidated)).toMatchObject({
      label: "Review again",
      disabled: false,
    });
  });
});

describe("chrome companion check polling", () => {
  it("cancels scheduled polling cleanly", async () => {
    const callbacks: Array<() => Promise<void>> = [];
    const publishes: string[] = [];
    const poller = createCheckPoller(
      async () => ({ phase: "complete" }),
      (report) => publishes.push(report.phase),
      {
        schedule(callback) {
          callbacks.push(callback);
          return callback;
        },
        clear() {},
      },
    );
    poller.update({ phase: "queued" });
    poller.stop();
    await Promise.all(callbacks.map((callback) => callback()));
    expect(publishes).toEqual([]);
    expect(
      checkBadge({ phase: "complete", probe: true, browserSupport: "limited" }),
    ).toEqual({
      tone: "idle",
      label: "Sample unverified",
    });
  });
});
