import { z } from "zod";
import { isAbsolute } from "node:path";
import { directPlaySchema } from "./direct-play.js";
import { isSafeRelativePath } from "./path-safety.js";

const absolutePath = z.string().refine(isAbsolute, {
  message: "Local media path must be absolute",
});

// Extra torrents only make sense on a torrent-backed series: episodes merge
// across torrents, while movies and local media stay single-source.
function torrentBackedSeriesRule(entry: {
  type?: "movie" | "series";
  magnetUri?: string;
  torrentFilePath?: string;
  localFilePath?: string;
  localFolderPath?: string;
  extraSources?: unknown[];
}): boolean {
  if (!entry.extraSources?.length) return true;
  return (
    entry.type === "series" &&
    Boolean(entry.magnetUri || entry.torrentFilePath) &&
    !entry.localFilePath &&
    !entry.localFolderPath
  );
}
const fileOverrideSchema = z.object({
  id: z.number().int().nonnegative(),
  included: z.boolean(),
  // Season 0 is the conventional "specials" season, so it must be allowed.
  season: z.number().int().nonnegative().optional(),
  episode: z.number().int().positive().optional(),
});
// An additional torrent backing a series entry (multi-torrent series). File
// override ids here are the source's own TorrServer file indexes.
export const seriesSourceSchema = z
  .object({
    magnetUri: z.string().startsWith("magnet:?").optional(),
    torrentFilePath: z.string().endsWith(".torrent").optional(),
    // Files whose names don't parse into season/episode default to this
    // season (unlabeled season packs, single-episode releases).
    seasonHint: z.number().int().nonnegative().optional(),
    fileOverrides: z.array(fileOverrideSchema).optional(),
  })
  .refine((source) => source.magnetUri || source.torrentFilePath, {
    message: "Each extra source needs magnetUri or torrentFilePath",
  });
const cachedFileSchema = z.object({
  id: z.number().int().nonnegative(),
  path: z.string().min(1),
  length: z.number().int().nonnegative(),
  season: z.number().int().nonnegative().optional(),
  episode: z.number().int().positive().optional(),
  // Torrent hash of the owning source, for multi-torrent series. Absent for
  // files from the primary source (inspectionCache.hash applies).
  hash: z.string().min(1).optional(),
});
export const inspectionCacheSchema = z.object({
  hash: z.string().min(1),
  selectedFiles: z.array(cachedFileSchema).min(1),
  inspectedAt: z.string().datetime(),
});

export const playbackStateSchema = z.object({
  positionSeconds: z.number().nonnegative(),
  // Which file the position belongs to, so a series resumes the right episode.
  fileId: z.number().int().nonnegative().optional(),
  updatedAt: z.string().datetime(),
});

// Disk library (see plans/2026-09-02-disk-library-plan.md). Files are keyed
// by "<torrent-hash>:<raw-file-id>" — raw TorrServer ids can collide across a
// series' sources, hashes cannot. Only durable state lives here; transfer
// progress is runtime-only.
const safeRelativePath = z.string().min(1).refine(isSafeRelativePath, {
  message: "Relative path must not escape its base directory",
});
export const diskCopyFileSchema = z.object({
  sourceKey: z.string().regex(/^[0-9a-fA-F]+:\d+$/),
  relativePath: safeRelativePath,
  length: z.number().int().nonnegative(),
  // Per-episode intent: only included files are archived.
  included: z.boolean(),
  state: z.enum(["missing", "partial", "complete", "invalid"]),
});
export const diskCopySchema = z.object({
  // "remove" persists only while deferred cleanup is outstanding; a settled
  // disable removes diskCopy from the entry entirely.
  desired: z.enum(["keep", "remove"]),
  volumeId: z.string().min(1),
  relativeDir: safeRelativePath,
  // Fingerprint of the selected source files; a mismatch tells the
  // reconciler the copy is stale rather than current.
  sourceRevision: z.string().min(1),
  // "all" tracks the entry's selected files as they change; "selected"
  // freezes intent to the explicitly included files.
  scope: z.enum(["all", "selected"]),
  files: z.array(diskCopyFileSchema),
  updatedAt: z.string().datetime(),
});

// Disk copies duplicate a torrent source; local entries are already on disk.
function diskCopyRule(entry: {
  magnetUri?: string;
  torrentFilePath?: string;
  localFilePath?: string;
  localFolderPath?: string;
  diskCopy?: unknown;
}): boolean {
  if (!entry.diskCopy) return true;
  return (
    Boolean(entry.magnetUri || entry.torrentFilePath) &&
    !entry.localFilePath &&
    !entry.localFolderPath
  );
}

export const libraryEntrySchema = z
  .object({
    id: z.string().min(1),
    type: z.enum(["movie", "series"]),
    name: z.string().min(1),
    description: z.string().optional(),
    poster: z.string().url().optional(),
    background: z.string().url().optional(),
    magnetUri: z.string().startsWith("magnet:?").optional(),
    torrentFilePath: z.string().endsWith(".torrent").optional(),
    localFilePath: absolutePath.optional(),
    localFolderPath: absolutePath.optional(),
    managedMedia: z.boolean().optional(),
    preferredFileIndex: z.number().int().nonnegative().optional(),
    fileOverrides: z.array(fileOverrideSchema).optional(),
    // Additional torrents merged into this series' episode list. Torrent-
    // backed series only; validated by entrySourceRules below.
    extraSources: z.array(seriesSourceSchema).optional(),
    // Always offer the repaired "Compatible" stream, even when the probe
    // verdict predicts direct play would work (ADR 0010).
    forceTranscode: z.boolean().optional(),
    inspectionCache: inspectionCacheSchema.optional(),
    directPlay: directPlaySchema.optional(),
    playback: playbackStateSchema.optional(),
    diskCopy: diskCopySchema.optional(),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
  })
  .refine(
    (entry) =>
      entry.magnetUri ||
      entry.torrentFilePath ||
      entry.localFilePath ||
      entry.localFolderPath,
    {
      message:
        "magnetUri, torrentFilePath, localFilePath, or localFolderPath is required",
    },
  )
  .refine(torrentBackedSeriesRule, {
    message: "extraSources requires a torrent-backed series entry",
  })
  .refine(diskCopyRule, {
    message: "diskCopy requires a torrent-backed entry",
  });

export const createEntrySchema = libraryEntrySchema
  .omit({
    id: true,
    inspectionCache: true,
    directPlay: true,
    playback: true,
    diskCopy: true,
    createdAt: true,
    updatedAt: true,
  })
  .refine(
    (entry) =>
      entry.magnetUri ||
      entry.torrentFilePath ||
      entry.localFilePath ||
      entry.localFolderPath,
    {
      message:
        "magnetUri, torrentFilePath, localFilePath, or localFolderPath is required",
    },
  )
  .refine(torrentBackedSeriesRule, {
    message: "extraSources requires a torrent-backed series entry",
  });

export const patchEntrySchema = createEntrySchema.partial().extend({
  description: z.string().nullable().optional(),
  poster: z.string().url().nullable().optional(),
  background: z.string().url().nullable().optional(),
});

export type LibraryEntry = z.infer<typeof libraryEntrySchema>;
export type SeriesSource = z.infer<typeof seriesSourceSchema>;
export type InspectionCache = z.infer<typeof inspectionCacheSchema>;
export type PlaybackState = z.infer<typeof playbackStateSchema>;
export type DiskCopy = z.infer<typeof diskCopySchema>;
export type DiskCopyFile = z.infer<typeof diskCopyFileSchema>;
export type CreateEntry = z.infer<typeof createEntrySchema>;
export type PatchEntry = z.infer<typeof patchEntrySchema>;
export type ContentType = LibraryEntry["type"];
