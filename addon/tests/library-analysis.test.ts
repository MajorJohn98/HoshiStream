import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { Library } from "../src/library.js";
import { LibraryAnalysis } from "../src/library-analysis.js";

async function seededLibrary() {
  const directory = await mkdtemp(join(tmpdir(), "hoshistream-analysis-"));
  const path = join(directory, "library.json");
  await writeFile(path, "[]\n");
  const library = new Library(path);
  const first = await library.create({
    type: "movie",
    name: "One",
    magnetUri: "magnet:?xt=urn:btih:one",
  });
  const second = await library.create({
    type: "movie",
    name: "Two",
    magnetUri: "magnet:?xt=urn:btih:two",
  });
  return { library, first, second };
}

function settle(analysis: LibraryAnalysis): Promise<void> {
  return new Promise((resolve) => {
    const check = () => {
      if (!analysis.status().running) resolve();
      else setTimeout(check, 5);
    };
    check();
  });
}

describe("LibraryAnalysis", () => {
  it("visits entries sequentially and records failures", async () => {
    const { library } = await seededLibrary();
    const visited: string[] = [];
    let concurrent = 0;
    const analysis = new LibraryAnalysis(library, async (entry) => {
      concurrent += 1;
      expect(concurrent).toBe(1);
      await new Promise((resolve) => setTimeout(resolve, 5));
      concurrent -= 1;
      visited.push(entry.name);
      if (entry.name === "Two") throw new Error("probe failed");
    });

    await expect(analysis.start(false)).resolves.toBe(true);
    // A second start while running is refused.
    await expect(analysis.start(false)).resolves.toBe(false);
    await settle(analysis);

    const status = analysis.status();
    expect(visited).toEqual(["One", "Two"]);
    expect(status).toMatchObject({
      running: false,
      total: 2,
      done: 2,
      cancelled: false,
    });
    expect(status.failed).toEqual([
      expect.objectContaining({ name: "Two", error: "probe failed" }),
    ]);
  });

  it("skips already-analyzed entries unless forced", async () => {
    const { library, first } = await seededLibrary();
    await library.setDirectPlay(first.id, {
      compatibility: "direct",
      warnings: [],
      probedAt: new Date().toISOString(),
    });
    const visited: string[] = [];
    const analysis = new LibraryAnalysis(library, async (entry) => {
      visited.push(entry.name);
    });

    await analysis.start(false);
    await settle(analysis);
    expect(visited).toEqual(["Two"]);

    await analysis.start(true);
    await settle(analysis);
    expect(visited).toEqual(["Two", "One", "Two"]);
  });

  it("cancel stops the run between entries", async () => {
    const { library } = await seededLibrary();
    const visited: string[] = [];
    const analysis = new LibraryAnalysis(library, async (entry) => {
      visited.push(entry.name);
      if (visited.length === 1) analysis.cancel();
    });

    await analysis.start(false);
    await settle(analysis);

    expect(visited).toEqual(["One"]);
    expect(analysis.status()).toMatchObject({
      running: false,
      cancelled: true,
    });
  });
});
