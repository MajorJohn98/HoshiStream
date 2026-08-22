import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore plain browser ES module shared with the management UI
import { classifyLibraryImports } from "../assets/manage/classify-imports.js";
import { managementHtml } from "../src/management.js";

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
    expect(managementHtml).toContain('<main id="app">');
    expect(managementHtml).toContain('<div id="toast" class="toast">');
    expect(managementHtml).toContain('data-view="library"');
    expect(managementHtml).toContain('data-view="add"');
    expect(managementHtml).toContain('data-view="status"');
    expect(managementHtml).not.toContain("Settings");
    expect(managementHtml).not.toContain("<style>");
    expect(managementHtml).not.toMatch(/<script>[^<]/);
    expect(managementHtml).not.toContain("ACCESS_TOKEN");
  });
});

describe("management assets", () => {
  it("app module wires the router and legacy re-exports", async () => {
    const appJs = await asset("app.js");
    expect(appJs).toContain('from "./vendor/preact-htm.js"');
    expect(appJs).toContain('import { LibraryView } from "./views/library.js"');
    expect(appJs).toContain('import { AddView } from "./views/add.js"');
    expect(appJs).toContain('import { StatusView } from "./views/status.js"');
    expect(appJs).toContain("hashchange");
    // Legacy re-exports the unmigrated detail modal still depends on.
    expect(appJs).toContain(
      "export { state, load, api, esc, fmt, notify, token, headers }",
    );
    expect(appJs).not.toContain("ACCESS_TOKEN");
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
    expect(libraryJs).toContain(
      "({ torrentFilePath, localFilePath, localFolderPath, ...details })",
    );
    expect(libraryJs).toContain('api("stremio-refresh", { method: "POST" })');
    expect(libraryJs).toContain('location.href = "stremio:///board"');
    expect(libraryJs).toContain("Copy add-on URL");
    expect(libraryJs).toContain('role="dialog"');
    expect(libraryJs).toContain('e.key === "Escape"');
    expect(libraryJs).toContain(
      'import { classifyLibraryImports } from "../classify-imports.js"',
    );
  });

  it("add view uploads torrents and media through the API", async () => {
    const addJs = await asset("views/add.js");
    expect(addJs).toContain("/api/torrent-upload");
    expect(addJs).toContain("/api/upload?batch=");
    expect(addJs).toContain("webkitdirectory");
  });

  it("add view offers Finder linking only when the picker is available", async () => {
    const addJs = await asset("views/add.js");
    expect(addJs).toContain("status.nativePicker");
    expect(addJs).toContain("Choose with Finder");
    expect(addJs).toContain("d.nativePathGrant = picked.grant");
    expect(addJs).toContain('"native-picker/"');
  });

  it("detail view keeps inspection, mapping, and playback flows", async () => {
    const detailJs = await asset("views/detail.js");
    expect(detailJs).toContain('method: "PATCH"');
    expect(detailJs).toContain("Files & episode mapping");
    expect(detailJs).toContain("Test playback");
    expect(detailJs).toContain("Playback analysis");
    expect(detailJs).toContain("Recommended speed");
    expect(detailJs).toContain("Likely to direct play");
    expect(detailJs).toContain("Inspecting files…");
    expect(detailJs).toContain("Analyzing playback…");
    expect(detailJs).toContain('technical ? "?probe=true" : ""');
    expect(detailJs).toContain('<textarea name="magnetUri" required>');
    expect(detailJs).toContain("visible only on the tokenized management page");
    expect(detailJs).toContain('role="dialog"');
  });

  it("detail source tab can relink local entries in Finder", async () => {
    const detailJs = await asset("views/detail.js");
    expect(detailJs).toContain("Relink in Finder");
    expect(detailJs).toContain('"/relink"');
    expect(detailJs).toContain("state.status.nativePicker");
  });

  it("detail files tab shows cached inspection results instantly", async () => {
    const detailJs = await asset("views/detail.js");
    expect(detailJs).toContain("state.selected.inspectionCache");
    expect(detailJs).toContain("From the last inspection");
    expect(detailJs).toContain("Inspect to edit");
    expect(detailJs).toContain("Last inspected");
    expect(detailJs).toContain("function agoLabel");
  });

  it("status view reports service health, mode, and sleep behavior", async () => {
    const statusJs = await asset("views/status.js");
    expect(statusJs).toContain("System Status");
    expect(statusJs).toContain("TorrServer");
    expect(statusJs).toContain("Streaming now");
    expect(statusJs).toContain("status.streamingActive");
    expect(statusJs).toContain("Native macOS app");
    expect(statusJs).toContain("Docker mode");
    expect(statusJs).toContain("Kept awake automatically during playback");
    expect(statusJs).toContain("Run caffeinate or keep the Mac awake");
    expect(statusJs).not.toContain('"diagnostics"');
  });

  it("stylesheet keeps the disabled-button affordance", async () => {
    const css = await asset("styles.css");
    expect(css).toContain("color: #151719");
    expect(css).toContain(".primary:disabled");
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
