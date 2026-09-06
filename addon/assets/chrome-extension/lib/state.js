import {
  STATE_VERSION,
  TRANSIENT_DRAFT_STATUSES,
  TRANSIENT_PREVIEW_STATUSES,
  TRANSIENT_SAVE_STATUSES,
} from "./constants.js";
import {
  cleanLabel,
  createProtocolError,
  stripTorrentExtension,
} from "./protocol.js";

function blankStatus() {
  return {
    phase: "idle",
    connected: false,
    appRunning: false,
    engineReady: false,
    canStartApp: false,
    message: "",
    code: "",
  };
}

function blankDraft() {
  return {
    status: "idle",
    draftId: "",
    expiresAt: "",
    hash: "",
    suggestedName: "",
    existingEntries: [],
    message: "",
    code: "",
  };
}

function blankPreview() {
  return {
    status: "idle",
    previewId: "",
    expiresAt: "",
    entryId: "",
    entryName: "",
    seasonHint: "",
    addedEpisodes: [],
    replacements: [],
    message: "",
    code: "",
  };
}

function blankSave() {
  return {
    status: "idle",
    pendingId: "",
    outcome: "",
    entry: null,
    check: null,
    checkError: null,
    message: "",
    code: "",
    uncertain: false,
  };
}

function blankCapture() {
  return {
    status: "idle",
    candidates: [],
    message: "",
  };
}

export function createInitialState() {
  return {
    version: STATE_VERSION,
    status: blankStatus(),
    source: { kind: "none" },
    draft: blankDraft(),
    preview: blankPreview(),
    save: blankSave(),
    capture: blankCapture(),
    catalog: { tags: [], series: [], loaded: false },
    editor: { magnetText: "" },
    form: {
      name: "",
      suggestedName: "",
      type: "movie",
      tagsText: "",
      detailsOpen: false,
      seriesMode: "new",
      targetEntryId: "",
      seasonHint: "",
      checkAfterSave: true,
      replaceConsent: false,
    },
    updatedAt: new Date().toISOString(),
  };
}

export function parseTagsInput(tagsText) {
  const seen = new Set();
  return String(tagsText ?? "")
    .split(",")
    .map((tag) => cleanLabel(tag, 40))
    .filter(
      (tag) =>
        tag && !seen.has(tag.toLowerCase()) && seen.add(tag.toLowerCase()),
    )
    .slice(0, 32);
}

export function isExpired(expiresAt, now = Date.now()) {
  if (!expiresAt) return false;
  const value = Date.parse(expiresAt);
  return Number.isFinite(value) && value <= now;
}

function preferredSuggestion(source, draftSuggestion) {
  if (cleanLabel(source?.titleSuggestion))
    return cleanLabel(source.titleSuggestion);
  if (cleanLabel(draftSuggestion)) return cleanLabel(draftSuggestion);
  if (source?.kind === "torrent-file")
    return stripTorrentExtension(source.fileName);
  if (source?.kind === "torrent-link-hint")
    return stripTorrentExtension(source.fileName);
  return "";
}

function carryName(currentName, previousSuggestion, nextSuggestion) {
  const current = cleanLabel(currentName);
  const previous = cleanLabel(previousSuggestion);
  const next = cleanLabel(nextSuggestion);
  if (!next) return current;
  if (!current || current === previous) return next;
  return current;
}

export function sourceSummary(source) {
  if (!source || source.kind === "none") return "";
  if (source.kind === "magnet") {
    return cleanLabel(
      source.captureLabel || source.titleSuggestion || "Magnet source",
    );
  }
  if (source.kind === "torrent-file") {
    return cleanLabel(source.fileName, 255);
  }
  if (source.kind === "torrent-link-hint") {
    return cleanLabel(
      source.captureLabel || source.fileName || "Torrent download hint",
    );
  }
  return "";
}

export function selectSource(state, source) {
  return {
    ...state,
    source,
    draft: blankDraft(),
    preview: blankPreview(),
    save: blankSave(),
    capture: blankCapture(),
    form: {
      ...state.form,
      name: carryName(
        state.form.name,
        state.form.suggestedName,
        source.titleSuggestion,
      ),
      suggestedName: cleanLabel(source.titleSuggestion),
      replaceConsent: false,
    },
  };
}

export function applyDraftResult(state, draft) {
  const suggestion = preferredSuggestion(state.source, draft.suggestedName);
  return {
    ...state,
    draft: {
      status: "ready",
      draftId: draft.draftId,
      expiresAt: draft.expiresAt,
      hash: draft.hash,
      suggestedName: cleanLabel(draft.suggestedName),
      existingEntries: Array.isArray(draft.existingEntries)
        ? draft.existingEntries
        : [],
      message: "",
      code: "",
    },
    preview: blankPreview(),
    save: blankSave(),
    form: {
      ...state.form,
      name: carryName(state.form.name, state.form.suggestedName, suggestion),
      suggestedName: cleanLabel(suggestion),
      replaceConsent: false,
    },
  };
}

export function applyFormPatch(state, patch) {
  const previous = state.form;
  const nextForm = { ...previous, ...patch };
  if (nextForm.type !== "series") {
    nextForm.seriesMode = "new";
    nextForm.targetEntryId = "";
    nextForm.seasonHint = "";
    nextForm.replaceConsent = false;
  }
  if (nextForm.seriesMode !== "existing") {
    nextForm.targetEntryId =
      nextForm.seriesMode === "existing" ? nextForm.targetEntryId : "";
    nextForm.seasonHint =
      nextForm.seriesMode === "existing" ? nextForm.seasonHint : "";
    nextForm.replaceConsent = false;
  }
  const previewSensitive = [
    "type",
    "seriesMode",
    "targetEntryId",
    "seasonHint",
  ].some((key) => previous[key] !== nextForm[key]);
  return {
    ...state,
    form: nextForm,
    preview: previewSensitive ? blankPreview() : state.preview,
  };
}

export function buildCreateEntryPayload(state) {
  if (state.draft.status !== "ready") {
    throw createProtocolError(
      "draft_missing",
      "Prepare a source before adding it to your library.",
    );
  }
  if (isExpired(state.draft.expiresAt)) {
    throw createProtocolError(
      "draft_expired",
      "This import draft expired. Prepare the source again.",
    );
  }
  const name = cleanLabel(state.form.name);
  if (!name) {
    throw createProtocolError(
      "name_required",
      "Name this entry before adding it.",
    );
  }
  const tags = parseTagsInput(state.form.tagsText);
  return {
    draftId: state.draft.draftId,
    name,
    type: state.form.type,
    ...(tags.length ? { tags } : {}),
    checkAfterSave: Boolean(state.form.checkAfterSave),
  };
}

export function needsSeriesPreview(state) {
  return state.form.type === "series" && state.form.seriesMode === "existing";
}

function seasonHintValue(value) {
  const trimmed = cleanLabel(value, 10);
  if (!trimmed) return undefined;
  const number = Number(trimmed);
  if (!Number.isInteger(number) || number < 0) {
    throw createProtocolError(
      "invalid_season_hint",
      "Season hint must be a whole number starting at 0.",
    );
  }
  return number;
}

export function buildSeriesPreviewPayload(state) {
  if (!needsSeriesPreview(state)) {
    throw createProtocolError(
      "series_target_missing",
      "Choose an existing series target before previewing it.",
    );
  }
  if (state.draft.status !== "ready") {
    throw createProtocolError(
      "draft_missing",
      "Prepare a source before previewing a series merge.",
    );
  }
  if (isExpired(state.draft.expiresAt)) {
    throw createProtocolError(
      "draft_expired",
      "This import draft expired. Prepare the source again.",
    );
  }
  if (!state.form.targetEntryId) {
    throw createProtocolError(
      "series_target_missing",
      "Choose an existing series target before previewing it.",
    );
  }
  const target = state.catalog.series.find(
    (entry) => entry.id === state.form.targetEntryId,
  );
  if (!target) {
    throw createProtocolError(
      "series_target_missing",
      "Refresh the series list and choose the target again.",
    );
  }
  if (!target.inspected) {
    throw createProtocolError(
      "series_target_uninspected",
      "Inspect the target series in HoshiStream before previewing episode overlap.",
    );
  }
  const seasonHint = seasonHintValue(state.form.seasonHint);
  return {
    draftId: state.draft.draftId,
    entryId: state.form.targetEntryId,
    ...(seasonHint === undefined ? {} : { seasonHint }),
  };
}

export function applyPreviewResult(state, preview) {
  return {
    ...state,
    draft: {
      ...blankDraft(),
      status: "leased",
      code: "draft_consumed",
    },
    preview: {
      status: "ready",
      previewId: preview.previewId,
      expiresAt: preview.expiresAt,
      entryId: preview.entryId,
      entryName: cleanLabel(preview.entryName),
      seasonHint: cleanLabel(state.form.seasonHint, 10),
      addedEpisodes: Array.isArray(preview.addedEpisodes)
        ? preview.addedEpisodes
        : [],
      replacements: Array.isArray(preview.replacements)
        ? preview.replacements
        : [],
      message: "",
      code: "",
    },
    save: blankSave(),
    form: {
      ...state.form,
      replaceConsent: false,
    },
  };
}

export function buildSeriesCommitPayload(state) {
  if (state.preview.status !== "ready") {
    throw createProtocolError(
      "preview_missing",
      "Preview the series merge before adding it.",
    );
  }
  if (isExpired(state.preview.expiresAt)) {
    throw createProtocolError(
      "preview_expired",
      "This episode preview expired. Review the episode changes again.",
    );
  }
  if (state.preview.replacements.length && !state.form.replaceConsent) {
    throw createProtocolError(
      "replace_consent_required",
      "Confirm replacements before adding this source.",
    );
  }
  return {
    previewId: state.preview.previewId,
    allowReplace: Boolean(state.preview.replacements.length),
    checkAfterSave: Boolean(state.form.checkAfterSave),
  };
}

export function ensurePendingCommit(existingRecord, command, payload) {
  if (existingRecord) {
    const { idempotencyKey, ...original } = existingRecord.payload;
    const { idempotencyKey: requestedKey, ...requested } = payload;
    if (
      existingRecord.command !== command ||
      JSON.stringify(original) !== JSON.stringify(requested) ||
      (requestedKey && requestedKey !== idempotencyKey)
    )
      throw createProtocolError(
        "pending_confirmation",
        "Retry the original add before changing its details.",
      );
    return structuredClone(existingRecord);
  }
  return {
    id: existingRecord?.id ?? crypto.randomUUID(),
    command,
    payload: {
      ...payload,
      idempotencyKey:
        existingRecord?.payload?.idempotencyKey ??
        payload.idempotencyKey ??
        crypto.randomUUID(),
    },
    createdAt: existingRecord?.createdAt ?? new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

export function reviewToken(state) {
  return JSON.stringify({
    draftId: state.draft.draftId,
    previewId: state.preview.previewId,
    pendingId: state.save.pendingId,
    name: state.form.name,
    type: state.form.type,
    tagsText: state.form.tagsText,
    seriesMode: state.form.seriesMode,
    targetEntryId: state.form.targetEntryId,
    seasonHint: state.form.seasonHint,
    replaceConsent: state.form.replaceConsent,
    checkAfterSave: state.form.checkAfterSave,
  });
}

export function sourceToken(state) {
  return JSON.stringify({
    draftId: state.draft.draftId,
    previewId: state.preview.previewId,
    pendingId: state.save.pendingId,
    kind: state.source.kind,
  });
}

export function restorePendingCommit(state, records) {
  const pending =
    records[state.save.pendingId] ??
    Object.values(records).find(
      (record) =>
        record &&
        ["createEntry", "commitSeries"].includes(record.command) &&
        record.id &&
        record.payload?.idempotencyKey,
    );
  if (!pending) return state;
  return {
    ...state,
    source: pending.source ?? state.source,
    form: pending.form ?? state.form,
    save: {
      ...blankSave(),
      status: "retry",
      pendingId: pending.id,
      uncertain: true,
      message:
        "An earlier add was not confirmed. Retry the same add before changing this source.",
    },
  };
}

function outcomeMessage(outcome) {
  if (outcome === "existing") return "This source is already in your library.";
  if (outcome === "appended")
    return "Episodes were added to the existing series.";
  return "Saved to your library.";
}

export function applyCommitSuccess(state, result) {
  const check = result.check ?? result.entry?.sourceCheck ?? null;
  const entry = result.entry
    ? { ...result.entry, ...(check ? { sourceCheck: check } : {}) }
    : null;
  return {
    ...state,
    draft: blankDraft(),
    preview: blankPreview(),
    save: {
      status: "saved",
      pendingId: "",
      outcome: result.outcome,
      entry,
      check,
      checkError: result.checkError ?? null,
      message: outcomeMessage(result.outcome),
      code: "",
      uncertain: false,
    },
  };
}

export function applyCommitRetry(state, pendingId, error) {
  return {
    ...state,
    save: {
      ...blankSave(),
      status: "retry",
      pendingId,
      message: error.message,
      code: error.code ?? "request_retry_required",
      uncertain: Boolean(error.uncertain),
    },
  };
}

export function applyCommitFailure(state, error) {
  return {
    ...state,
    save: {
      ...blankSave(),
      status: "error",
      message: error.message,
      code: error.code ?? "request_failed",
      uncertain: false,
    },
  };
}

export function markDraftRefreshRequired(
  state,
  message = "Re-prepare the original source before requesting a fresh preview or save.",
) {
  return {
    ...state,
    draft: {
      ...blankDraft(),
      status: "error",
      message,
      code: "draft_refresh_required",
    },
  };
}

export function clearPreviewAndRequireFreshDraft(
  state,
  draftMessage = "Re-prepare the original source before requesting a fresh preview or save.",
  previewMessage = "",
) {
  return {
    ...markDraftRefreshRequired(state, draftMessage),
    preview: previewMessage
      ? {
          ...blankPreview(),
          status: "expired",
          message: previewMessage,
          code: "preview_refresh_required",
        }
      : blankPreview(),
  };
}

export function applyCheckResult(state, check) {
  if (!state.save.entry) return state;
  return {
    ...state,
    save: {
      ...state.save,
      check,
      entry: {
        ...state.save.entry,
        sourceCheck: check?.phase === "unchecked" ? undefined : check,
      },
    },
  };
}

export function markDraftExpired(
  state,
  message = "This import draft expired. Prepare the source again.",
) {
  return {
    ...state,
    draft: {
      ...state.draft,
      status: "expired",
      message,
      code: "draft_expired",
    },
    save: blankSave(),
  };
}

export function markPreviewExpired(
  state,
  message = "This episode preview expired. Review the episode changes again.",
) {
  return {
    ...state,
    preview: {
      ...state.preview,
      status: "expired",
      message,
      code: "preview_expired",
    },
    save: blankSave(),
  };
}

export function recoverState(state, now = Date.now()) {
  const next =
    state?.version === STATE_VERSION
      ? structuredClone(state)
      : createInitialState();
  if (TRANSIENT_DRAFT_STATUSES.has(next.draft.status)) {
    next.draft.status = "error";
    next.draft.code = next.draft.code || "prepare_interrupted";
    next.draft.message = "Preparing the source was interrupted. Retry it.";
  }
  if (TRANSIENT_PREVIEW_STATUSES.has(next.preview.status)) {
    next.preview.status = "error";
    next.preview.code = next.preview.code || "preview_interrupted";
    next.preview.message = "Series preview was interrupted. Preview it again.";
  }
  if (TRANSIENT_SAVE_STATUSES.has(next.save.status) && next.save.pendingId) {
    next.save.status = "retry";
    next.save.code = next.save.code || "save_interrupted";
    next.save.message =
      "Chrome paused before HoshiStream confirmed the save. Retry the same add before changing this draft.";
    next.save.uncertain = true;
  }
  if (isExpired(next.draft.expiresAt, now) && next.draft.status === "ready") {
    next.draft.status = "expired";
    next.draft.code = "draft_expired";
    next.draft.message = "This import draft expired. Prepare the source again.";
  }
  if (
    isExpired(next.preview.expiresAt, now) &&
    next.preview.status === "ready"
  ) {
    next.preview.status = "expired";
    next.preview.code = "preview_expired";
    next.preview.message =
      "This episode preview expired. Review the episode changes again.";
  }
  return next;
}

export function primaryButtonSpec(state) {
  if (state.save.status === "saving") {
    return {
      label: "Saving…",
      disabled: true,
      hint: "Waiting for HoshiStream.",
    };
  }
  if (state.save.status === "retry" && state.save.pendingId) {
    return {
      label: "Retry same add",
      disabled: false,
      hint: "Retry the original request before changing this draft.",
    };
  }
  if (state.draft.status === "preparing") {
    return { label: "Preparing…", disabled: true, hint: "Reading the source." };
  }
  if (state.preview.status === "loading") {
    return {
      label: "Previewing…",
      disabled: true,
      hint: "Reviewing episode overlap.",
    };
  }
  if (needsSeriesPreview(state)) {
    if (!state.form.targetEntryId) {
      return {
        label: "Choose a series",
        disabled: true,
        hint: "Pick an inspected series target first.",
      };
    }
    if (state.preview.status === "ready") {
      if (state.preview.replacements.length && !state.form.replaceConsent) {
        return {
          label: "Add to series",
          disabled: true,
          hint: "Confirm replacements before adding this source.",
        };
      }
      return {
        label: "Add to series",
        disabled: false,
        hint: "Save this preview into the chosen series.",
      };
    }
    if (
      state.draft.status === "error" ||
      state.draft.status === "expired" ||
      state.draft.status === "leased"
    ) {
      return {
        label: "Review again",
        disabled: false,
        hint:
          state.draft.message ||
          "Re-prepare the original source before previewing again.",
      };
    }
    if (state.draft.status !== "ready") {
      return {
        label: "Prepare source first",
        disabled: true,
        hint: "Choose a magnet or .torrent file first.",
      };
    }
    return {
      label: "Preview series merge",
      disabled: false,
      hint: "Review episode overlap before saving.",
    };
  }
  if (
    state.draft.status === "error" ||
    state.draft.status === "expired" ||
    state.draft.status === "leased"
  ) {
    return {
      label: "Re-prepare source",
      disabled: false,
      hint: state.draft.message || "Prepare this source again.",
    };
  }
  if (state.draft.status !== "ready") {
    return {
      label: "Prepare source first",
      disabled: true,
      hint: "Choose a magnet or .torrent file first.",
    };
  }
  if (!cleanLabel(state.form.name)) {
    return {
      label: "Name this entry",
      disabled: true,
      hint: "Enter a title first.",
    };
  }
  return {
    label: "Add to library",
    disabled: false,
    hint: "Save this source and optionally start a bounded check.",
  };
}
