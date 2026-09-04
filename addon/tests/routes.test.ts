import { describe, expect, it } from "vitest";
import {
  manageAssetPath,
  noStoreProtocolResource,
  technicalProbeRequested,
} from "../src/routes.ts";

describe("inspection route", () => {
  it("runs the slow technical probe only when explicitly requested", () => {
    expect(technicalProbeRequested(new URL("http://localhost/inspect"))).toBe(
      false,
    );
    expect(
      technicalProbeRequested(new URL("http://localhost/inspect?probe=true")),
    ).toBe(true);
  });

  it("prevents clients from caching expiring stream URLs", () => {
    expect(noStoreProtocolResource("catalog")).toBe(true);
    expect(noStoreProtocolResource("meta")).toBe(true);
    expect(noStoreProtocolResource("stream")).toBe(true);
  });
});

describe("management asset route", () => {
  it("serves only whitelisted js and css names", () => {
    expect(manageAssetPath("/manage-assets/app.js")).toBe("app.js");
    expect(manageAssetPath("/manage-assets/styles.css")).toBe("styles.css");
    expect(manageAssetPath("/manage-assets/classify-imports.js")).toBe(
      "classify-imports.js",
    );
    expect(manageAssetPath("/manage-assets/views/library.js")).toBe(
      "views/library.js",
    );
    expect(manageAssetPath("/manage-assets/vendor/preact-htm.js")).toBe(
      "vendor/preact-htm.js",
    );
    expect(manageAssetPath("/manage-assets/components/shell.js")).toBe(
      "components/shell.js",
    );
  });

  it("rejects traversal and unexpected paths", () => {
    expect(manageAssetPath("/manage-assets/../library.json")).toBeUndefined();
    expect(manageAssetPath("/manage-assets/..%2f..%2f.env")).toBeUndefined();
    expect(manageAssetPath("/manage-assets/app.js.map")).toBeUndefined();
    expect(manageAssetPath("/manage-assets/App.js")).toBeUndefined();
    expect(manageAssetPath("/manage-assets/views/../app.js")).toBeUndefined();
    expect(
      manageAssetPath("/manage-assets/vendor/../../src/index.js"),
    ).toBeUndefined();
    expect(manageAssetPath("/manage-assets/deep/views/app.js")).toBeUndefined();
    expect(manageAssetPath("/manage-assets/logo.png")).toBeUndefined();
    expect(manageAssetPath("/manage-assets/")).toBeUndefined();
  });
});
