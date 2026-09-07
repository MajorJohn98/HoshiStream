import {
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildDocsSite,
  guideSections,
  validateGuide,
} from "../../scripts/build-docs-site.mjs";

const temporary: string[] = [];
afterEach(async () => {
  for (const path of temporary.splice(0)) {
    await rm(path, { recursive: true, force: true });
  }
});

async function directory() {
  const path = await mkdtemp(join(tmpdir(), "hoshi-docs-"));
  temporary.push(path);
  return path;
}

function fixture() {
  return guideSections
    .map(([id]: [string, string]) => `<section id="${id}"></section>`)
    .join("\n");
}

describe("public documentation", () => {
  it("publishes only the documentation allowlist and works below a project path", async () => {
    const output = await directory();
    await buildDocsSite(output);
    expect((await readdir(output)).sort()).toEqual([
      ".nojekyll",
      "index.html",
      "site.js",
      "styles.css",
    ]);
    const html = await readFile(join(output, "index.html"), "utf8");
    expect(html).toContain('href="./styles.css"');
    expect(html).toContain('src="./site.js"');
    expect(html).toContain("Version 0.14.0");
    expect(html).toContain('href="#configuration"');
    expect(html).toContain("LOCAL");
    expect(() => validateGuide(html)).not.toThrow();
    await expect(buildDocsSite(output)).resolves.toBe(output);
  });

  it("rejects missing, duplicate and broken anchors", () => {
    expect(() => validateGuide("")).toThrow("Missing guide section");
    expect(() =>
      validateGuide(fixture() + '<p id="configuration">duplicate</p>'),
    ).toThrow("duplicate anchor");
    expect(() =>
      validateGuide(fixture() + '<a href="#missing">link</a>'),
    ).toThrow("Broken documentation anchor");
  });

  it("rejects incomplete templates and local-resource links", () => {
    expect(() => validateGuide(fixture() + "{{guide}}")).toThrow(
      "unrendered documentation placeholder",
    );
    expect(() =>
      validateGuide(fixture() + '<a href="http://127.0.0.1:7001/">local</a>'),
    ).toThrow("private local resource");
  });

  it("refuses to upload stale or private files in the output directory", async () => {
    const output = await directory();
    await writeFile(join(output, ".env"), "not a real credential");
    await expect(buildDocsSite(output)).rejects.toThrow(
      "Unexpected documentation output: .env",
    );
    expect(await readFile(join(output, ".env"), "utf8")).toBe(
      "not a real credential",
    );
  });

  it("does not follow symbolic links in the output", async () => {
    const output = await directory();
    const target = await directory();
    await writeFile(join(target, "untouched.txt"), "preserve");
    await symlink(join(target, "untouched.txt"), join(output, "index.html"));
    await expect(buildDocsSite(output)).rejects.toThrow(
      "Unexpected documentation output: index.html",
    );
    expect(await readFile(join(target, "untouched.txt"), "utf8")).toBe(
      "preserve",
    );
  });
});
