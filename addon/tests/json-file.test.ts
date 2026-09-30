import { rmSync } from "node:fs";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { expectOwnerOnly } from "./helpers/private-files.ts";
import { readJsonFile, writeJsonFile } from "../src/json-file.ts";

const schema = z.object({ count: z.number() });
let directory: string;

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "hoshi-json-file-"));
});

afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

describe("writeJsonFile", () => {
  it("writes owner-only pretty JSON, creating directories, with no temp left", async () => {
    const path = join(directory, "nested", "state.json");
    await writeJsonFile(path, { count: 1 });
    expect(await readFile(path, "utf8")).toBe('{\n  "count": 1\n}\n');
    await expectOwnerOnly(path);
    expect(await readdir(join(directory, "nested"))).toEqual(["state.json"]);
  });

  it("runs overlapping writers one at a time so the last call wins", async () => {
    const path = join(directory, "state.json");
    await Promise.all(
      Array.from({ length: 20 }, (_, count) => writeJsonFile(path, { count })),
    );
    expect(schema.parse(JSON.parse(await readFile(path, "utf8")))).toEqual({
      count: 19,
    });
    expect(await readdir(directory)).toEqual(["state.json"]);
  });

  it("snapshots the value when called, not when the queued write runs", async () => {
    const path = join(directory, "state.json");
    const value = { count: 1 };
    const first = writeJsonFile(path, { count: 0 });
    const second = writeJsonFile(path, value);
    value.count = 2;
    await Promise.all([first, second]);
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual({ count: 1 });
  });

  it("still runs a queued write after the one ahead of it fails", async () => {
    const path = join(directory, "state.json");
    await mkdir(join(path, "child"), { recursive: true });
    // The directory makes the first rename fail. It is removed synchronously
    // as that write rejects, before the queued write can reach its rename.
    const first = writeJsonFile(path, { count: 1 }).catch((error: unknown) => {
      rmSync(path, { recursive: true });
      throw error;
    });
    const second = writeJsonFile(path, { count: 2 });
    await expect(first).rejects.toThrow();
    await second;
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual({ count: 2 });
    expect(await readdir(directory)).toEqual(["state.json"]);
  });

  it("removes its temp file when the rename fails", async () => {
    const path = join(directory, "occupied");
    await mkdir(join(path, "child"), { recursive: true });
    await expect(writeJsonFile(path, { count: 1 })).rejects.toThrow();
    expect(await readdir(directory)).toEqual(["occupied"]);
  });
});

describe("readJsonFile", () => {
  it("returns undefined for a missing file", async () => {
    expect(
      await readJsonFile(join(directory, "missing.json"), schema),
    ).toBeUndefined();
  });

  it("returns validated contents", async () => {
    const path = join(directory, "state.json");
    await writeFile(path, '{"count":3}');
    expect(await readJsonFile(path, schema)).toEqual({ count: 3 });
  });

  it.each([
    ["malformed JSON", "{not json"],
    ["a schema mismatch", '{"count":"three"}'],
  ])("moves a file with %s aside instead of discarding it", async (_, body) => {
    const path = join(directory, "state.json");
    await writeFile(path, body);
    expect(await readJsonFile(path, schema)).toBeUndefined();
    const names = await readdir(directory);
    expect(names).not.toContain("state.json");
    const quarantined = names.find((name) =>
      name.startsWith("state.json.corrupt-"),
    );
    expect(quarantined).toBeDefined();
    expect(await readFile(join(directory, quarantined!), "utf8")).toBe(body);
  });

  it("rethrows I/O errors so callers never overwrite an unreadable file", async () => {
    const path = join(directory, "state.json");
    await mkdir(path);
    await expect(readJsonFile(path, schema)).rejects.toThrow();
    expect(await readdir(directory)).toEqual(["state.json"]);
  });
});
