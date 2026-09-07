import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rename,
  rm,
  writeFile,
  symlink,
} from "node:fs/promises";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  MARKER_FILENAME,
  VolumeError,
  VolumeRegistry,
  storageVolumeSchema,
} from "../src/volumes.ts";

vi.mock("node:fs/promises", { spy: true });

const temporary: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
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
  it("accepts existing native relative paths without torrent-path restrictions", () => {
    expect(
      storageVolumeSchema.parse({
        id: "0f7f2f5e-4a5b-4a3c-8c2d-9e1f2a3b4c5d",
        label: "Media",
        lastKnownRoot: "/Volumes/Drive/Media\\Anime",
        mountRelativePath: "Media\\Anime",
        createdAt: new Date().toISOString(),
      }).mountRelativePath,
    ).toBe("Media\\Anime");
  });

  it.skipIf(process.platform === "win32")(
    "preserves literal POSIX backslashes during drive rediscovery",
    async () => {
      const { base, mountBase } = await setup();
      const original = join(mountBase, "Drive", "Media\\Anime");
      await mkdir(original, { recursive: true });
      const registry = new VolumeRegistry(
        join(base, "literal.json"),
        mountBase,
      );
      const entry = await registry.register(original);
      expect(entry.mountRelativePath).toBe("Media\\Anime");
      await rename(join(mountBase, "Drive"), join(mountBase, "Renamed"));
      const reopened = new VolumeRegistry(
        join(base, "literal.json"),
        mountBase,
      );
      await expect(reopened.resolve(entry.id)).resolves.toEqual({
        state: "online",
        root: join(mountBase, "Renamed", "Media\\Anime"),
      });
    },
  );

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

  it.each(["", "Media/Series"])(
    "rediscovers changed drive letters for root %j using only candidate mounts",
    async (subpath) => {
      const { base } = await setup();
      const oldMount = join(base, "E");
      const newMount = join(base, "F");
      const oldRoot = join(oldMount, subpath);
      await mkdir(oldRoot, { recursive: true });
      let mounts = [oldMount];
      const enumerateMounts = vi.fn(async () => mounts);
      const registry = new VolumeRegistry(
        join(base, "windows.json"),
        { enumerateMounts },
        0,
      );
      const volume = await registry.register(oldRoot);
      expect(volume.mountRelativePath).toBe(subpath);
      await rename(oldMount, newMount);
      mounts = [newMount];
      const root = join(newMount, subpath);
      expect(await registry.resolve(volume.id)).toEqual({
        state: "online",
        root,
      });
      expect((await registry.get(volume.id))?.lastKnownRoot).toBe(root);
      const marker = JSON.parse(
        await readFile(join(root, MARKER_FILENAME), "utf8"),
      );
      expect(marker.volumeId).toBe(volume.id);
    },
  );

  it("refreshes a legacy registration's relative path without changing identity", async () => {
    const { base, drive } = await setup();
    const path = join(base, "legacy.json");
    const legacy = new VolumeRegistry(
      path,
      { enumerateMounts: async () => [] },
      0,
    );
    const first = await legacy.register(drive);
    expect(first.mountRelativePath).toBeUndefined();
    const registry = new VolumeRegistry(
      path,
      {
        enumerateMounts: async () => [join(base, "Volumes", "Seagate")],
      },
      0,
    );
    expect(await registry.resolve(first.id)).toEqual({
      state: "online",
      root: drive,
    });
    const refreshed = await registry.register(drive);
    expect(refreshed.id).toBe(first.id);
    expect(refreshed.mountRelativePath).toBe("HoshiStream");
  });

  it("re-registers a moved directory and persists its new relative path", async () => {
    const { base, mountBase, drive } = await setup();
    const registry = new VolumeRegistry(
      join(base, "updated.json"),
      mountBase,
      0,
    );
    const first = await registry.register(drive);
    const newRoot = join(mountBase, "Seagate", "Movies");
    await rename(drive, newRoot);
    const next = await registry.register(newRoot);
    expect(next.id).toBe(first.id);
    expect(next.mountRelativePath).toBe("Movies");
    await rename(join(mountBase, "Seagate"), join(mountBase, "Remounted"));
    expect(await registry.resolve(first.id)).toEqual({
      state: "online",
      root: join(mountBase, "Remounted", "Movies"),
    });
  });

  it("never chooses a duplicate marker or adopts a clone during re-registration", async () => {
    const { base, mountBase, drive } = await setup();
    const clone = join(mountBase, "Clone", "HoshiStream");
    await mkdir(clone, { recursive: true });
    const registry = new VolumeRegistry(
      join(base, "injected.json"),
      {
        enumerateMounts: async () => [
          join(mountBase, "Seagate"),
          join(mountBase, "Clone"),
        ],
      },
      0,
    );
    const first = await registry.register(drive);
    await writeFile(
      join(clone, MARKER_FILENAME),
      await readFile(join(drive, MARKER_FILENAME)),
    );
    expect((await registry.resolve(first.id)).state).toBe("ambiguous");
    await expect(registry.register(clone)).rejects.toThrow("duplicate");
    expect((await registry.get(first.id))?.lastKnownRoot).toBe(drive);
  });

  it("deduplicates junction aliases rather than treating one directory as a clone", async () => {
    const { base, drive } = await setup();
    const alias = join(base, "alias");
    await symlink(drive, alias, "junction");
    const registry = new VolumeRegistry(join(base, "aliases.json"), {
      enumerateMounts: async () => [drive, alias],
    });
    const first = await registry.register(drive);
    expect(await registry.resolve(first.id)).toEqual({
      state: "online",
      root: drive,
    });
  });

  it("checks the old relative path for clones before accepting a moved folder", async () => {
    const { base, mountBase, drive } = await setup();
    const registry = new VolumeRegistry(
      join(base, "clones.json"),
      mountBase,
      0,
    );
    const first = await registry.register(drive);
    const clonedRoot = join(mountBase, "Clone", "HoshiStream");
    await mkdir(clonedRoot, { recursive: true });
    await writeFile(
      join(clonedRoot, MARKER_FILENAME),
      await readFile(join(drive, MARKER_FILENAME)),
    );
    const movedRoot = join(mountBase, "Seagate", "Renamed folder");
    await rename(drive, movedRoot);
    await expect(registry.register(movedRoot)).rejects.toThrow("duplicate");
    expect((await registry.get(first.id))?.lastKnownRoot).toBe(drive);
  });

  it.each(["EPERM", "EACCES", "EROFS"])(
    "reports marker write permission failures (%s)",
    async (code) => {
      const { drive, registry } = await setup();
      vi.spyOn(fs, "writeFile").mockRejectedValueOnce(
        Object.assign(new Error("denied"), { code }),
      );
      await expect(registry.register(drive)).rejects.toThrow("not writable");
      expect(await registry.list()).toEqual([]);
    },
  );

  it("preserves the old registry after rename contention and adopts the marker on retry", async () => {
    const { mountBase, drive, registry } = await setup();
    const first = await registry.register(drive);
    const secondRoot = join(mountBase, "New");
    await mkdir(secondRoot);
    vi.spyOn(fs, "rename").mockRejectedValueOnce(
      Object.assign(new Error("busy"), { code: "EPERM" }),
    );
    await expect(registry.register(secondRoot)).rejects.toMatchObject({
      code: "EPERM",
    });
    expect((await registry.list()).map((volume) => volume.id)).toEqual([
      first.id,
    ]);
    const marker = JSON.parse(
      await readFile(join(secondRoot, MARKER_FILENAME), "utf8"),
    );
    const second = await registry.register(secondRoot);
    expect(second.id).toBe(marker.volumeId);
    expect(await registry.list()).toHaveLength(2);
  });

  it("reports denied enumeration and surfaces other discovery failures", async () => {
    const { base, drive } = await setup();
    const enumerateMounts = vi.fn(async () => [drive]);
    const registry = new VolumeRegistry(
      join(base, "permissions.json"),
      { enumerateMounts },
      0,
    );
    const volume = await registry.register(drive);
    enumerateMounts.mockRejectedValueOnce(
      Object.assign(new Error("denied"), { code: "EACCES" }),
    );
    expect(await registry.resolve(volume.id)).toEqual({
      state: "permission-denied",
    });
    enumerateMounts.mockRejectedValueOnce(new Error("enumerator timeout"));
    await expect(registry.resolve(volume.id)).rejects.toThrow(
      "Cannot enumerate",
    );
  });

  it("reports unreadable marker candidates rather than claiming a drive is offline", async () => {
    const { drive, registry } = await setup();
    const volume = await registry.register(drive);
    vi.spyOn(fs, "readFile").mockRejectedValueOnce(
      Object.assign(new Error("denied"), { code: "EPERM" }),
    );
    expect(await registry.resolve(volume.id)).toEqual({
      state: "permission-denied",
    });
  });
});
