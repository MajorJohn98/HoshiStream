import { createServer, type Server } from "node:http";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Library } from "../src/library.ts";
import { NativePicker } from "../src/native-picker.ts";
import { createHandler } from "../src/routes.ts";
import { TorrServerClient } from "../src/torrserver-client.ts";
import { VolumeRegistry } from "../src/volumes.ts";
import type { Archiver } from "../src/archiver.ts";

let server: Server | undefined;
let root: string | undefined;
const token = "disk-policy-api-fixture-token";
const headers = {
  authorization: "Bearer " + token,
  "content-type": "application/json",
};
const HASH = "b".repeat(40);
const files = [1, 2, 3].map((id) => ({
  id,
  path: `Show/S01E0${id}.mkv`,
  length: 100,
  season: 1,
  episode: id,
}));

async function fixture(type: "movie" | "series", withDiskCopy = true) {
  root = await realpath(
    await mkdtemp(join(tmpdir(), "hoshistream-policy-api-")),
  );
  const mountBase = join(root, "Volumes");
  const drive = join(mountBase, "Drive", "HoshiStream");
  await mkdir(drive, { recursive: true });
  const volumes = new VolumeRegistry(join(root, "volumes.json"), mountBase, 0);
  const volume = await volumes.register(drive);
  const library = new Library(join(root, "library.json"));
  const entry = await library.create({
    name: "Show",
    type,
    magnetUri: `magnet:?xt=urn:btih:${HASH}`,
  });
  await library.setInspectionCache(entry.id, {
    hash: HASH,
    inspectedAt: new Date().toISOString(),
    selectedFiles: files,
  });
  if (withDiskCopy)
    await library.setDiskCopy(entry.id, {
      desired: "keep",
      volumeId: volume.id,
      relativeDir: "Show-1",
      sourceRevision: "rev1",
      scope: "all",
      files: files.map(({ id, path, length }) => ({
        sourceKey: `${HASH}:${id}`,
        relativePath: path,
        length,
        included: true,
        state: id === 1 ? ("complete" as const) : ("missing" as const),
      })),
      updatedAt: new Date().toISOString(),
    });
  const applyPolicy = vi.fn().mockResolvedValue(undefined);
  server = createServer(
    createHandler({
      library,
      torrServer: new TorrServerClient("http://127.0.0.1:1"),
      volumes,
      archiver: { applyPolicy } as unknown as Archiver,
      addon: {
        manifest: { id: "fixture", name: "Fixture" },
        get: async () => ({}),
      },
      nativePicker: new NativePicker(join(root, "missing.sock")),
      accessToken: token,
      homeSpeedMbps: 100,
      publicUrls: {
        addonUrl: "http://localhost",
        torrServerUrl: "http://localhost",
      },
    }),
  );
  await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing port");
  const url = `http://127.0.0.1:${address.port}/api/library/${encodeURIComponent(entry.id)}/disk-copy/policy`;
  const put = (body: unknown) =>
    fetch(url, { method: "PUT", headers, body: JSON.stringify(body) });
  return { library, entry, put, applyPolicy };
}

afterEach(async () => {
  if (server) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server!.close(() => resolve()));
  }
  if (root) await rm(root, { recursive: true, force: true });
  server = undefined;
  root = undefined;
});

describe("PUT /api/library/:id/disk-copy/policy", () => {
  it("rejects movies and entries without a disk copy", async () => {
    const movie = await fixture("movie");
    expect((await movie.put({ keepAhead: 2 })).status).toBe(409);
    await rm(root!, { recursive: true, force: true });
    await new Promise<void>((resolve) => server!.close(() => resolve()));
    const bare = await fixture("series", false);
    expect((await bare.put({ keepAhead: 2 })).status).toBe(409);
  });

  it("validates the window size", async () => {
    const { put } = await fixture("series");
    expect((await put({ keepAhead: 51 })).status).toBe(400);
    expect((await put({ keepAhead: -1 })).status).toBe(400);
  });

  it("switches to selected scope and keeps only on-disk files when turning on", async () => {
    const { put, applyPolicy, entry } = await fixture("series");
    const response = await put({ keepAhead: 2, evictWatched: true });
    expect(response.status).toBe(200);
    const diskCopy = (await response.json()).diskCopy;
    expect(diskCopy.policy).toEqual({ keepAhead: 2, evictWatched: true });
    expect(diskCopy.scope).toBe("selected");
    expect(
      diskCopy.files.map((f: { included: boolean }) => f.included),
    ).toEqual([true, false, false]);
    expect(applyPolicy).toHaveBeenCalledWith(entry.id);
  });

  it("clears the policy when everything is turned off", async () => {
    const { put } = await fixture("series");
    await put({ keepAhead: 1 });
    const response = await put({ keepAhead: 0, evictWatched: false });
    expect(response.status).toBe(200);
    expect((await response.json()).diskCopy.policy).toBeUndefined();
  });
});
