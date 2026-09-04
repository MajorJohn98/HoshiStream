import { z } from "zod";
import {
  describeWindow,
  formatTime,
  parseTime,
  TIME_PATTERN,
  withinWindow,
} from "../archive-schedule.js";
import {
  buildManifest,
  computeSourceRevision,
  defaultRelativeDir,
  DiskCopyError,
  reconcileFiles,
  removeDiskCopyDirectory,
} from "../disk-copy.js";
import { inspectEntry } from "../inspection.js";
import { body, logInfo, reply, type RouteHandler } from "./context.js";

const diskCopyRequestSchema = z.object({
  enabled: z.boolean(),
  volumeId: z.string().min(1).optional(),
  scope: z.enum(["all", "selected"]).optional(),
  includedSourceKeys: z.array(z.string().min(1)).max(10_000).optional(),
  deleteFiles: z.boolean().optional(),
});
const diskScheduleRequestSchema = z
  .object({
    enabled: z.boolean(),
    start: z.string().regex(TIME_PATTERN).optional(),
    end: z.string().regex(TIME_PATTERN).optional(),
  })
  .refine((input) => !input.enabled || (input.start && input.end), {
    message: "start and end are required to enable the window",
  });

export const handleVolumes: RouteHandler = async (
  { volumes, diskCleanup, nativePicker },
  { response, url, method },
) => {
  const volumeMatch = /^\/api\/volumes\/([^/]+)$/.exec(url.pathname);
  const collection = url.pathname === "/api/volumes";
  const matched =
    (collection && (method === "GET" || method === "POST")) ||
    (volumeMatch && method === "DELETE");
  if (!matched) return false;
  if (!volumes) return reply(response, 409, { error: "Volumes unavailable" });
  if (collection && method === "GET") {
    // Volume polls are the lazy trigger for deferred cleanup: a drive that
    // just came back gets its pending deletions applied here.
    if (diskCleanup) await diskCleanup.sweep(volumes).catch(() => undefined);
    return reply(response, 200, { volumes: await volumes.statusAll() });
  }
  if (collection && method === "POST") {
    const selected = await nativePicker.selectStorage();
    const volume = await volumes.register(selected);
    logInfo("volume_registered", { volumeId: volume.id, label: volume.label });
    const statuses = await volumes.statusAll();
    return reply(
      response,
      201,
      statuses.find((status) => status.id === volume.id) ?? volume,
    );
  }
  if (volumeMatch) {
    const volumeId = decodeURIComponent(volumeMatch[1]);
    const removed = await volumes.forget(volumeId);
    if (removed) logInfo("volume_forgotten", { volumeId });
    return reply(response, removed ? 204 : 404, { error: "Not found" });
  }
  return false;
};

export const handleDiskCopy: RouteHandler = async (
  { library, torrServer, volumes, diskCleanup, archiver },
  { request, response, url, method },
) => {
  const diskCopyMatch = /^\/api\/library\/([^/]+)\/disk-copy$/.exec(
    url.pathname,
  );
  const retryMatch = /^\/api\/library\/([^/]+)\/disk-copy\/retry$/.exec(
    url.pathname,
  );
  if (
    !(diskCopyMatch && method === "PUT") &&
    !(retryMatch && method === "POST")
  )
    return false;
  if (!volumes) return reply(response, 409, { error: "Volumes unavailable" });

  if (retryMatch) {
    const id = decodeURIComponent(retryMatch[1]);
    const entry = await library.get(id);
    if (!entry) return reply(response, 404, { error: "Not found" });
    const current = entry.diskCopy;
    if (!current)
      return reply(response, 409, { error: "Disk copy is not enabled" });
    let files = buildManifest(entry, {
      scope: current.scope,
      previous: current.files,
    });
    const resolution = await volumes.resolve(current.volumeId);
    if (resolution.state === "online") {
      files = (
        await reconcileFiles(resolution.root, current.relativeDir, files, {
          retry: true,
        })
      ).files;
    } else {
      // Drive offline: the explicit retry still clears sticky invalid states
      // so work resumes when it returns.
      files = files.map((file) =>
        file.state === "invalid"
          ? { ...file, state: "missing" as const }
          : file,
      );
    }
    await library.setDiskCopy(id, {
      ...current,
      files,
      sourceRevision: computeSourceRevision(files),
      updatedAt: new Date().toISOString(),
    });
    archiver?.enqueue(id);
    return reply(response, 200, await library.get(id));
  }

  const id = decodeURIComponent(diskCopyMatch![1]);
  let entry = await library.get(id);
  if (!entry) return reply(response, 404, { error: "Not found" });
  const input = diskCopyRequestSchema.parse(await body(request));
  const current = entry.diskCopy;
  const cleanup = async (volumeId: string, relativeDir: string) => {
    const resolution = await volumes.resolve(volumeId);
    if (resolution.state === "online") {
      await removeDiskCopyDirectory(resolution.root, relativeDir);
    } else if (diskCleanup) {
      // Deferred: applied by the sweep when the drive returns.
      await diskCleanup.add({ volumeId, relativeDir, entryId: id });
    }
  };
  if (!input.enabled) {
    archiver?.cancel(id);
    if (current && input.deleteFiles) {
      await cleanup(current.volumeId, current.relativeDir);
    }
    await library.setDiskCopy(id, undefined);
    logInfo("disk_copy_disabled", {
      entryId: id,
      deleteFiles: Boolean(input.deleteFiles),
    });
    return reply(response, 200, await library.get(id));
  }
  if (
    entry.localFilePath ||
    entry.localFolderPath ||
    !(entry.magnetUri || entry.torrentFilePath)
  ) {
    throw new DiskCopyError("Disk copies require a torrent-backed entry");
  }
  const volumeId = input.volumeId ?? current?.volumeId;
  if (!volumeId) throw new DiskCopyError("Choose a storage volume");
  if (!(await volumes.get(volumeId)))
    throw new DiskCopyError("Unknown storage volume");
  if (current && current.volumeId !== volumeId && input.deleteFiles) {
    await cleanup(current.volumeId, current.relativeDir);
  }
  if (!entry.inspectionCache) {
    await inspectEntry(entry, torrServer, library);
    entry = await library.get(id);
    if (!entry?.inspectionCache)
      throw new DiskCopyError("Torrent inspection failed");
  }
  const previous = current?.volumeId === volumeId ? current : undefined;
  const scope = input.scope ?? previous?.scope ?? "all";
  let files = buildManifest(entry, {
    scope,
    includedSourceKeys: input.includedSourceKeys,
    previous: previous?.files,
  });
  const relativeDir = previous?.relativeDir ?? defaultRelativeDir(entry);
  const resolution = await volumes.resolve(volumeId);
  if (resolution.state === "online") {
    // Adopt files that already exist on the drive (idempotent re-enable)
    // before persisting the manifest.
    files = (await reconcileFiles(resolution.root, relativeDir, files)).files;
  }
  await library.setDiskCopy(id, {
    desired: "keep",
    volumeId,
    relativeDir,
    sourceRevision: computeSourceRevision(files),
    scope,
    files,
    updatedAt: new Date().toISOString(),
  });
  logInfo("disk_copy_enabled", {
    entryId: id,
    volumeId,
    scope,
    files: files.length,
    included: files.filter((file) => file.included).length,
  });
  archiver?.enqueue(id);
  return reply(response, 200, await library.get(id));
};

export const handleDiskJobs: RouteHandler = async (
  { archiver },
  { response, url, method },
) => {
  if (url.pathname !== "/api/disk-jobs" || method !== "GET") return false;
  if (!archiver) return reply(response, 409, { error: "Archiver unavailable" });
  return reply(response, 200, { jobs: archiver.jobs() });
};

export const handleDiskSchedule: RouteHandler = async (
  { archiveSchedule, archiver },
  { request, response, url, method },
) => {
  if (url.pathname !== "/api/disk-schedule") return false;
  if (!archiveSchedule)
    return reply(response, 409, { error: "Schedule unavailable" });
  if (method === "PUT") {
    const input = diskScheduleRequestSchema.parse(await body(request));
    await archiveSchedule.set(
      input.enabled
        ? {
            startMinute: parseTime(input.start!),
            endMinute: parseTime(input.end!),
          }
        : undefined,
    );
    // Re-check waiting entries: the window may have just opened.
    archiver?.wake();
    logInfo("disk_schedule_updated", {
      window: input.enabled ? `${input.start}-${input.end}` : "always",
    });
  } else if (method !== "GET") {
    return reply(response, 405, { error: "Method not allowed" });
  }
  const window = await archiveSchedule.window();
  return reply(response, 200, {
    window: window
      ? {
          start: formatTime(window.startMinute),
          end: formatTime(window.endMinute),
          label: describeWindow(window),
        }
      : null,
    active: withinWindow(window),
  });
};
