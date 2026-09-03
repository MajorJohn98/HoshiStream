import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  MARKER_FILENAME,
  VolumeError,
  VolumeRegistry,
} from "../src/volumes.js";

const temporary: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporary
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

// A fake /Volumes directory: each child simulates one mounted drive.
async function setup() {
  // realpath: macOS tmpdir lives behind the /var → /private/var symlink, and
  // the registry stores realpath'd roots.
  const base = await realpath(
    await mkdtemp(join(tmpdir(), "hoshistream-volumes-")),
  );
  temporary.push(base);
  const mountBase = join(base, "Volumes");
  const drive = join(mountBase, "Seagate", "HoshiStream");
  await mkdir(drive, { recursive: true });
  const registry = new VolumeRegistry(join(base, "volumes.json"), mountBase);
  return { base, mountBase, drive, registry };
}

describe("VolumeRegistry", () => {
  it("registers a folder by writing and verifying a marker", async () => {
    const { drive, registry } = await setup();
    const volume = await registry.register(drive);

    expect(volume.label).toBe("HoshiStream");
    expect(volume.mountRelativePath).toBe("HoshiStream");
    const marker = JSON.parse(
      await readFile(join(drive, MARKER_FILENAME), "utf8"),
    );
    expect(marker).toEqual({ format: 1, volumeId: volume.id });
    await expect(registry.resolve(volume.id)).resolves.toEqual({
      state: "online",
      root: drive,
    });
  });

  it("returns the existing volume when the folder is already registered", async () => {
    const { drive, registry } = await setup();
    const first = await registry.register(drive);
    const second = await registry.register(drive);

    expect(second.id).toBe(first.id);
    expect(await registry.list()).toHaveLength(1);
  });

  it("adopts a valid marker from another registry under its original id", async () => {
    const { drive, registry } = await setup();
    await writeFile(
      join(drive, MARKER_FILENAME),
      JSON.stringify({
        format: 1,
        volumeId: "0f7f2f5e-4a5b-4a3c-8c2d-9e1f2a3b4c5d",
      }),
    );

    const volume = await registry.register(drive);
    expect(volume.id).toBe("0f7f2f5e-4a5b-4a3c-8c2d-9e1f2a3b4c5d");
  });

  it("rejects invalid markers and overlapping roots", async () => {
    const { mountBase, drive, registry } = await setup();
    await registry.register(drive);

    const nested = join(drive, "nested");
    await mkdir(nested);
    await expect(registry.register(nested)).rejects.toThrow(VolumeError);
    await expect(registry.register(join(mountBase, "Seagate"))).rejects.toThrow(
      VolumeError,
    );

    const invalid = join(mountBase, "Other");
    await mkdir(invalid, { recursive: true });
    await writeFile(join(invalid, MARKER_FILENAME), "not json");
    await expect(registry.register(invalid)).rejects.toThrow(
      "invalid HoshiStream volume marker",
    );
  });

  it("re-resolves a drive that remounted under a new name", async () => {
    const { mountBase, drive, registry } = await setup();
    const volume = await registry.register(drive);
    await rename(join(mountBase, "Seagate"), join(mountBase, "Seagate 1"));

    // Fresh registry: the resolution cache must not mask the move.
    const reopened = new VolumeRegistry(
      join(mountBase, "..", "volumes.json"),
      mountBase,
    );
    const resolved = await reopened.resolve(volume.id);
    expect(resolved).toEqual({
      state: "online",
      root: join(mountBase, "Seagate 1", "HoshiStream"),
    });
    const updated = await reopened.get(volume.id);
    expect(updated?.lastKnownRoot).toBe(
      join(mountBase, "Seagate 1", "HoshiStream"),
    );
  });

  it("reports offline when the drive or marker is gone", async () => {
    const { mountBase, drive, registry } = await setup();
    const volume = await registry.register(drive);
    await rm(join(mountBase, "Seagate"), { recursive: true });

    const reopened = new VolumeRegistry(
      join(mountBase, "..", "volumes.json"),
      mountBase,
    );
    await expect(reopened.resolve(volume.id)).resolves.toEqual({
      state: "offline",
    });
  });

  it("never trusts a look-alike drive without the marker", async () => {
    const { mountBase, drive, registry } = await setup();
    const volume = await registry.register(drive);
    await rm(join(mountBase, "Seagate"), { recursive: true });
    // Same name and layout, but no marker: must stay offline.
    await mkdir(join(mountBase, "Seagate", "HoshiStream"), {
      recursive: true,
    });

    const reopened = new VolumeRegistry(
      join(mountBase, "..", "volumes.json"),
      mountBase,
    );
    await expect(reopened.resolve(volume.id)).resolves.toEqual({
      state: "offline",
    });
  });

  it("reports ambiguous when two mounts carry the same marker", async () => {
    const { mountBase, drive, registry } = await setup();
    const volume = await registry.register(drive);
    const clone = join(mountBase, "Clone", "HoshiStream");
    await mkdir(clone, { recursive: true });
    await writeFile(
      join(clone, MARKER_FILENAME),
      await readFile(join(drive, MARKER_FILENAME)),
    );

    const reopened = new VolumeRegistry(
      join(mountBase, "..", "volumes.json"),
      mountBase,
    );
    const resolved = await reopened.resolve(volume.id);
    expect(resolved.state).toBe("ambiguous");
    if (resolved.state === "ambiguous") {
      expect(resolved.roots).toHaveLength(2);
    }
  });

  it("forgets a volume without touching the marker or media", async () => {
    const { drive, registry } = await setup();
    const volume = await registry.register(drive);

    await expect(registry.forget(volume.id)).resolves.toBe(true);
    await expect(registry.forget(volume.id)).resolves.toBe(false);
    expect(await registry.list()).toHaveLength(0);
    await expect(readFile(join(drive, MARKER_FILENAME))).resolves.toBeTruthy();
  });

  it("reports live status with free space for online volumes", async () => {
    const { drive, registry } = await setup();
    const volume = await registry.register(drive);

    const [status] = await registry.statusAll();
    expect(status).toMatchObject({
      id: volume.id,
      label: "HoshiStream",
      state: "online",
      root: drive,
    });
    expect(status.freeBytes).toBeGreaterThan(0);
    expect(status.totalBytes).toBeGreaterThan(0);
  });

  it("recovers the registry from its backup after corruption", async () => {
    const { base, drive } = await setup();
    const path = join(base, "volumes.json");
    const registry = new VolumeRegistry(path, join(base, "Volumes"));
    const volume = await registry.register(drive);
    await writeFile(path, "{corrupt");

    const reopened = new VolumeRegistry(path, join(base, "Volumes"));
    const volumes = await reopened.list();
    expect(volumes.map((entry) => entry.id)).toEqual([volume.id]);
  });
});
