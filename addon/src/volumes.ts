import { randomUUID } from "node:crypto";
import {
  copyFile,
  mkdir,
  readdir,
  readFile,
  realpath,
  rename,
  stat,
  statfs,
  unlink,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, join, relative } from "node:path";
import { z } from "zod";
import { containsPath } from "./path-safety.ts";

// A drive is identified by this marker, never by its mount path or name. The
// marker carries only a format version and a random id — no tokens, no URIs.
export const MARKER_FILENAME = ".hoshistream-volume.json";
const MARKER_MAX_BYTES = 4_096;
const RESOLUTION_TTL_MS = 10_000;

const markerSchema = z.object({
  format: z.literal(1),
  volumeId: z.string().uuid(),
});

export const storageVolumeSchema = z.object({
  id: z.string().uuid(),
  label: z.string().min(1),
  lastKnownRoot: z.string().min(1),
  // Root's path below its mount point ("" when the root is the mount itself).
  // Absent for internal folders, which never change mount paths and are only
  // resolved via lastKnownRoot.
  mountRelativePath: z.string().optional(),
  createdAt: z.string().datetime(),
});

export type StorageVolume = z.infer<typeof storageVolumeSchema>;

const registrySchema = z.array(storageVolumeSchema);

export type VolumeResolution =
  | { state: "online"; root: string }
  | { state: "offline" }
  | { state: "ambiguous"; roots: string[] }
  | { state: "permission-denied" };

export interface VolumeStatus {
  id: string;
  label: string;
  state: VolumeResolution["state"];
  root?: string;
  freeBytes?: number;
  totalBytes?: number;
  createdAt: string;
}

export class VolumeError extends Error {}

function defaultMountBase(): string | undefined {
  return process.platform === "darwin" ? "/Volumes" : undefined;
}

type MarkerRead =
  | { ok: true; volumeId: string }
  | { ok: false; reason: "missing" | "invalid" | "permission" };

async function readMarker(root: string): Promise<MarkerRead> {
  const path = join(root, MARKER_FILENAME);
  try {
    const info = await stat(path);
    if (!info.isFile() || info.size > MARKER_MAX_BYTES)
      return { ok: false, reason: "invalid" };
    const marker = markerSchema.parse(JSON.parse(await readFile(path, "utf8")));
    return { ok: true, volumeId: marker.volumeId };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR")
      return { ok: false, reason: "missing" };
    if (code === "EACCES" || code === "EPERM")
      return { ok: false, reason: "permission" };
    return { ok: false, reason: "invalid" };
  }
}

export class VolumeRegistry {
  private queue: Promise<void> = Promise.resolve();
  private cache?: { mtimeMs: number; size: number; volumes: StorageVolume[] };
  private readonly resolutions = new Map<
    string,
    { expiresAt: number; value: VolumeResolution }
  >();
  private readonly path: string;
  private readonly mountBase: string | undefined;
  private readonly resolutionTtlMs: number;

  constructor(
    path: string,
    mountBase = defaultMountBase(),
    resolutionTtlMs = RESOLUTION_TTL_MS,
  ) {
    this.path = path;
    this.mountBase = mountBase;
    this.resolutionTtlMs = resolutionTtlMs;
  }

  async list(): Promise<StorageVolume[]> {
    await this.queue;
    return this.read();
  }

  async get(id: string): Promise<StorageVolume | undefined> {
    return (await this.list()).find((volume) => volume.id === id);
  }

  /**
   * Register a folder as a storage volume. Idempotent: a folder that already
   * carries a known marker returns the existing volume, and a valid marker
   * from another registry (e.g. after a reinstall) is adopted under its
   * original id.
   */
  register(rawPath: string): Promise<StorageVolume> {
    return this.update(async (volumes) => {
      const root = await realpath(rawPath);
      if (!(await stat(root)).isDirectory())
        throw new VolumeError("Choose a folder to use as storage");
      const marker = await readMarker(root);
      if (marker.ok) {
        const existing = volumes.find(
          (volume) => volume.id === marker.volumeId,
        );
        if (existing) {
          existing.lastKnownRoot = root;
          this.resolutions.delete(existing.id);
          return existing;
        }
      } else if (marker.reason === "invalid") {
        throw new VolumeError(
          "Folder contains an invalid HoshiStream volume marker",
        );
      } else if (marker.reason === "permission") {
        throw new VolumeError("Folder is not readable");
      }
      for (const volume of volumes) {
        if (
          volume.lastKnownRoot === root ||
          containsPath(volume.lastKnownRoot, root) ||
          containsPath(root, volume.lastKnownRoot)
        ) {
          throw new VolumeError(
            `Folder overlaps the registered volume "${volume.label}"`,
          );
        }
      }
      const id = marker.ok ? marker.volumeId : randomUUID();
      if (!marker.ok) {
        // Write, then read back: the marker is the registration transaction.
        try {
          await writeFile(
            join(root, MARKER_FILENAME),
            `${JSON.stringify({ format: 1, volumeId: id }, null, 2)}\n`,
            { flag: "wx" },
          );
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "EROFS")
            throw new VolumeError("Folder is not writable");
          if ((error as NodeJS.ErrnoException).code === "EACCES")
            throw new VolumeError("Folder is not writable");
          throw error;
        }
        const verify = await readMarker(root);
        if (!verify.ok || verify.volumeId !== id)
          throw new VolumeError("Volume marker could not be verified");
      }
      const volume = storageVolumeSchema.parse({
        id,
        label: basename(root) || root,
        lastKnownRoot: root,
        mountRelativePath: this.mountRelativePath(root),
        createdAt: new Date().toISOString(),
      });
      volumes.push(volume);
      this.resolutions.delete(id);
      return volume;
    });
  }

  /** Forget a volume. The marker and any media on the drive are untouched. */
  forget(id: string): Promise<boolean> {
    return this.update(async (volumes) => {
      const index = volumes.findIndex((volume) => volume.id === id);
      if (index === -1) return false;
      volumes.splice(index, 1);
      this.resolutions.delete(id);
      return true;
    });
  }

  /**
   * Resolve a volume to its live mount. Checks lastKnownRoot first, then
   * rescans mounted volumes for the marker so a drive that remounted under a
   * new name is still found. Results are cached briefly (~10 s).
   */
  async resolve(id: string): Promise<VolumeResolution> {
    const cached = this.resolutions.get(id);
    if (cached && cached.expiresAt > Date.now()) return cached.value;
    const volume = await this.get(id);
    if (!volume) return { state: "offline" };
    const value = await this.locate(volume);
    this.resolutions.set(id, {
      expiresAt: Date.now() + this.resolutionTtlMs,
      value,
    });
    if (value.state === "online" && value.root !== volume.lastKnownRoot) {
      await this.update(async (volumes) => {
        const current = volumes.find((entry) => entry.id === id);
        if (current) current.lastKnownRoot = value.root;
      });
    }
    return value;
  }

  /** Volume list decorated with live state and free space, for the API. */
  async statusAll(): Promise<VolumeStatus[]> {
    const volumes = await this.list();
    return Promise.all(
      volumes.map(async (volume) => {
        const resolution = await this.resolve(volume.id);
        const status: VolumeStatus = {
          id: volume.id,
          label: volume.label,
          state: resolution.state,
          createdAt: volume.createdAt,
        };
        if (resolution.state === "online") {
          status.root = resolution.root;
          try {
            const space = await statfs(resolution.root);
            status.freeBytes = space.bavail * space.bsize;
            status.totalBytes = space.blocks * space.bsize;
          } catch {
            // Free space is informational; resolution already succeeded.
          }
        }
        return status;
      }),
    );
  }

  private async locate(volume: StorageVolume): Promise<VolumeResolution> {
    const candidates = new Set<string>([volume.lastKnownRoot]);
    if (volume.mountRelativePath !== undefined && this.mountBase) {
      const mounts = await readdir(this.mountBase).catch(() => []);
      for (const mount of mounts) {
        candidates.add(join(this.mountBase, mount, volume.mountRelativePath));
      }
    }
    const matches = new Set<string>();
    let permissionDenied = false;
    for (const candidate of candidates) {
      const marker = await readMarker(candidate);
      if (marker.ok && marker.volumeId === volume.id) {
        // realpath dedupes firmlink/symlink aliases of the same directory.
        matches.add(await realpath(candidate).catch(() => candidate));
      } else if (!marker.ok && marker.reason === "permission") {
        permissionDenied = true;
      }
    }
    if (matches.size === 1) {
      const [root] = matches;
      return { state: "online", root };
    }
    if (matches.size > 1)
      return { state: "ambiguous", roots: [...matches].sort() };
    return permissionDenied
      ? { state: "permission-denied" }
      : { state: "offline" };
  }

  private mountRelativePath(root: string): string | undefined {
    if (!this.mountBase) return undefined;
    if (root === this.mountBase) return "";
    if (!containsPath(this.mountBase, root)) return undefined;
    const [mount, ...rest] = relative(this.mountBase, root).split("/");
    return mount ? rest.join("/") : undefined;
  }

  private async read(): Promise<StorageVolume[]> {
    try {
      const info = await stat(this.path);
      if (
        this.cache &&
        this.cache.mtimeMs === info.mtimeMs &&
        this.cache.size === info.size
      ) {
        return structuredClone(this.cache.volumes);
      }
      const volumes = await this.parse(this.path);
      this.cache = { mtimeMs: info.mtimeMs, size: info.size, volumes };
      return structuredClone(volumes);
    } catch (error) {
      this.cache = undefined;
      return this.recover(error);
    }
  }

  private async parse(path: string): Promise<StorageVolume[]> {
    return registrySchema.parse(JSON.parse(await readFile(path, "utf8")));
  }

  private async recover(cause: unknown): Promise<StorageVolume[]> {
    const missing =
      cause instanceof Error &&
      (cause as NodeJS.ErrnoException).code === "ENOENT";
    let volumes: StorageVolume[];
    try {
      volumes = await this.parse(this.backupPath);
    } catch (backupError) {
      const backupMissing =
        backupError instanceof Error &&
        (backupError as NodeJS.ErrnoException).code === "ENOENT";
      if (missing && backupMissing) return [];
      throw new VolumeError(
        `Cannot read volumes: ${cause instanceof Error ? cause.message : cause}`,
      );
    }
    if (!missing) {
      await rename(this.path, `${this.path}.corrupt-${Date.now()}`).catch(
        () => undefined,
      );
    }
    await copyFile(this.backupPath, this.path).catch(() => undefined);
    console.error(
      JSON.stringify({
        level: "warn",
        event: "volumes_recovered_from_backup",
        volumes: volumes.length,
        error: cause instanceof Error ? cause.message : String(cause),
      }),
    );
    return volumes;
  }

  private get backupPath(): string {
    return `${this.path}.bak`;
  }

  private update<T>(
    change: (volumes: StorageVolume[]) => Promise<T>,
  ): Promise<T> {
    const operation = this.queue.then(async () => {
      const volumes = await this.read();
      const result = await change(volumes);
      await this.write(volumes);
      return result;
    });
    this.queue = operation.then(
      () => undefined,
      () => undefined,
    );
    return operation;
  }

  private async write(volumes: StorageVolume[]): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true });
    const temporaryPath = `${this.path}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporaryPath, `${JSON.stringify(volumes, null, 2)}\n`, {
        mode: 0o600,
      });
      await rename(temporaryPath, this.path);
      const info = await stat(this.path).catch(() => undefined);
      this.cache = info
        ? {
            mtimeMs: info.mtimeMs,
            size: info.size,
            volumes: structuredClone(volumes),
          }
        : undefined;
      await copyFile(this.path, this.backupPath).catch(() => undefined);
    } catch (error) {
      this.cache = undefined;
      await unlink(temporaryPath).catch(() => undefined);
      throw error;
    }
  }
}
