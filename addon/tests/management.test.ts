import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore plain browser ES module shared with the management UI
import { classifyLibraryImports } from "../assets/manage/classify-imports.js";
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore plain browser ES module shared with the management UI
import {
  closeDetailRoute,
  entryRouteId,
} from "../assets/manage/entry-route.js";
import { managementHtml } from "../src/management.ts";

const asset = (name: string) =>
  readFile(new URL(`../assets/manage/${name}`, import.meta.url), "utf8");

describe("management page shell", () => {
  it("links only static assets and contains no inline code or secrets", () => {
    expect(managementHtml).toContain(
      '<link rel="stylesheet" href="/manage-assets/styles.css" />',
    );
    expect(managementHtml).toContain(
      '<script type="module" src="/manage-assets/app.js"></script>',
    );
    expect(managementHtml).toContain('<div id="app">');
    expect(managementHtml).toContain('<div id="toast" class="toast">');
    // Navigation is rendered by the preact app, not the HTML shell.
    expect(managementHtml).not.toContain("data-view");
    expect(managementHtml).not.toContain("Settings");
    expect(managementHtml).not.toContain("<style>");
    expect(managementHtml).not.toMatch(/<script>[^<]/);
    expect(managementHtml).not.toContain("ACCESS_TOKEN");
  });
});

describe("management assets", () => {
  it("app module wires the sidebar shell, router, and entry sheet", async () => {
    const appJs = await asset("app.js");
    expect(appJs).toContain('from "./vendor/preact-htm.js"');
    expect(appJs).toContain('import { api, notify } from "./api.js"');
    expect(appJs).toContain('import { LibraryView } from "./views/library.js"');
    expect(appJs).toContain(
      'import { AddSheet, openAdd } from "./views/add.js"',
    );
    // Add Media is a modal, not a sidebar destination.
    expect(appJs).not.toContain('"Add Media"');
    expect(appJs).toContain('if (name === "add")');
    expect(appJs).toContain('import { StatusView } from "./views/status.js"');
    expect(appJs).toContain(
      'import { ActivityView } from "./views/activity.js"',
    );
    expect(appJs).toContain('import { StorageView } from "./views/storage.js"');
    expect(appJs).toContain('import { TagsView } from "./views/tags.js"');
    expect(appJs).toContain('["tags", "⌗", "Tags"]');
    expect(appJs).not.toContain("views/system.js");
    expect(appJs).toContain('import { DetailSheet } from "./views/detail.js"');
    expect(appJs).toContain("startActivityPolling");
    // Bookmarks and HUD links from the merged System page land on the split
    // pages; analysis now lives on the Library page.
    expect(appJs).toContain('"system/health": "status"');
    expect(appJs).toContain('"system/devices": "activity"');
    expect(appJs).toContain('"system/repair": "activity/repair"');
    expect(appJs).toContain('"system/storage": "storage"');
    expect(appJs).toContain('"system/analysis": "library/analysis"');
    expect(appJs).not.toContain('"#/system');
    expect(appJs).toContain('href="#/activity/repair"');
    expect(appJs).toContain("hashchange");
    expect(appJs).toContain('location.hash.startsWith("#/entry/")');
    expect(appJs).toContain("This entry link is invalid.");
    expect(appJs).toContain("const openRoutedEntry = async () => {");
    expect(appJs).toContain('tab: "playback"');
    expect(appJs).toContain("error.status === 404");
    expect(appJs).not.toContain("ACCESS_TOKEN");
  });

  it("sidebar HUD surfaces health, playback, copies, and drive issues", async () => {
    const appJs = await asset("app.js");
    expect(appJs).toContain("TorrServer offline");
    expect(appJs).toContain("activity.jobs.slice(0, 3)");
    expect(appJs).toContain("Drive offline");
    expect(appJs).toContain("playback falls back to torrent");
    expect(appJs).toContain("hud-bar");
    const storeJs = await asset("store.js");
    expect(storeJs).toContain('api("disk-jobs")');
    expect(storeJs).toContain('api("playback")');
    expect(storeJs).toContain('api("volumes")');
    expect(storeJs).toContain("document.hidden");
  });

  it("api module wires the token and bearer auth", async () => {
    const apiJs = await asset("api.js");
    expect(apiJs).toContain('Authorization: "Bearer " + token');
    expect(apiJs).toContain('fetch("/api/" + path');
    expect(apiJs).toContain("location.pathname.split");
    expect(apiJs).not.toContain("ACCESS_TOKEN");
  });

  it("library view covers grid, import/export, and Stremio refresh", async () => {
    const libraryJs = await asset("views/library.js");
    expect(libraryJs).toContain("Refresh Stremio");
    expect(libraryJs).toContain("Export JSON");
    expect(libraryJs).toContain("Import JSON");
    expect(libraryJs).toContain("Choose titles to add");
    expect(libraryJs).toContain('link.download = "hoshistream-library.json"');
    expect(libraryJs).toContain("does not include managed .torrent files");
    expect(libraryJs).toContain("JSON alone is not a portable backup");
    expect(libraryJs).toContain(
      "For a full backup, copy library.json and the managed media folder",
    );
    expect(libraryJs).toMatch(
      /\(\{\s*torrentFilePath,\s*localFilePath,\s*localFolderPath,\s*searchImport,\s*searchReceipts,\s*sourceHash,\s*sourceCheck,\s*\.\.\.details,?\s*\}\)/,
    );
    expect(libraryJs).toMatch(
      /const \{\s*id,\s*createdAt,\s*updatedAt,\s*source,\s*managedMedia,\s*searchImport,\s*searchReceipts,\s*sourceHash,\s*sourceCheck,\s*\.\.\.input,?\s*\} = entry/,
    );
    expect(libraryJs).toContain("stripServerMetadata({");
    expect(libraryJs).toContain("JSON.stringify(stripServerMetadata(input))");
    expect(libraryJs).toContain("extraSources: details.extraSources.map(");
    expect(libraryJs).toContain(
      "additionalSourceImportProblems(candidate.entry)",
    );
    expect(libraryJs).toContain(
      "blocked: candidate.blocked || sourceProblems.length > 0",
    );
    expect(libraryJs).toContain("No import conflicts");
    expect(libraryJs).toMatch(
      /candidates = classifyLibraryImports\(\s*JSON\.parse\(await file\.text\(\)\),\s*state\.entries,\s*\)\.map/,
    );
    expect(libraryJs.split("async function reviewImport")[0]).not.toContain(
      "additionalSourceImportProblems(candidate.entry)",
    );
    expect(libraryJs).toContain('api("stremio-refresh", { method: "POST" })');
    expect(libraryJs).toContain('location.href = "stremio:///board"');
    expect(libraryJs).toContain("Copy add-on URL");
    expect(libraryJs).toContain('role="dialog"');
    expect(libraryJs).toContain('e.key === "Escape"');
    expect(libraryJs).toContain(
      'import { classifyLibraryImports } from "../classify-imports.js"',
    );
    expect(libraryJs).toContain("routedEntryId || entryRouteError");
    expect(libraryJs).toContain("Opening entry…");
    expect(libraryJs).toContain("Entry ID:");
  });

  it("add modal uploads torrents and media through the API", async () => {
    const addJs = await asset("views/add.js");
    expect(addJs).toContain("export function AddSheet");
    expect(addJs).toContain('class="modal-backdrop add-backdrop"');
    expect(addJs).toContain('if (event.key === "Escape")');
    expect(addJs).toContain("requestClose()");
    expect(addJs).toContain("/api/torrent-upload");
    expect(addJs).toContain("/api/upload?batch=");
    expect(addJs).toContain("webkitdirectory");
    expect(addJs).toContain("manualSubmission(");
    expect(addJs).toContain("new FormData(e.target)");
    expect(addJs).toContain("Inspect and check after saving");
    expect(addJs).toContain("Could not confirm whether the entry was saved");
    expect(addJs).toContain(
      "Choose a folder with at least one playable video file",
    );
    expect(addJs).toContain("Add to library");
    expect(addJs).toContain("<${SourceCheckPanel}");
    expect(addJs).not.toContain("SearchMedia");
  });

  it("scraps search import UI while keeping manual add and source-check flows", async () => {
    const [addJs, storeJs, detailJs, sourceCheckJs] = await Promise.all([
      asset("views/add.js"),
      asset("store.js"),
      asset("views/detail.js"),
      asset("components/source-check.js"),
    ]);
    expect(addJs).not.toContain('["search", null, "Search"]');
    expect(addJs).not.toContain("<${SearchMedia}");
    expect(addJs).not.toContain('source === "search"');
    expect(addJs).toContain("manualSubmission(");
    expect(storeJs).toContain('source: "torrent"');
    expect(detailJs).toContain('from "../import-state.js"');
    expect(detailJs).toContain("closeDetailRoute()");
    expect(detailJs).toContain("location.replace(next)");
    expect(sourceCheckJs).toContain(
      "value.sourceHash ?? value.searchImport?.hash",
    );
    expect(sourceCheckJs).toContain("entry?.sourceHash ??");
  });

  it("add sheet traps and restores focus and guards every dismiss action", async () => {
    const addJs = await asset("views/add.js");
    expect(addJs).toContain('event.key === "Tab"');
    expect(addJs).toContain(
      'document.addEventListener("focusin", containFocus)',
    );
    expect(addJs).toContain(
      'document.removeEventListener("focusin", containFocus)',
    );
    expect(addJs).toContain("returnFocus.focus({ preventScroll: true })");
    expect(addJs).toContain("if (mayLeave()) closeAdd()");
    expect(addJs).toContain("disabled=${pending}");
    expect(addJs).toContain('role="tabpanel"');
    expect(addJs).toContain('event.key === "ArrowRight"');
    expect(addJs).toContain('event.key === "ArrowLeft"');
  });

  it("add modal offers native linking only when the picker is available", async () => {
    const addJs = await asset("views/add.js");
    expect(addJs).toContain("status.nativePicker");
    expect(addJs).toContain("Choose on this computer");
    expect(addJs).toContain("nativePathGrant: picked.grant");
    expect(addJs).toContain('"native-picker/"');
  });

  it("detail view keeps inspection, mapping, and playback flows", async () => {
    const detailJs = await asset("views/detail.js");
    expect(detailJs).toContain('method: "PATCH"');
    expect(detailJs).toContain(
      "extraSources: extraSources.map(editableSource)",
    );
    expect(detailJs).toContain("Save mapping");
    expect(detailJs).toContain("Open direct stream");
    expect(detailJs).toContain("Source check");
    expect(detailJs).toContain("run a check or automatically assess playback");
    expect(detailJs).toContain('from "../components/source-check.js"');
    expect(detailJs).toContain('class="kv');
    expect(detailJs).toContain("Open the entry and review its source check");
    expect(detailJs).toContain("Inspecting…");
    expect(detailJs).toContain('technical ? "?probe=true" : ""');
    expect(detailJs).toContain('<textarea name="magnetUri" required>');
    expect(detailJs).toContain("visible only on this tokenized page");
    expect(detailJs).toContain('role="dialog"');
  });

  it("route helpers decode entry deep links and send deep-link closes back to the library", () => {
    expect(entryRouteId("#/entry/Alpha%2FBeta")).toBe("Alpha/Beta");
    expect(entryRouteId("#/library")).toBeNull();
    expect(closeDetailRoute("#/entry/Alpha%2FBeta")).toBe("#/library");
    expect(closeDetailRoute("#/play/demo/1")).toBe("#/play/demo/1");
  });

  it("detail source tab can relink local entries on this computer", async () => {
    const detailJs = await asset("views/detail.js");
    expect(detailJs).toContain("Relink on this computer");
    expect(detailJs).toContain('"/relink"');
    expect(detailJs).toContain("state.status.nativePicker");
  });

  it("detail files tab shows cached inspection results instantly", async () => {
    const detailJs = await asset("views/detail.js");
    expect(detailJs).toContain("state.selected.inspectionCache");
    expect(detailJs).toContain("from the last inspection");
    expect(detailJs).toContain("Inspect to edit");
    expect(detailJs).toContain("Last inspected");
    expect(detailJs).toContain("function agoLabel");
  });

  it("health section reports service health, mode, and sleep behavior", async () => {
    const statusJs = await asset("views/status.js");
    expect(statusJs).toContain("HealthSection");
    expect(statusJs).toContain("TorrServer");
    expect(statusJs).toContain("Streaming now");
    expect(statusJs).toContain("status.streamingActive");
    expect(statusJs).toContain("Native desktop app");
    expect(statusJs).toContain(
      "Desktop app manages idle sleep during playback",
    );
    expect(statusJs).toContain("Keep the host computer awake");
    expect(statusJs).toContain('if (!available) return "Unavailable"');
    expect(statusJs).toContain('api("diagnostics")');
    expect(statusJs).toContain("Copy diagnostics");
    expect(statusJs).toContain("downloadDiagnostics(text)");
    expect(statusJs).toContain('api("torrserver/settings")');
    expect(statusJs).toContain("TorrServer tuning");
    expect(statusJs).toContain("Reset to shipped defaults");
    expect(statusJs).toContain("drops every active torrent");
    expect(statusJs).toContain("Use suggestion");
    expect(statusJs).toContain("export function StatusView");
  });

  it("activity page combines devices and stream repair", async () => {
    const activityJs = await asset("views/activity.js");
    expect(activityJs).toContain("export function ActivityView");
    expect(activityJs).toContain("DevicesSection");
    expect(activityJs).toContain("RepairSection");
    expect(activityJs).toContain("#activity-repair");
    expect(await asset("views/sessions.js")).toContain('id="activity-repair"');
    const storageJs = await asset("views/storage.js");
    expect(storageJs).toContain("export function StorageView");
    expect(storageJs).toContain("StorageSection");
  });

  it("library filters by tags and cards show them", async () => {
    const libraryJs = await asset("views/library.js");
    expect(libraryJs).toContain("hasTags(e, tagFilter)");
    expect(libraryJs).toContain("tag-filter");
    expect(libraryJs).toContain("card-tags");
    expect(libraryJs).toContain("#\\/library\\/tag\\/");
    const storeJs = await asset("store.js");
    expect(storeJs).toContain('api("tags")');
    expect(storeJs).toContain("tagFilter: []");
  });

  it("episodes tab edits details and requests thumbnails for series only", async () => {
    const detailJs = await asset("views/detail.js");
    expect(detailJs).toContain("function EpisodesTab");
    expect(detailJs).toContain(
      '["episodes", "Episodes", EpisodesTab, "series"]',
    );
    expect(detailJs).toContain("function sectionsFor");
    expect(detailJs).toContain("Generate thumbnails");
    expect(detailJs).toContain("Ongoing series");
    expect(detailJs).toContain('"/thumbnails"');
    expect(detailJs).toContain('"/episodes"');
    const episodesJs = await asset("views/episodes.js");
    expect(episodesJs).toContain("export function episodesPatch");
    expect(episodesJs).toContain("never from a live torrent");
    expect(await asset("styles.css")).toContain(".episode-thumb");
  });

  it("tags page manages the registry and entry forms use the picker", async () => {
    const tagsJs = await asset("views/tags.js");
    expect(tagsJs).toContain("export function TagsView");
    expect(tagsJs).toContain('method: "PATCH"');
    expect(tagsJs).toContain('method: "DELETE"');
    expect(tagsJs).toContain("which will lose it");
    expect(tagsJs).toContain("Pin to Board");
    expect(tagsJs).toContain("Unpin");
    expect(tagsJs).toContain('api("identity")');
    expect(tagsJs).toContain("function ContactEmail");
    expect(await asset("store.js")).toContain("pinnedLimit");
    const pickerJs = await asset("components/tag-picker.js");
    expect(pickerJs).toContain("export function TagPicker");
    expect(pickerJs).toContain("Add tags…");
    expect(pickerJs).toContain("<datalist");
    expect(await asset("views/detail.js")).toContain("<${TagPicker}");
    expect(await asset("views/add.js")).toContain("<${TagPicker}");
  });

  it("storage page shows download progress with pause, resume, and delete", async () => {
    const storageJs = await asset("views/storage.js");
    expect(storageJs).toContain("job.progress");
    expect(storageJs).toContain('"/disk-copy/" + action');
    expect(storageJs).toContain("Resume");
    expect(storageJs).toContain("Pause");
    expect(storageJs).toContain("enabled: false, deleteFiles: true");
    const appJs = await asset("app.js");
    expect(appJs).toContain("job.progress?.totalBytes");
    // The HUD lists real client streams only, not archiver or inspection work.
    expect(appJs).toContain('session.activity === "streaming"');
    expect(await asset("views/devices.js")).toContain("Copying to disk");
  });

  it("library page hosts playback analysis behind an Analyze button", async () => {
    const libraryJs = await asset("views/library.js");
    expect(libraryJs).toContain('from "./analysis.js"');
    expect(libraryJs).toContain("◌ Analyze");
    expect(libraryJs).toContain("#\\/library\\/analysis");
    const analysisJs = await asset("views/analysis.js");
    expect(analysisJs).toContain("export function AnalysisPanel");
    expect(analysisJs).toContain('api("analysis")');
    expect(analysisJs).toContain('method: "DELETE"');
    expect(analysisJs).toContain("Recheck everything");
  });

  it("status view measures speed and polls resource usage", async () => {
    const statusJs = await asset("views/status.js");
    expect(statusJs).toContain('api("speedtest", { method: "POST" })');
    expect(statusJs).toContain('api("resources")');
    expect(statusJs).toContain('id="status-resources"');
    expect(statusJs).toContain('class="rows"');
    expect(statusJs).toContain("setInterval(poll, 5000)");
    expect(statusJs).toContain("Torrent cache on disk");
  });

  it("repair section lists transcode sessions and can stop them", async () => {
    const sessionsJs = await asset("views/sessions.js");
    expect(sessionsJs).toContain("RepairSection");
    expect(sessionsJs).toContain("activity.repair");
    expect(sessionsJs).toContain('method: "DELETE"');
    expect(sessionsJs).toContain("TRANSCODE_ENABLED=true");
  });

  it("player view resolves streams and supports HLS via vendored hls.js", async () => {
    const playerJs = await asset("views/player.js");
    expect(playerJs).toContain('from "../playback-attempt.js"');
    const playbackAttempt = await asset("playback-attempt.js");
    expect(playbackAttempt).toContain('import("./vendor/hls.js")');
    expect(playbackAttempt).toContain("application/vnd.apple.mpegurl");
    expect(playbackAttempt).toContain("Hls.Events.ERROR");
    expect(playerJs).toContain("/stream/");
    expect(playerJs).toContain("if (!response.ok)");
    expect(playerJs).toContain("Could not load stream metadata (HTTP");
    expect(playerJs).toContain("Run a source check, then retry playback");
    expect(playerJs).toContain("Open entry check");
    expect(playerJs).toContain("Retry");
    expect(playerJs).toContain("Wait longer");
    expect(playerJs).toMatch(
      /setNotice\(""\);\s+void attemptRef\.current\?\.play\(\{ retry: true \}\);/,
    );
    expect(playerJs).toContain("Loading stream metadata…");
    expect(playerJs).toContain("Loading video into the player…");
    expect(playerJs).toContain("localStorage");
    // Resume position is server-side; finishing an episode advances it.
    expect(playerJs).toContain('"/playback"');
    expect(playerJs).toContain("positionSeconds: 0, fileId: next.id");
    expect(playerJs).toContain("Resumed from");
    expect(playerJs).toContain("Up next");
    expect(playerJs).toContain("requestPictureInPicture");
    expect(playerJs).toContain("playbackRate");
    expect(playerJs).not.toContain("No playable stream");
    expect(playerJs).not.toMatch(/[🔇🔊⏸]/u);
    const libraryJs = await asset("views/library.js");
    expect(libraryJs).toContain("function resumeLabel");
    // Continue watching is browser-player history only, capped at five.
    expect(libraryJs).toContain("const HISTORY_SIZE = 5");
    expect(libraryJs).toContain('playback.source !== "browser"');
    expect(libraryJs).not.toContain("entry.lastStreamedAt");
    expect(libraryJs).toContain("hero-track");
    expect(libraryJs).toContain("scrollTo({ left: target * track.clientWidth");
    const appJs = await asset("app.js");
    expect(appJs).toContain('import { PlayerView } from "./views/player.js"');
    expect(appJs).toContain("play: PlayerView");
  });

  it("player view switches episodes and can autoplay the next one", async () => {
    const playerJs = await asset("views/player.js");
    expect(playerJs).toContain("pl-menu-episodes");
    expect(playerJs).toContain("hashchange");
    expect(playerJs).toContain("goEpisode");
    expect(playerJs).toContain("autoNext && next");
    expect(playerJs).toContain("entry.playback?.fileId");
  });

  it("stylesheet keeps the disabled-button affordance", async () => {
    const css = await asset("styles.css");
    expect(css).toContain(".primary:disabled");
    expect(css).toContain(".secondary:disabled");
  });
});

describe("classifyLibraryImports", () => {
  it("flags ID, normalized title, and magnet conflicts", () => {
    const current = [
      {
        id: "hoshi:one",
        type: "movie",
        name: "Existing Movie",
        magnetUri: "magnet:?xt=urn:btih:existing",
      },
    ];
    const [candidate] = classifyLibraryImports(
      [
        {
          id: "hoshi:one",
          type: "movie",
          name: " existing movie ",
          magnetUri: "magnet:?xt=urn:btih:existing",
        },
      ],
      current,
    );

    expect(candidate.blocked).toBe(false);
    expect(candidate.conflicts).toEqual([
      "ID already exists",
      "Title already exists",
      "Magnet link already exists",
    ]);
  });

  it("flags duplicate imports and blocks entries without a source", () => {
    const candidates = classifyLibraryImports(
      [
        { id: "same", type: "series", name: "Show" },
        {
          id: "same",
          type: "series",
          name: "show",
          magnetUri: "magnet:?xt=urn:btih:show",
        },
      ],
      [],
    );

    expect(candidates[0]).toMatchObject({ blocked: true });
    expect(candidates[0].conflicts).toEqual([
      "No importable source",
      "Duplicate ID in file",
      "Duplicate title in file",
    ]);
    expect(candidates[1].conflicts).toEqual([
      "Duplicate ID in file",
      "Duplicate title in file",
    ]);
  });
});
