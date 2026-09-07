import { mkdtemp, mkdir, realpath, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import { NativePicker, validateNativePath } from "../src/native-picker.ts";

const temporary: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    temporary
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("native picker", () => {
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

  it("reports availability from the supervisor socket path", async () => {
    const root = await mkdtemp(join(tmpdir(), "hoshistream-picker-"));
    temporary.push(root);
    const socket = join(root, "supervisor.sock");
    await writeFile(socket, "");

    await expect(new NativePicker(socket, "darwin").available()).resolves.toBe(
      true,
    );
    await expect(
      new NativePicker(join(root, "missing.sock"), "darwin").available(),
    ).resolves.toBe(false);
  });

  it("redeems an opaque grant only once", async () => {
    const picker = new NativePicker("/unused");
    vi.spyOn(picker, "select").mockResolvedValue("/private/movie.mp4");
    const { grant } = await picker.issue("file");

    expect(picker.redeem(grant)).toMatchObject({
      kind: "file",
      path: "/private/movie.mp4",
    });
    expect(() => picker.redeem(grant)).toThrow();
  });

  it("expires grants at their deadline", async () => {
    const picker = new NativePicker("/unused");
    vi.spyOn(picker, "select").mockResolvedValue("/private/movie.mp4");
    const now = Date.now();
    vi.spyOn(Date, "now").mockReturnValue(now);
    const { grant } = await picker.issue("file");
    vi.spyOn(Date, "now").mockReturnValue(now + 60_000);
    expect(() => picker.redeem(grant)).toThrow("Selection expired");
  });
});
