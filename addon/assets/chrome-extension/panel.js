import { PANEL_UPDATE_MESSAGE, MAX_TORRENT_BYTES } from "./lib/constants.js";
import {
  checkBadge,
  checkActions,
  checkDetails,
  checkSummary,
  createCheckPoller,
  isActiveCheck,
} from "./lib/checks.js";
import {
  applyFormPatch,
  createInitialState,
  needsSeriesPreview,
  parseTagsInput,
  primaryButtonSpec,
  sourceSummary,
  sourceToken,
  reviewToken,
} from "./lib/state.js";
import { encodeBytesBase64, stripTorrentExtension } from "./lib/protocol.js";
let actionBusy = false;

const refs = {
  globalAlert: document.getElementById("global-alert"),
  statusCopy: document.getElementById("status-copy"),
  statusPills: document.getElementById("status-pills"),
  retryStatus: document.getElementById("retry-status"),
  openApp: document.getElementById("open-app"),
  capturePage: document.getElementById("capture-page"),
  captureCopy: document.getElementById("capture-copy"),
  magnetInput: document.getElementById("magnet-input"),
  useMagnet: document.getElementById("use-magnet"),
  torrentDropzone: document.getElementById("torrent-dropzone"),
  torrentInput: document.getElementById("torrent-input"),
  torrentDropTitle: document.getElementById("torrent-drop-title"),
  torrentDropCopy: document.getElementById("torrent-drop-copy"),
  chooserCard: document.getElementById("chooser-card"),
  chooserCopy: document.getElementById("chooser-copy"),
  chooserList: document.getElementById("chooser-list"),
  draftCard: document.getElementById("draft-card"),
  draftSourceCopy: document.getElementById("draft-source-copy"),
  draftPill: document.getElementById("draft-pill"),
  draftMessage: document.getElementById("draft-message"),
  entryName: document.getElementById("entry-name"),
  primaryAction: document.getElementById("primary-action"),
  primaryHint: document.getElementById("primary-hint"),
  clearImport: document.getElementById("clear-import"),
  detailsToggle: document.getElementById("details-toggle"),
  typeInputs: Array.from(document.querySelectorAll('input[name="entry-type"]')),
  tagsInput: document.getElementById("tags-input"),
  tagSuggestions: document.getElementById("tag-suggestions"),
  checkAfterSave: document.getElementById("check-after-save"),
  seriesFields: document.getElementById("series-fields"),
  seriesModeInputs: Array.from(
    document.querySelectorAll('input[name="series-mode"]'),
  ),
  seriesTarget: document.getElementById("series-target"),
  seriesTargetCopy: document.getElementById("series-target-copy"),
  seasonHint: document.getElementById("season-hint"),
  duplicateCard: document.getElementById("duplicate-card"),
  duplicateList: document.getElementById("duplicate-list"),
  previewCard: document.getElementById("preview-card"),
  previewCopy: document.getElementById("preview-copy"),
  previewActions: document.getElementById("preview-actions"),
  previewAddedCount: document.getElementById("preview-added-count"),
  previewReplacedCount: document.getElementById("preview-replaced-count"),
  previewLists: document.getElementById("preview-lists"),
  replaceConsentRow: document.getElementById("replace-consent-row"),
  replaceConsent: document.getElementById("replace-consent"),
  saveCard: document.getElementById("save-card"),
  saveCopy: document.getElementById("save-copy"),
  savePill: document.getElementById("save-pill"),
  saveMessage: document.getElementById("save-message"),
  saveActions: document.getElementById("save-actions"),
  checkCard: document.getElementById("check-card"),
  checkCopy: document.getElementById("check-copy"),
  checkPill: document.getElementById("check-pill"),
  checkMessage: document.getElementById("check-message"),
  checkActions: document.getElementById("check-actions"),
  guidanceCard: document.getElementById("guidance-card"),
  guidanceCopy: document.getElementById("guidance-copy"),
  guidanceList: document.getElementById("guidance-list"),
};

let state = createInitialState();
let localNotice = null;
let persistTimer = null;
let poller = null;
let pollerKey = "";

function toneClass(tone) {
  return (
    {
      ok: "tone-ok",
      warn: "tone-warn",
      bad: "tone-bad",
      idle: "tone-accent",
      accent: "tone-accent",
    }[tone] ?? "tone-accent"
  );
}

function setHidden(element, hidden) {
  element.hidden = Boolean(hidden);
}

function setText(element, text) {
  element.textContent = text || "";
}

function setInputValue(element, value) {
  const next = value ?? "";
  if (document.activeElement !== element && element.value !== next) {
    element.value = next;
  }
}

function syncRadioGroup(inputs, value) {
  for (const input of inputs) input.checked = input.value === value;
}

function replaceChildren(element, nodes) {
  element.replaceChildren(...nodes);
}

function pill(label, tone = "accent") {
  const node = document.createElement("span");
  node.className = `pill ${toneClass(tone)}`;
  node.textContent = label;
  return node;
}

function actionButton(label, kind, onClick, disabled = actionBusy) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = kind;
  button.textContent = label;
  button.disabled = disabled;
  button.addEventListener("click", onClick);
  return button;
}

function formatEpisode(item) {
  const season = String(item?.season ?? 0).padStart(2, "0");
  const episode = String(item?.episode ?? 0).padStart(2, "0");
  return `S${season}E${episode}`;
}

function currentCheck() {
  return state.save.check ?? state.save.entry?.sourceCheck ?? null;
}

function isLocked() {
  return (
    actionBusy ||
    state.save.status === "saving" ||
    state.save.status === "retry" ||
    state.draft.status === "preparing" ||
    state.preview.status === "loading"
  );
}

function draftStatusTone() {
  if (state.preview.status === "ready") return "ok";
  if (state.preview.status === "loading") return "warn";
  if (state.preview.status === "error" || state.preview.status === "expired") {
    return "bad";
  }
  if (state.draft.status === "ready") return "ok";
  if (state.draft.status === "error" || state.draft.status === "expired")
    return "bad";
  if (state.draft.status === "leased") return "warn";
  if (state.draft.status === "preparing") return "warn";
  if (state.source.kind === "torrent-link-hint") return "warn";
  return "accent";
}

function draftStatusLabel() {
  if (state.preview.status === "ready") return "Preview ready";
  if (state.preview.status === "loading") return "Reviewing";
  if (state.preview.status === "error" || state.preview.status === "expired") {
    return "Review expired";
  }
  if (state.draft.status === "ready") return "Prepared";
  if (state.draft.status === "preparing") return "Preparing";
  if (state.draft.status === "expired") return "Draft expired";
  if (state.draft.status === "error") return "Needs attention";
  if (state.draft.status === "leased") return "Preview reserved";
  if (state.source.kind === "torrent-link-hint") return "Download first";
  if (state.source.kind === "magnet") return "Magnet chosen";
  if (state.source.kind === "torrent-file") return "File chosen";
  return "Waiting";
}

function statusCopy() {
  if (state.status.connected && state.status.engineReady) {
    return "Connected to HoshiStream on this Mac. Saving is ready, and playback checks can start.";
  }
  if (state.status.connected && !state.status.engineReady) {
    return "Connected to HoshiStream. Saving works now; playback checks wait until the engine is ready.";
  }
  if (!state.status.connected && !state.status.canStartApp) {
    return (
      state.status.message ||
      "Start the local HoshiStream development server, then retry from this panel."
    );
  }
  return (
    state.status.message ||
    "Open HoshiStream on this Mac, then retry from this panel."
  );
}

function captureCopy() {
  if (state.capture.message) return state.capture.message;
  if (state.source.kind === "torrent-link-hint") {
    return "This page pointed to a .torrent download. Let Chrome download it normally, then choose that file here.";
  }
  if (state.source.kind === "magnet") {
    return "The prepared magnet stays local to this browser and HoshiStream.";
  }
  if (state.source.kind === "torrent-file") {
    return "Only the bytes from the file you chose are sent to HoshiStream.";
  }
  return "Use the toolbar button on the active tab before Capture page links if Chrome asks for page access.";
}

function guidanceContent() {
  if (state.status.connected) return null;
  const items = ["Open or restart HoshiStream on this Mac."];
  if (state.status.canStartApp) {
    items.push("Use Open HoshiStream here, then retry the same action.");
  } else {
    items.push(
      "This build cannot launch a dev server for you. Start it manually, then retry.",
    );
  }
  if (state.status.code === "native_host_unavailable") {
    items.push(
      "If you are developing locally, reload the unpacked extension after HoshiStream registers the native helper.",
    );
  }
  items.push("No browser tokens or local ports are needed in the extension.");
  return {
    copy:
      state.status.code === "native_host_unavailable"
        ? "Chrome cannot reach the private HoshiStream helper yet."
        : "The companion stays local and expects the HoshiStream app on this same computer.",
    items,
  };
}

function renderStatus() {
  replaceChildren(refs.statusPills, [
    pill(
      state.status.connected ? "Connected" : "Offline",
      state.status.connected ? "ok" : "bad",
    ),
    pill(
      state.status.engineReady ? "Engine ready" : "Engine waiting",
      state.status.engineReady ? "ok" : "warn",
    ),
  ]);
  setText(refs.statusCopy, statusCopy());
  setHidden(
    refs.statusCopy,
    state.status.connected && state.status.engineReady,
  );
  refs.retryStatus.disabled = actionBusy || state.status.phase === "loading";
  refs.openApp.disabled = actionBusy || state.status.phase === "loading";
  setHidden(refs.openApp, state.status.connected || !state.status.canStartApp);
}

function renderCapture() {
  setText(refs.captureCopy, captureCopy());
  setHidden(
    refs.captureCopy,
    !state.capture.message && state.source.kind === "none",
  );
  setInputValue(refs.magnetInput, state.editor.magnetText);
  refs.capturePage.disabled = isLocked();
  refs.useMagnet.disabled = isLocked() || !state.editor.magnetText.trim();
  refs.magnetInput.disabled = isLocked();
  refs.torrentInput.disabled = isLocked();
  refs.torrentDropzone.classList.toggle("dragging", false);

  if (state.source.kind === "torrent-file") {
    setText(
      refs.torrentDropTitle,
      state.source.fileName || "Choose or drop a .torrent file",
    );
    setText(
      refs.torrentDropCopy,
      "Protected or signed download links should be saved by Chrome first, then chosen here.",
    );
  } else if (state.source.kind === "torrent-link-hint") {
    setText(
      refs.torrentDropTitle,
      state.source.fileName || "Choose the .torrent file you just downloaded",
    );
    setText(
      refs.torrentDropCopy,
      "This companion never fetches the page's protected .torrent URL itself.",
    );
  } else {
    setText(refs.torrentDropTitle, "Choose or drop a .torrent file");
    setText(
      refs.torrentDropCopy,
      `Up to ${Math.round(MAX_TORRENT_BYTES / 1_000_000)} MB. Only your selected file is sent.`,
    );
  }
}

function renderChooser() {
  setHidden(refs.chooserCard, state.capture.status !== "ready");
  if (state.capture.status !== "ready") return;
  setText(refs.chooserCopy, state.capture.message || "Choose one source.");
  const items = state.capture.candidates.map((candidate) => {
    const wrapper = document.createElement("div");
    wrapper.className = "list-item";
    const text = document.createElement("div");
    const strong = document.createElement("strong");
    strong.textContent = candidate.label;
    const subtle = document.createElement("span");
    subtle.className = "subtle";
    subtle.textContent = candidate.secondary;
    text.append(strong, subtle);
    const button = actionButton(
      candidate.kind === "magnet" ? "Use magnet" : "Use download hint",
      candidate.kind === "magnet" ? "primary" : "secondary",
      () => runRequest("panel:selectCapture", { candidateId: candidate.id }),
      isLocked(),
    );
    wrapper.append(text, button);
    return wrapper;
  });
  replaceChildren(refs.chooserList, items);
}

function renderDraft() {
  const visible =
    state.source.kind !== "none" ||
    state.draft.status !== "idle" ||
    state.preview.status !== "idle";
  setHidden(refs.draftCard, !visible);
  if (!visible) return;

  refs.draftPill.className = `pill ${toneClass(draftStatusTone())}`;
  refs.draftPill.textContent = draftStatusLabel();
  setText(
    refs.draftSourceCopy,
    sourceSummary(state.source) || "Choose a local source to begin.",
  );
  const draftMessage =
    state.draft.message ||
    (state.preview.status === "ready"
      ? "This explicit preview already consumed the prepared draft. Save it, review again, or cancel it before changing course."
      : null) ||
    (state.source.kind === "torrent-link-hint"
      ? "Download the .torrent file in Chrome first, then choose that file here."
      : state.draft.status === "ready"
        ? "Review the name, destination, and optional source check before saving."
        : "");
  setText(refs.draftMessage, draftMessage);

  setInputValue(refs.entryName, state.form.name);
  refs.entryName.disabled = isLocked();
  refs.clearImport.disabled = isLocked();

  refs.detailsToggle.open = Boolean(state.form.detailsOpen);
  syncRadioGroup(refs.typeInputs, state.form.type);
  for (const input of refs.typeInputs) input.disabled = isLocked();
  setInputValue(refs.tagsInput, state.form.tagsText);
  refs.tagsInput.disabled = isLocked();
  refs.checkAfterSave.checked = Boolean(state.form.checkAfterSave);
  refs.checkAfterSave.disabled = isLocked();

  const primary = primaryButtonSpec(state);
  refs.primaryAction.textContent = primary.label;
  refs.primaryAction.disabled = primary.disabled || actionBusy;
  setText(refs.primaryHint, primary.hint);

  renderTagSuggestions();
  renderSeriesFields();
  renderDuplicates();
  renderPreview();
}

function renderTagSuggestions() {
  const currentTags = new Set(
    parseTagsInput(state.form.tagsText).map((tag) => tag.toLowerCase()),
  );
  const items = (state.catalog.tags ?? [])
    .filter((tag) => !currentTags.has(tag.name.toLowerCase()))
    .slice(0, 8)
    .map((tag) => {
      const button = actionButton(
        `${tag.name} · ${tag.count}`,
        "ghost",
        () => {
          const tags = parseTagsInput(state.form.tagsText);
          tags.push(tag.name);
          state = applyFormPatch(state, {
            tagsText: Array.from(new Set(tags.map((name) => name.trim()))).join(
              ", ",
            ),
          });
          render();
          queuePersist();
        },
        isLocked(),
      );
      button.classList.add("chip");
      return button;
    });
  replaceChildren(refs.tagSuggestions, items);
}

function renderSeriesFields() {
  const visible = state.form.type === "series";
  setHidden(refs.seriesFields, !visible);
  if (!visible) return;
  syncRadioGroup(refs.seriesModeInputs, state.form.seriesMode);
  for (const input of refs.seriesModeInputs) input.disabled = isLocked();
  const series = Array.isArray(state.catalog.series)
    ? state.catalog.series
    : [];
  const options = [];
  const placeholder = document.createElement("option");
  placeholder.value = "";
  placeholder.textContent = series.length
    ? "Choose an inspected series"
    : "No series available yet";
  options.push(placeholder);
  for (const entry of series) {
    const option = document.createElement("option");
    option.value = entry.id;
    option.textContent = entry.inspected
      ? `${entry.name} · ${entry.sourceCount} source${entry.sourceCount === 1 ? "" : "s"}`
      : `${entry.name} · inspect in HoshiStream first`;
    option.disabled = !entry.inspected;
    options.push(option);
  }
  replaceChildren(refs.seriesTarget, options);
  refs.seriesTarget.value = state.form.targetEntryId || "";
  refs.seriesTarget.disabled =
    isLocked() || state.form.seriesMode !== "existing";
  setInputValue(refs.seasonHint, state.form.seasonHint);
  refs.seasonHint.disabled = isLocked() || state.form.seriesMode !== "existing";
  const uninspectedCount = series.filter((entry) => !entry.inspected).length;
  setText(
    refs.seriesTargetCopy,
    state.form.seriesMode !== "existing"
      ? "Create a new series entry from this prepared source."
      : uninspectedCount
        ? `Only inspected targets can be previewed here. ${uninspectedCount} series still need inspection in HoshiStream.`
        : "Pick the inspected series that should receive these episodes.",
  );
}

function renderDuplicates() {
  const visible =
    state.draft.status === "ready" && state.draft.existingEntries.length > 0;
  setHidden(refs.duplicateCard, !visible);
  if (!visible) return;
  const items = state.draft.existingEntries.map((entry) => {
    const wrapper = document.createElement("div");
    wrapper.className = "list-item";
    const text = document.createElement("div");
    const strong = document.createElement("strong");
    strong.textContent = entry.name;
    const subtle = document.createElement("span");
    subtle.className = "subtle";
    subtle.textContent =
      entry.type === "series"
        ? "Existing series entry"
        : "Existing movie entry";
    text.append(strong, subtle);
    wrapper.append(
      text,
      actionButton("Open", "secondary", () =>
        runRequest("panel:openEntry", { entryId: entry.id }),
      ),
    );
    return wrapper;
  });
  replaceChildren(refs.duplicateList, items);
}

function previewCopy() {
  if (state.preview.status === "loading")
    return "Building an explicit episode preview…";
  if (state.preview.status === "error" || state.preview.status === "expired") {
    return state.preview.message;
  }
  if (state.preview.status === "ready") {
    return `${state.preview.entryName} will receive these episodes only after you confirm the preview.`;
  }
  return "Choose an inspected series target, then preview additions and overlaps before saving.";
}

function renderPreview() {
  const visible = needsSeriesPreview(state) || state.preview.status !== "idle";
  setHidden(refs.previewCard, !visible);
  if (!visible) return;
  setText(refs.previewCopy, previewCopy());
  setText(
    refs.previewAddedCount,
    String(state.preview.addedEpisodes?.length ?? 0),
  );
  setText(
    refs.previewReplacedCount,
    String(state.preview.replacements?.length ?? 0),
  );
  const columns = [];
  if (state.preview.status === "ready") {
    const additions = document.createElement("div");
    additions.className = "preview-list";
    const additionsHeading = document.createElement("strong");
    additionsHeading.textContent = "Episodes to add";
    additions.append(additionsHeading);
    const additionList = document.createElement("ul");
    for (const item of state.preview.addedEpisodes.slice(0, 8)) {
      const li = document.createElement("li");
      li.textContent = `${formatEpisode(item)} · ${item.path}`;
      additionList.append(li);
    }
    if (!additionList.children.length) {
      const li = document.createElement("li");
      li.textContent = "No new episodes were detected in this preview.";
      additionList.append(li);
    }
    additions.append(additionList);
    columns.push(additions);

    const replacements = document.createElement("div");
    replacements.className = "preview-list";
    const replacementHeading = document.createElement("strong");
    replacementHeading.textContent = "Overlapping episodes";
    replacements.append(replacementHeading);
    const replacementList = document.createElement("ul");
    for (const item of state.preview.replacements.slice(0, 8)) {
      const li = document.createElement("li");
      li.textContent = `${formatEpisode(item)} · ${item.previousPath} → ${item.incomingPath}`;
      replacementList.append(li);
    }
    if (!replacementList.children.length) {
      const li = document.createElement("li");
      li.textContent = "No existing episodes would be replaced.";
      replacementList.append(li);
    }
    replacements.append(replacementList);
    columns.push(replacements);
  }
  replaceChildren(refs.previewLists, columns);
  const actions = [];
  if (state.preview.status === "ready") {
    actions.push(
      actionButton(
        "Review again",
        "secondary",
        () => runRequest("panel:reviewSeriesAgain"),
        isLocked(),
      ),
      actionButton(
        "Cancel preview",
        "ghost",
        () => runRequest("panel:cancelPreview"),
        isLocked(),
      ),
    );
  }
  replaceChildren(refs.previewActions, actions);
  const needsConsent =
    state.preview.status === "ready" && state.preview.replacements.length > 0;
  setHidden(refs.replaceConsentRow, !needsConsent);
  refs.replaceConsent.checked = Boolean(state.form.replaceConsent);
  refs.replaceConsent.disabled = isLocked();
}

function saveTone() {
  if (state.save.status === "retry") return "warn";
  if (state.save.status === "error") return "bad";
  if (state.save.outcome === "existing") return "warn";
  if (state.save.status === "saved") return "ok";
  return "accent";
}

function saveLabel() {
  if (state.save.status === "retry") return "Retry saved add";
  if (state.save.status === "error") return "Save failed";
  if (state.save.outcome === "existing") return "Already saved";
  if (state.save.outcome === "appended") return "Series updated";
  if (state.save.status === "saved") return "Saved";
  return "Waiting";
}

function renderSave() {
  const visible = state.save.status !== "idle";
  setHidden(refs.saveCard, !visible);
  if (!visible) return;
  refs.savePill.className = `pill ${toneClass(saveTone())}`;
  refs.savePill.textContent = saveLabel();
  setText(
    refs.saveCopy,
    state.save.entry
      ? `${state.save.entry.name} · ${state.save.entry.type === "series" ? "Series" : "Movie"}`
      : "This panel keeps saved results separate from source-check status.",
  );
  setText(refs.saveMessage, state.save.message || "");

  const buttons = [];
  if (state.save.status === "retry") {
    buttons.push(
      actionButton("Retry same add", "primary", () =>
        runRequest("panel:primaryAction"),
      ),
    );
  }
  if (state.save.entry) {
    buttons.push(
      actionButton(
        state.save.outcome === "existing"
          ? "Open existing"
          : "Open in HoshiStream",
        "secondary",
        () => runRequest("panel:openEntry", { entryId: state.save.entry.id }),
      ),
    );
  }
  replaceChildren(refs.saveActions, buttons);
  renderCheck();
}

function renderCheck() {
  const entry = state.save.entry;
  setHidden(refs.checkCard, !entry);
  if (!entry) return;
  const check = currentCheck();
  const badge = checkBadge(check);
  refs.checkPill.className = `pill ${toneClass(badge.tone)}`;
  refs.checkPill.textContent = badge.label;
  setText(
    refs.checkCopy,
    state.save.checkError
      ? "Saved, but the follow-up check could not start automatically."
      : checkDetails(check) ||
          "Source checks keep metadata and sample evidence separate from browser support.",
  );
  setText(
    refs.checkMessage,
    state.save.checkError?.message || checkSummary(check, entry.type),
  );

  const actions = checkActions(check).map(({ label, command, payload }) =>
    actionButton(
      label,
      command === "panel:cancelCheck" ? "ghost" : "secondary",
      () => runRequest(command, payload),
    ),
  );
  replaceChildren(refs.checkActions, actions);
}

function renderGuidance() {
  const guidance = guidanceContent();
  setHidden(refs.guidanceCard, !guidance);
  if (!guidance) return;
  setText(refs.guidanceCopy, guidance.copy);
  replaceChildren(
    refs.guidanceList,
    guidance.items.map((item) => {
      const li = document.createElement("li");
      li.textContent = item;
      return li;
    }),
  );
}

function renderNotice() {
  if (!localNotice?.message) {
    setHidden(refs.globalAlert, true);
    setText(refs.globalAlert, "");
    refs.globalAlert.className = "notice notice-bad";
    return;
  }
  refs.globalAlert.className = `notice ${localNotice.tone === "bad" ? "notice-bad" : "notice-bad"}`;
  setText(refs.globalAlert, localNotice.message);
  setHidden(refs.globalAlert, false);
}

function syncPoller() {
  const entry = state.save.entry;
  const check = currentCheck();
  const key = entry?.id ?? "";
  if (!entry || !isActiveCheck(check)) {
    if (poller) poller.stop();
    poller = null;
    pollerKey = "";
    return;
  }
  if (!poller || pollerKey !== key) {
    if (poller) poller.stop();
    pollerKey = key;
    poller = createCheckPoller(
      async () => {
        const nextState = await sendMessage("panel:getCheck");
        state = nextState;
        render();
        return (
          nextState.save.check ??
          nextState.save.entry?.sourceCheck ?? { phase: "unchecked" }
        );
      },
      (report) => {
        state = {
          ...state,
          save: {
            ...state.save,
            check: report,
            entry: state.save.entry
              ? { ...state.save.entry, sourceCheck: report }
              : state.save.entry,
          },
        };
        render();
      },
      {
        onError: (error) => {
          localNotice = { tone: "bad", message: error.message };
          renderNotice();
        },
      },
    );
  }
  poller.update(check);
}

function render() {
  renderNotice();
  renderStatus();
  renderCapture();
  renderChooser();
  renderDraft();
  renderSave();
  renderGuidance();
  syncPoller();
}

async function sendMessage(type, payload) {
  const response = await chrome.runtime.sendMessage({ type, payload });
  if (!response?.ok) {
    const error = new Error(response?.error?.message || "The request failed.");
    error.code = response?.error?.code || "request_failed";
    throw error;
  }
  return response.state ?? state;
}

async function runRequest(type, payload) {
  if (actionBusy) return null;
  actionBusy = true;
  localNotice = null;
  render();
  try {
    if (
      ["panel:primaryAction", "panel:reviewSeriesAgain"].includes(type) &&
      state.save.status !== "retry"
    ) {
      clearTimeout(persistTimer);
      state = await persistDraftFields();
    }
    if (type === "panel:primaryAction")
      payload = { ...payload, reviewToken: reviewToken(state) };
    if (type === "panel:refreshStatus") {
      state = { ...state, status: { ...state.status, phase: "loading" } };
      render();
    }
    if (type === "panel:startApp") {
      state = { ...state, status: { ...state.status, phase: "loading" } };
      render();
    }
    if (type === "panel:captureActiveTab") {
      state = {
        ...state,
        capture: {
          status: "loading",
          candidates: [],
          message: "Reading the active page…",
        },
      };
      render();
    }
    if (type === "panel:prepareMagnet") {
      state = {
        ...state,
        draft: {
          ...state.draft,
          status: "preparing",
          message: "Preparing source…",
        },
      };
      render();
    }
    if (type === "panel:prepareTorrent") {
      state = {
        ...state,
        draft: {
          ...state.draft,
          status: "preparing",
          message: "Preparing source…",
        },
      };
      render();
    }
    if (type === "panel:reviewSeriesAgain") {
      state = {
        ...state,
        draft: {
          ...state.draft,
          status: "preparing",
          message: "Preparing source…",
        },
        preview: {
          ...state.preview,
          status: "loading",
          message: "Reviewing episode overlap…",
        },
      };
      render();
    }
    if (type === "panel:cancelPreview") {
      state = {
        ...state,
        preview: {
          ...state.preview,
          status: "expired",
          message:
            "Re-prepare the original source before requesting a fresh preview or save.",
        },
      };
      render();
    }
    if (type === "panel:primaryAction") {
      const primary = primaryButtonSpec(state);
      if (primary.label.includes("Retry same add")) {
        state = {
          ...state,
          save: {
            ...state.save,
            status: "saving",
            message: "Retrying the original add…",
          },
        };
      } else if (primary.label.includes("Re-prepare")) {
        state = {
          ...state,
          draft: {
            ...state.draft,
            status: "preparing",
            message: "Preparing source…",
          },
        };
      } else if (primary.label.includes("Review again")) {
        state = {
          ...state,
          draft: {
            ...state.draft,
            status: "preparing",
            message: "Preparing source…",
          },
          preview: {
            ...state.preview,
            status: "loading",
            message: "Reviewing episode overlap…",
          },
        };
      } else if (primary.label.includes("Preview")) {
        state = {
          ...state,
          preview: {
            ...state.preview,
            status: "loading",
            message: "Reviewing episode overlap…",
          },
        };
      } else {
        state = {
          ...state,
          save: {
            ...state.save,
            status: "saving",
            message: "Waiting for HoshiStream…",
          },
        };
      }
      render();
    }
    state = await sendMessage(type, payload);
    render();
    return state;
  } catch (error) {
    localNotice = { tone: "bad", message: error.message };
    try {
      state = await sendMessage("panel:bootstrap");
    } catch {
      localNotice.message +=
        " The panel could not reconnect. Reopen it to recover the current import before retrying.";
    }
    render();
    return null;
  } finally {
    actionBusy = false;
    render();
  }
}

function persistDraftFields() {
  return sendMessage("panel:updateDraftFields", {
    sourceToken: sourceToken(state),
    form: {
      name: state.form.name,
      suggestedName: state.form.suggestedName,
      type: state.form.type,
      tagsText: state.form.tagsText,
      detailsOpen: state.form.detailsOpen,
      seriesMode: state.form.seriesMode,
      targetEntryId: state.form.targetEntryId,
      seasonHint: state.form.seasonHint,
      checkAfterSave: state.form.checkAfterSave,
      replaceConsent: state.form.replaceConsent,
    },
    editor: { magnetText: state.editor.magnetText },
  });
}

function queuePersist() {
  clearTimeout(persistTimer);
  persistTimer = setTimeout(() => {
    void persistDraftFields().catch((error) => {
      localNotice = { tone: "bad", message: error.message };
      renderNotice();
    });
  }, 180);
}

async function handleTorrentFile(file) {
  if (!file) return;
  localNotice = null;
  if (!file.name.toLowerCase().endsWith(".torrent")) {
    localNotice = { tone: "bad", message: "Choose a .torrent file." };
    render();
    refs.torrentInput.value = "";
    return;
  }
  if (file.size > MAX_TORRENT_BYTES) {
    localNotice = {
      tone: "bad",
      message: "Choose a valid .torrent file no larger than 1 MB.",
    };
    render();
    refs.torrentInput.value = "";
    return;
  }
  const bytes = new Uint8Array(await file.arrayBuffer());
  await runRequest("panel:prepareTorrent", {
    fileName: file.name,
    bytesBase64: encodeBytesBase64(bytes),
    titleSuggestion: stripTorrentExtension(file.name),
  });
  refs.torrentInput.value = "";
}

refs.retryStatus.addEventListener("click", () =>
  runRequest("panel:refreshStatus"),
);
refs.openApp.addEventListener("click", () => runRequest("panel:startApp"));
refs.capturePage.addEventListener("click", () =>
  runRequest("panel:captureActiveTab"),
);
refs.useMagnet.addEventListener("click", () =>
  runRequest("panel:prepareMagnet", { magnetUri: state.editor.magnetText }),
);
refs.clearImport.addEventListener("click", () =>
  runRequest("panel:discardImport"),
);
refs.primaryAction.addEventListener("click", () =>
  runRequest("panel:primaryAction"),
);
refs.magnetInput.addEventListener("input", (event) => {
  state = {
    ...state,
    editor: { ...state.editor, magnetText: event.target.value },
  };
  render();
  queuePersist();
});
refs.entryName.addEventListener("input", (event) => {
  state = applyFormPatch(state, { name: event.target.value });
  render();
  queuePersist();
});
refs.tagsInput.addEventListener("input", (event) => {
  state = applyFormPatch(state, { tagsText: event.target.value });
  render();
  queuePersist();
});
refs.detailsToggle.addEventListener("toggle", () => {
  state = applyFormPatch(state, { detailsOpen: refs.detailsToggle.open });
  render();
  queuePersist();
});
for (const input of refs.typeInputs) {
  input.addEventListener("change", (event) => {
    state = applyFormPatch(state, { type: event.target.value });
    render();
    queuePersist();
  });
}
refs.checkAfterSave.addEventListener("change", (event) => {
  state = applyFormPatch(state, { checkAfterSave: event.target.checked });
  render();
  queuePersist();
});
for (const input of refs.seriesModeInputs) {
  input.addEventListener("change", (event) => {
    state = applyFormPatch(state, { seriesMode: event.target.value });
    render();
    queuePersist();
  });
}
refs.seriesTarget.addEventListener("change", (event) => {
  state = applyFormPatch(state, { targetEntryId: event.target.value });
  render();
  queuePersist();
});
refs.seasonHint.addEventListener("input", (event) => {
  state = applyFormPatch(state, { seasonHint: event.target.value });
  render();
  queuePersist();
});
refs.replaceConsent.addEventListener("change", (event) => {
  state = applyFormPatch(state, { replaceConsent: event.target.checked });
  render();
  queuePersist();
});
refs.torrentInput.addEventListener("change", (event) => {
  void handleTorrentFile(event.target.files?.[0]);
});
refs.torrentDropzone.addEventListener("dragover", (event) => {
  event.preventDefault();
  refs.torrentDropzone.classList.add("dragging");
});
refs.torrentDropzone.addEventListener("dragleave", () => {
  refs.torrentDropzone.classList.remove("dragging");
});
refs.torrentDropzone.addEventListener("drop", (event) => {
  event.preventDefault();
  refs.torrentDropzone.classList.remove("dragging");
  void handleTorrentFile(event.dataTransfer?.files?.[0]);
});

chrome.runtime.onMessage.addListener((message) => {
  if (message?.type !== PANEL_UPDATE_MESSAGE) return;
  void sendMessage("panel:bootstrap").then((nextState) => {
    state = nextState;
    render();
  });
});

void sendMessage("panel:bootstrap")
  .then((nextState) => {
    state = nextState;
    render();
  })
  .catch((error) => {
    localNotice = { tone: "bad", message: error.message };
    render();
  });
