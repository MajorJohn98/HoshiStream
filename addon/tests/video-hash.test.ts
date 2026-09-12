import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  clearVideoHashCache,
  hashChunks,
  openSubtitlesHash,
} from "../src/video-hash.ts";

const CHUNK = 64 * 1024;

describe("hashChunks", () => {
  it("is the file size alone when both chunks are zero", () => {
    const zeros = new Uint8Array(CHUNK);
    expect(hashChunks(0x123456789, zeros, zeros)).toBe("0000000123456789");
  });

  it("sums little-endian 64-bit words from both chunks modulo 2^64", () => {
    const head = new Uint8Array(16);
    const tail = new Uint8Array(16);
    // head word 0 = 1, head word 1 = 2^63, tail word 0 = 2^63 → wraps to 1.
    head[0] = 1;
    head[15] = 0x80;
    tail[7] = 0x80;
    expect(hashChunks(5, head, tail)).toBe("0000000000000006");
  });

  it("ignores trailing bytes that do not fill a word", () => {
    const head = new Uint8Array(11);
    head[8] = 0xff;
    expect(hashChunks(1, head, new Uint8Array(0))).toBe("0000000000000001");
  });
});

describe("openSubtitlesHash", () => {
  let dir: string;
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "hoshi-video-hash-"));
  });
  afterAll(async () => {
    clearVideoHashCache();
    await rm(dir, { recursive: true, force: true });
  });

  it("hashes the first and last 64 KiB of a real file", async () => {
    const size = 3 * CHUNK + 123;
    const bytes = new Uint8Array(size);
    bytes[0] = 0x2a; // first word = 42
    bytes[size - 1] = 0x01; // last word = 2^56
    const path = join(dir, "movie.mkv");
    await writeFile(path, bytes);
    const expected = (BigInt(size) + 42n + (1n << 56n))
      .toString(16)
      .padStart(16, "0");
    expect(await openSubtitlesHash(path)).toBe(expected);
    expect(await openSubtitlesHash(path)).toBe(expected);
  });

  it("declines short files and missing paths", async () => {
    const path = join(dir, "clip.mp4");
    await writeFile(path, new Uint8Array(CHUNK));
    expect(await openSubtitlesHash(path)).toBeUndefined();
    expect(await openSubtitlesHash(join(dir, "nope.mkv"))).toBeUndefined();
    expect(await openSubtitlesHash(dir)).toBeUndefined();
  });
});
