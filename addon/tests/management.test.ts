import { describe, expect, it } from "vitest";
import { classifyLibraryImports, managementHtml } from "../src/management.js";

describe("management page", () => {
  it("uses the tokenized URL and authenticated library API", () => {
    expect(managementHtml).toContain('Authorization:"Bearer "+token');
    expect(managementHtml).toContain('fetch("/api/"+path');
    expect(managementHtml).toContain('method:"PATCH"');
    expect(managementHtml).toContain("/api/torrent-upload");
    expect(managementHtml).toContain("Files & episode mapping");
    expect(managementHtml).toContain("System Status");
    expect(managementHtml).toContain("Test playback");
    expect(managementHtml).toContain("Playback analysis");
    expect(managementHtml).toContain("Recommended speed");
    expect(managementHtml).toContain("Likely to direct play");
    expect(managementHtml).not.toContain('"diagnostics"');
    expect(managementHtml).toContain("Inspecting files…");
    expect(managementHtml).toContain("Analyzing playback…");
    expect(managementHtml).toContain("color:#151719");
    expect(managementHtml).toContain(".primary:disabled");
    expect(managementHtml).toContain('technical?"?probe=true":""');
    expect(managementHtml).toContain("Refresh Stremio");
    expect(managementHtml).toContain("Export JSON");
    expect(managementHtml).toContain("Import JSON");
    expect(managementHtml).toContain("Choose titles to add");
    expect(managementHtml).toContain('<textarea name="magnetUri" required>');
    expect(managementHtml).toContain(
      "visible only on the tokenized management page",
    );
    expect(managementHtml).toContain(
      'link.download="hoshistream-library.json"',
    );
    expect(managementHtml).toContain(
      "({torrentFilePath,localFilePath,localFolderPath,...details})",
    );
    expect(managementHtml).toContain('details.magnetUri?"magnet"');
    expect(managementHtml).toContain('api("stremio-refresh",{method:"POST"}');
    expect(managementHtml).toContain('location.href="stremio:///board"');
    expect(managementHtml).toContain("Copy add-on URL");
    expect(managementHtml).toContain('role="dialog"');
    expect(managementHtml).toContain('e.key==="Escape"');
    expect(managementHtml).not.toContain("ACCESS_TOKEN");
  });

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
