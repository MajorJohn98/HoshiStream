import { mkdtemp, mkdir, realpath, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { NativePicker, validateNativePath } from "../src/native-picker.js";

const temporary: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporary
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("native Finder picker", () => {
  it("validates video files and series folders", async () => {
    const root = await mkdtemp(join(tmpdir(), "hoshistream-picker-"));
    temporary.push(root);
    const folder = join(root, "Show");
    const video = join(folder, "S01E01.mp4");
    await mkdir(folder);
    await writeFile(video, "video");

    await expect(validateNativePath(video, "file")).resolves.toBe(
      await realpath(video),
    );
    await expect(validateNativePath(folder, "folder")).resolves.toBe(
      await realpath(folder),
    );
    await expect(validateNativePath(folder, "file")).rejects.toThrow();
  });

  it("redeems an opaque grant only once", () => {
    const picker = new NativePicker("/unused");
    const grants = (
      picker as unknown as {
        grants: Map<string, { expiresAt: number; kind: "file"; path: string }>;
      }
    ).grants;
    grants.set("opaque", {
      expiresAt: Date.now() + 1_000,
      kind: "file",
      path: "/private/movie.mp4",
    });

    expect(picker.redeem("opaque")).toMatchObject({
      kind: "file",
      path: "/private/movie.mp4",
    });
    expect(() => picker.redeem("opaque")).toThrow();
  });
});
