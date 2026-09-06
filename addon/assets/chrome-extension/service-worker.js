import {
  PANEL_STATE_KEY,
  PANEL_UPDATE_MESSAGE,
  PENDING_COMMITS_KEY,
} from "./lib/constants.js";
import { normalizeCapturedLinks, sourceFromCandidate } from "./lib/capture.js";
import {
  sendNativeRequest,
  assertTrustedUiSender,
  statusFromError,
} from "./lib/native.js";
import {
  applyCheckResult,
  applyCommitFailure,
  applyCommitRetry,
  applyCommitSuccess,
  applyDraftResult,
  applyFormPatch,
  applyPreviewResult,
  buildCreateEntryPayload,
  buildSeriesCommitPayload,
  buildSeriesPreviewPayload,
  clearPreviewAndRequireFreshDraft,
  createInitialState,
  ensurePendingCommit,
  markDraftExpired,
  markPreviewExpired,
  needsSeriesPreview,
  recoverState,
  restorePendingCommit,
  reviewToken,
  sourceToken,
  selectSource,
} from "./lib/state.js";
import {
  assertTorrentFileName,
  createProtocolError,
  isMagnetUri,
  normalizeMagnetUri,
  parseMagnetTitle,
} from "./lib/protocol.js";

const extensionOrigin = chrome.runtime.getURL("");
let currentState;
let initialization;
let work = Promise.resolve();
let queued = 0;

function enqueue(action) {
  if (queued >= 32)
    return Promise.reject(
      createProtocolError(
        "busy",
        "The companion is busy. Wait for the current action.",
      ),
    );
  queued++;
  const result = work.then(action);
  work = result.then(
    () => undefined,
    () => undefined,
  );
  return result.finally(() => {
    queued--;
  });
}

function sessionArea() {
  return chrome.storage.session ?? chrome.storage.local;
}

async function loadState() {
  initialization ??= (async () => {
    const stored = (await sessionArea().get(PANEL_STATE_KEY))[PANEL_STATE_KEY];
    currentState = restorePendingCommit(
      recoverState(stored),
      await loadPendingCommits(),
    );
    await sessionArea().set({ [PANEL_STATE_KEY]: currentState });
  })();
  await initialization;
  return structuredClone(currentState);
}

async function saveState(state, { broadcast = true } = {}) {
  const next = { ...state, updatedAt: new Date().toISOString() };
  currentState = next;
  await sessionArea().set({ [PANEL_STATE_KEY]: next });
  if (broadcast) {
    await chrome.runtime
      .sendMessage({ type: PANEL_UPDATE_MESSAGE })
      .catch(() => {});
  }
  return next;
}

async function loadPendingCommits() {
  return (
    (await chrome.storage.local.get(PENDING_COMMITS_KEY))[
      PENDING_COMMITS_KEY
    ] ?? {}
  );
}

async function savePendingCommits(records) {
  await chrome.storage.local.set({ [PENDING_COMMITS_KEY]: records });
}

async function storePendingCommit(record) {
  const records = await loadPendingCommits();
  records[record.id] = record;
  await savePendingCommits(records);
  return record;
}

async function readPendingCommit(id) {
  return (await loadPendingCommits())[id] ?? null;
}

async function removePendingCommit(id) {
  const records = await loadPendingCommits();
  if (!records[id]) return;
  delete records[id];
  await savePendingCommits(records);
}

function copySections(state, base = createInitialState()) {
  return {
    draft: base.draft,
    preview: base.preview,
    save: base.save,
    capture: base.capture,
    editor: base.editor,
    form: {
      ...state.form,
      name: base.form.name,
      suggestedName: base.form.suggestedName,
      replaceConsent: false,
    },
  };
}

function setDraftError(state, error) {
  return {
    ...state,
    draft: {
      ...state.draft,
      status: "error",
      code: error.code ?? "prepare_failed",
      message: error.message,
    },
    save: createInitialState().save,
  };
}

function setPreviewError(state, error) {
  return {
    ...state,
    preview: {
      ...state.preview,
      status: "error",
      code: error.code ?? "preview_failed",
      message: error.message,
    },
    save: createInitialState().save,
  };
}

function assertNoPendingConfirmation(state) {
  if (state.save.status === "saving" || state.save.status === "retry") {
    throw createProtocolError(
      "pending_confirmation",
      "Retry the same add before changing or clearing this draft.",
    );
  }
}

async function bestEffortDiscard(command, payload) {
  if (!payload) return;
  await sendNativeRequest(chrome.runtime, command, payload).catch(() =>
    console.warn(
      "Unused import metadata will be reclaimed by HoshiStream after expiry.",
    ),
  );
}

async function releaseDraftArtifacts(state) {
  if (state.preview.previewId) {
    await bestEffortDiscard("discardPreview", {
      previewId: state.preview.previewId,
    });
  }
  if (state.draft.draftId) {
    await bestEffortDiscard("discardDraft", { draftId: state.draft.draftId });
  }
}

async function clearImportState({ preserveEditor = false } = {}) {
  const state = await loadState();
  assertNoPendingConfirmation(state);
  await releaseDraftArtifacts(state);
  const base = createInitialState();
  return saveState({
    ...state,
    source: base.source,
    ...copySections(state, base),
    editor: preserveEditor ? state.editor : base.editor,
  });
}

async function refreshStatusState() {
  let state = await loadState();
  try {
    const report = await sendNativeRequest(chrome.runtime, "status", {});
    state = await loadState();
    const next = {
      phase: "ready",
      connected: Boolean(report.connected),
      appRunning: Boolean(report.appRunning),
      engineReady: Boolean(report.engineReady),
      canStartApp: Boolean(report.canStartApp),
      message: report.message ?? "",
      code: "",
    };
    const catalog = { ...state.catalog };
    if (next.connected) {
      const [tagsResult, seriesResult] = await Promise.allSettled([
        sendNativeRequest(chrome.runtime, "tags", {}),
        sendNativeRequest(chrome.runtime, "series", {}),
      ]);
      catalog.loaded = true;
      if (tagsResult.status === "fulfilled")
        catalog.tags = tagsResult.value.tags ?? [];
      if (seriesResult.status === "fulfilled") {
        catalog.series = seriesResult.value.entries ?? [];
      }
    }
    return saveState({ ...state, status: next, catalog });
  } catch (error) {
    state = await loadState();
    return saveState({ ...state, status: statusFromError(error) });
  }
}

async function startAppState() {
  let state = await loadState();
  try {
    const report = await sendNativeRequest(chrome.runtime, "startApp", {});
    state = await saveState({
      ...state,
      status: {
        phase: "ready",
        connected: Boolean(report.connected),
        appRunning: Boolean(report.appRunning),
        engineReady: Boolean(report.engineReady),
        canStartApp: Boolean(report.canStartApp),
        message: report.message ?? "",
        code: "",
      },
    });
  } catch (error) {
    await saveState({ ...state, status: statusFromError(error) });
  }
  return refreshStatusState();
}

async function prepareSource(source) {
  const state = await loadState();
  assertNoPendingConfirmation(state);
  await releaseDraftArtifacts(state);
  let next = selectSource(state, source);
  next.editor = {
    magnetText: source.kind === "magnet" ? source.magnetUri : "",
  };
  next.draft = {
    ...next.draft,
    status: "preparing",
    message: "Preparing source…",
  };
  next = await saveState(next);
  try {
    const draft = await sendNativeRequest(
      chrome.runtime,
      source.kind === "magnet" ? "prepareMagnet" : "prepareTorrent",
      source.kind === "magnet"
        ? { magnetUri: source.magnetUri }
        : { bytesBase64: source.bytesBase64, fileName: source.fileName },
    );
    return saveState(applyDraftResult(await loadState(), draft));
  } catch (error) {
    return saveState(setDraftError(await loadState(), error));
  }
}

async function prepareMagnetState(magnetUri) {
  const value = normalizeMagnetUri(magnetUri);
  if (!isMagnetUri(value)) {
    throw createProtocolError(
      "invalid_magnet",
      "Paste a full magnet URI before adding it.",
    );
  }
  return prepareSource({
    kind: "magnet",
    magnetUri: value,
    titleSuggestion: parseMagnetTitle(value),
    captureLabel: "Manual magnet",
  });
}

async function prepareTorrentState(payload) {
  const fileName = assertTorrentFileName(payload?.fileName);
  const bytesBase64 = String(payload?.bytesBase64 ?? "").trim();
  return prepareSource({
    kind: "torrent-file",
    fileName,
    bytesBase64,
    titleSuggestion:
      payload?.titleSuggestion ?? fileName.replace(/\.torrent$/i, ""),
    captureLabel: fileName,
  });
}

async function retryPrepareState() {
  const state = await loadState();
  if (state.source.kind === "magnet") return prepareSource(state.source);
  if (state.source.kind === "torrent-file") return prepareSource(state.source);
  if (state.source.kind === "torrent-link-hint") {
    throw createProtocolError(
      "torrent_file_required",
      "Download the .torrent file in Chrome, then choose it here.",
    );
  }
  throw createProtocolError(
    "source_missing",
    "Choose a magnet or .torrent file before retrying.",
  );
}

async function ensureFreshDraftState() {
  const state = await loadState();
  if (state.draft.status === "ready" && state.draft.draftId) return state;
  return retryPrepareState();
}

async function captureFromActiveTab() {
  const [tab] = await chrome.tabs.query({
    active: true,
    lastFocusedWindow: true,
  });
  if (!tab?.id) {
    throw createProtocolError(
      "active_tab_missing",
      "Open a normal browser tab, then capture its links.",
    );
  }
  try {
    const [injected] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: () => ({
        pageTitle: document.title,
        pageUrl: location.href,
        links: Array.from(document.querySelectorAll("a[href]"))
          .slice(0, 500)
          .map((anchor) => ({
            href: (anchor.getAttribute("href") || anchor.href || "").slice(
              0,
              16_384,
            ),
            text: (anchor.textContent || "").trim().slice(0, 500),
            title: (anchor.getAttribute("title") || "").slice(0, 500),
            ariaLabel: (anchor.getAttribute("aria-label") || "").slice(0, 500),
            download: (anchor.getAttribute("download") || "").slice(0, 255),
          })),
      }),
    });
    const state = await loadState();
    const candidates = normalizeCapturedLinks(injected?.result ?? {});
    if (!candidates.length) {
      return saveState({
        ...state,
        capture: {
          status: "error",
          candidates: [],
          message:
            "No magnets or direct .torrent download hints were found on this page.",
        },
      });
    }
    if (candidates.length === 1) {
      return chooseCaptureCandidate(candidates[0], state);
    }
    return saveState({
      ...state,
      capture: {
        status: "ready",
        candidates,
        message: `${candidates.length} import sources found on this page.`,
      },
    });
  } catch {
    const state = await loadState();
    return saveState({
      ...state,
      capture: {
        status: "error",
        candidates: [],
        message:
          "Chrome only lets HoshiStream read a page after you click the toolbar button on that tab. Click it, then try Capture page links again.",
      },
    });
  }
}

async function chooseCaptureCandidate(candidateOrId, existingState = null) {
  const state = existingState ?? (await loadState());
  assertNoPendingConfirmation(state);
  const candidate =
    typeof candidateOrId === "string"
      ? state.capture.candidates.find((item) => item.id === candidateOrId)
      : candidateOrId;
  if (!candidate) {
    throw createProtocolError(
      "capture_missing",
      "Capture page links again and choose the source you want.",
    );
  }
  const source = sourceFromCandidate(candidate);
  if (source.kind === "magnet") return prepareSource(source);
  await releaseDraftArtifacts(state);
  return saveState({
    ...selectSource(state, source),
    editor: { magnetText: "" },
  });
}

async function previewSeriesState() {
  let state = await ensureFreshDraftState();
  if (state.draft.status !== "ready") return state;
  const payload = buildSeriesPreviewPayload(state);
  if (state.preview.previewId) {
    await bestEffortDiscard("discardPreview", {
      previewId: state.preview.previewId,
    });
  }
  state = await saveState({
    ...state,
    preview: {
      ...state.preview,
      status: "loading",
      message: "Reviewing episode overlap…",
    },
  });
  try {
    const preview = await sendNativeRequest(
      chrome.runtime,
      "previewSeries",
      payload,
    );
    return saveState(applyPreviewResult(await loadState(), preview));
  } catch (error) {
    return saveState(setPreviewError(await loadState(), error));
  }
}

async function cancelPreviewState() {
  const state = await loadState();
  if (!state.preview.previewId) return state;
  if (state.preview.previewId) {
    await bestEffortDiscard("discardPreview", {
      previewId: state.preview.previewId,
    });
  }
  return saveState(
    clearPreviewAndRequireFreshDraft(
      state,
      "Re-prepare the original source before requesting a fresh preview or save.",
    ),
  );
}

async function runCommit(command, payloadFactory) {
  const state = await loadState();
  const payload = payloadFactory(state);
  const existing = state.save.pendingId
    ? await readPendingCommit(state.save.pendingId)
    : null;
  const pending = await storePendingCommit({
    ...ensurePendingCommit(existing, command, payload),
    source: state.source,
    form: state.form,
  });
  await saveState({
    ...state,
    save: {
      ...createInitialState().save,
      status: "saving",
      pendingId: pending.id,
      message: "Waiting for HoshiStream…",
    },
  });
  try {
    const result = await sendNativeRequest(
      chrome.runtime,
      pending.command,
      pending.payload,
    );
    const saved = await saveState(
      applyCommitSuccess(await loadState(), result),
    );
    await removePendingCommit(pending.id);
    return saved;
  } catch (error) {
    if (error.retryable) {
      return saveState(applyCommitRetry(await loadState(), pending.id, error));
    }
    await removePendingCommit(pending.id);
    if (command === "commitSeries") {
      return saveState(
        applyCommitFailure(
          clearPreviewAndRequireFreshDraft(
            await loadState(),
            "This series preview was already spent. Re-prepare the original source before reviewing or saving again.",
            error.code === "preview_expired"
              ? error.message
              : "This episode preview is no longer active. Review it again before saving.",
          ),
          error,
        ),
      );
    }
    if (error.code === "draft_expired") {
      return saveState(
        applyCommitFailure(
          markDraftExpired(await loadState(), error.message),
          error,
        ),
      );
    }
    if (error.code === "preview_expired") {
      return saveState(
        applyCommitFailure(
          markPreviewExpired(await loadState(), error.message),
          error,
        ),
      );
    }
    return saveState(applyCommitFailure(await loadState(), error));
  }
}

async function retryPendingCommitState() {
  const state = await loadState();
  if (!state.save.pendingId) {
    return saveState(
      applyCommitFailure(
        state,
        createProtocolError(
          "pending_commit_missing",
          "The original add request is missing. Prepare the source again.",
        ),
      ),
    );
  }
  const pending = await readPendingCommit(state.save.pendingId);
  if (!pending) {
    return saveState(
      applyCommitFailure(
        state,
        createProtocolError(
          "pending_commit_missing",
          "The original add request is missing. Prepare the source again.",
        ),
      ),
    );
  }
  await saveState({
    ...state,
    save: {
      ...createInitialState().save,
      status: "saving",
      pendingId: pending.id,
      message: "Retrying the original add…",
    },
  });
  try {
    const result = await sendNativeRequest(
      chrome.runtime,
      pending.command,
      pending.payload,
    );
    const saved = await saveState(
      applyCommitSuccess(await loadState(), result),
    );
    await removePendingCommit(pending.id);
    return saved;
  } catch (error) {
    if (error.retryable) {
      return saveState(applyCommitRetry(await loadState(), pending.id, error));
    }
    await removePendingCommit(pending.id);
    if (pending.command === "commitSeries") {
      return saveState(
        applyCommitFailure(
          clearPreviewAndRequireFreshDraft(
            await loadState(),
            "This series preview was already spent. Re-prepare the original source before reviewing or saving again.",
            error.code === "preview_expired"
              ? error.message
              : "This episode preview is no longer active. Review it again before saving.",
          ),
          error,
        ),
      );
    }
    if (error.code === "draft_expired") {
      return saveState(
        applyCommitFailure(
          markDraftExpired(await loadState(), error.message),
          error,
        ),
      );
    }
    if (error.code === "preview_expired") {
      return saveState(
        applyCommitFailure(
          markPreviewExpired(await loadState(), error.message),
          error,
        ),
      );
    }
    return saveState(applyCommitFailure(await loadState(), error));
  }
}

async function startCheckState() {
  const state = await loadState();
  const entry = state.save.entry;
  if (!entry?.id) {
    throw createProtocolError(
      "entry_missing",
      "Save the entry before starting a source check.",
    );
  }
  const check = await sendNativeRequest(chrome.runtime, "startCheck", {
    entryId: entry.id,
    ...(entry.checkFileId === undefined ? {} : { fileId: entry.checkFileId }),
  });
  return saveState(applyCheckResult(await loadState(), check));
}

async function getCheckState() {
  const state = await loadState();
  const entry = state.save.entry;
  if (!entry?.id) {
    throw createProtocolError(
      "entry_missing",
      "Save the entry before refreshing its source check.",
    );
  }
  const check = await sendNativeRequest(chrome.runtime, "getCheck", {
    entryId: entry.id,
  });
  return saveState(applyCheckResult(await loadState(), check));
}

async function cancelCheckState() {
  const state = await loadState();
  const entry = state.save.entry;
  if (!entry?.id) {
    throw createProtocolError(
      "entry_missing",
      "Save the entry before cancelling its source check.",
    );
  }
  const check = await sendNativeRequest(chrome.runtime, "cancelCheck", {
    entryId: entry.id,
  });
  return saveState(applyCheckResult(await loadState(), check));
}

async function openEntryState(entryId) {
  const state = await loadState();
  const resolvedEntryId = entryId || state.save.entry?.id;
  if (!resolvedEntryId) {
    throw createProtocolError(
      "entry_missing",
      "Save the entry before opening it in HoshiStream.",
    );
  }
  await sendNativeRequest(chrome.runtime, "openEntry", {
    entryId: resolvedEntryId,
  });
  return state;
}

async function updateDraftFields(payload) {
  const state = await loadState();
  assertNoPendingConfirmation(state);
  if (payload?.sourceToken !== sourceToken(state))
    throw createProtocolError(
      "review_changed",
      "The captured source changed. Review its current details.",
    );
  const next = {
    ...applyFormPatch(state, payload?.form ?? {}),
    editor: {
      ...state.editor,
      ...(payload?.editor ?? {}),
    },
  };
  const previewInvalidated =
    Boolean(state.preview.previewId) &&
    ["type", "seriesMode", "targetEntryId", "seasonHint"].some(
      (key) => state.form[key] !== next.form[key],
    );
  if (previewInvalidated) {
    await bestEffortDiscard("discardPreview", {
      previewId: state.preview.previewId,
    });
    const refreshed = clearPreviewAndRequireFreshDraft(
      next,
      "This series preview no longer matches your changes. Re-prepare the original source before requesting a fresh preview or save.",
    );
    return saveState(refreshed, { broadcast: false });
  }
  return saveState(next, { broadcast: false });
}

async function primaryActionState() {
  const state = await loadState();
  if (state.save.status === "retry" && state.save.pendingId) {
    return retryPendingCommitState();
  }
  if (needsSeriesPreview(state)) {
    if (state.preview.status === "ready") {
      return runCommit("commitSeries", buildSeriesCommitPayload);
    }
    return previewSeriesState();
  }
  if (
    state.draft.status === "error" ||
    state.draft.status === "expired" ||
    state.draft.status === "leased"
  ) {
    return retryPrepareState();
  }
  return runCommit("createEntry", buildCreateEntryPayload);
}

async function bootstrapState() {
  const state = await loadState();
  if (state.status.phase === "idle") {
    const next = await saveState(
      { ...state, status: { ...state.status, phase: "loading" } },
      { broadcast: false },
    );
    void enqueue(refreshStatusState).catch(() =>
      console.warn("HoshiStream status could not be loaded."),
    );
    return next;
  }
  return state;
}

async function handlePanelMessage(message) {
  switch (message.type) {
    case "panel:bootstrap":
      return bootstrapState();
    case "panel:refreshStatus":
      return refreshStatusState();
    case "panel:startApp":
      return startAppState();
    case "panel:captureActiveTab":
      return captureFromActiveTab();
    case "panel:selectCapture":
      return chooseCaptureCandidate(message.payload?.candidateId);
    case "panel:prepareMagnet":
      return prepareMagnetState(message.payload?.magnetUri);
    case "panel:prepareTorrent":
      return prepareTorrentState(message.payload);
    case "panel:retryPrepare":
      return retryPrepareState();
    case "panel:reviewSeriesAgain":
      return previewSeriesState();
    case "panel:updateDraftFields":
      return updateDraftFields(message.payload);
    case "panel:cancelPreview":
      return cancelPreviewState();
    case "panel:discardImport":
      return clearImportState();
    case "panel:primaryAction":
      if (message.payload?.reviewToken !== reviewToken(await loadState()))
        throw createProtocolError(
          "review_changed",
          "The source or details changed. Review them before adding.",
        );
      return primaryActionState();
    case "panel:startCheck":
      return startCheckState();
    case "panel:getCheck":
      return getCheckState();
    case "panel:cancelCheck":
      return cancelCheckState();
    case "panel:openEntry":
      return openEntryState(message.payload?.entryId);
    default:
      throw createProtocolError(
        "unknown_message",
        "The HoshiStream panel sent an unsupported request.",
      );
  }
}

async function openPanel(tabId) {
  if (!tabId) return;
  await chrome.sidePanel.open({ tabId });
}

chrome.runtime.onInstalled.addListener(async () => {
  await chrome.contextMenus.removeAll();
  await chrome.contextMenus.create({
    id: "capture-magnet-link",
    title: "Add magnet to HoshiStream",
    contexts: ["link"],
  });
});

chrome.action.onClicked.addListener(async (tab) => {
  await openPanel(tab?.id);
});

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (info.menuItemId !== "capture-magnet-link") return;
  await openPanel(tab?.id);
  await enqueue(async () => {
    if (!isMagnetUri(info.linkUrl ?? "")) {
      const state = await loadState();
      await saveState({
        ...state,
        capture: {
          status: "error",
          candidates: [],
          message:
            "That link is not a magnet URI. Use Capture page links or choose a .torrent file instead.",
        },
      });
      return;
    }
    await prepareSource({
      kind: "magnet",
      magnetUri: normalizeMagnetUri(info.linkUrl),
      titleSuggestion: parseMagnetTitle(info.linkUrl),
      captureLabel: "Captured from link",
    });
  }).catch(() =>
    console.warn(
      "The captured source could not be prepared. Open the companion to retry.",
    ),
  );
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === PANEL_UPDATE_MESSAGE) {
    sendResponse({ ok: true });
    return;
  }
  if (!assertTrustedUiSender(sender, extensionOrigin)) {
    sendResponse({
      ok: false,
      error: {
        code: "unauthorized_sender",
        message: "Only the HoshiStream panel can invoke companion actions.",
      },
    });
    return;
  }
  void (
    message.type === "panel:bootstrap"
      ? bootstrapState()
      : enqueue(() => handlePanelMessage(message))
  )
    .then((state) => sendResponse({ ok: true, state }))
    .catch((error) =>
      sendResponse({
        ok: false,
        error: { code: error.code ?? "request_failed", message: error.message },
      }),
    );
  return true;
});
