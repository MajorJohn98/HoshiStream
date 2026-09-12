import { z } from "zod";
import { isAbsolute } from "node:path";
import { directPlaySchema } from "./direct-play.ts";
import { isSafeRelativePath } from "./path-safety.ts";
import { entryTagsSchema } from "./tags.ts";
import { mediaFactSchema, sourceCheckSchema } from "./source-check-types.ts";

const LEGACY_SEARCH_PROVIDER_IDS = [
  "curated",
  "yts",
  "nyaa",
  "1337x",
  "prowlarr",
  "jackett",
] as const;

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
// Explicit season/episode for one file, keyed by the entry-wide (composite)
// file id. Applied after automatic mapping and source merging, so
// re-inspection and later sources never silently undo a repair.
const episodeOverrideSchema = z.object({
  id: z.number().int().nonnegative(),
  season: z.number().int().nonnegative(),
  episode: z.number().int().positive(),
});
export const episodeOverridesSchema = z
  .array(episodeOverrideSchema)
  .superRefine((overrides, ctx) => {
    const ids = new Set<number>();
    const slots = new Set<string>();
    for (const override of overrides) {
      if (ids.has(override.id))
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `File ${override.id} is mapped more than once`,
        });
      ids.add(override.id);
      const slot = `${override.season}:${override.episode}`;
      if (slots.has(slot))
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Two files are mapped to season ${override.season} episode ${override.episode}`,
        });
      slots.add(slot);
    }
  });
export type EpisodeOverride = z.infer<typeof episodeOverrideSchema>;
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
  // Who wrote it: the in-browser player or the host (mpv) player. External
  // Stremio clients never write playback state; they only touch
  // lastStreamedAt. Absent on records from before this field existed.
  source: z.enum(["browser", "host"]).optional(),
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
  // User-paused: the archiver skips this entry until resumed, even after a
  // restart or a drive reconnect.
  paused: z.boolean().optional(),
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

export const searchImportSchema = z
  .object({
    providerId: z.enum(LEGACY_SEARCH_PROVIDER_IDS),
    catalogId: z.string().min(1).optional(),
    sourceId: z.string().min(1).optional(),
    indexerId: z.string().min(1).optional(),
    hash: z.string().regex(/^[0-9a-f]{40}$/),
    rightsUrl: z.string().url().optional(),
    license: z.string().min(1).optional(),
    creator: z.string().min(1).optional(),
    filmPath: safeRelativePath.optional(),
    filmSizeBytes: z.number().int().positive().safe().optional(),
    retrievalWarnings: z.array(z.string().max(500)).max(5).optional(),
  })
  .refine(
    (source) =>
      source.providerId === "curated"
        ? Boolean(source.catalogId && source.rightsUrl && source.license)
        : Boolean(
            source.sourceId &&
            (source.providerId === "prowlarr" || source.providerId === "jackett"
              ? source.indexerId
              : true),
          ),
    { message: "Search import is missing its provider's provenance" },
  );
export const searchReceiptSchema = z.object({
  key: z.string().uuid(),
  fingerprint: z.string().regex(/^[0-9a-f]{64}$/),
});
export type SearchImport = z.infer<typeof searchImportSchema>;
export type SearchReceipt = z.infer<typeof searchReceiptSchema>;

// File override ids here are the source's own TorrServer file indexes.
export const seriesSourceSchema = z
  .object({
    magnetUri: z.string().startsWith("magnet:?").optional(),
    torrentFilePath: z.string().endsWith(".torrent").optional(),
    sourceHash: z
      .string()
      .regex(/^[0-9a-f]{40}$/)
      .optional(),
    seasonHint: z.number().int().nonnegative().optional(),
    fileOverrides: z.array(fileOverrideSchema).optional(),
    managedMedia: z.boolean().optional(),
    searchImport: searchImportSchema.optional(),
  })
  .refine((source) => source.magnetUri || source.torrentFilePath, {
    message: "Each extra source needs magnetUri or torrentFilePath",
  });

// Optional presentation metadata Stremio renders on the detail page. All
// additive and user-entered; shapes are validated but nothing is fetched.
const shortText = z.string().trim().min(1).max(200);
const nameList = z.array(shortText).max(50);
export const YOUTUBE_ID = /^[A-Za-z0-9_-]{11}$/;
export const trailerSchema = z.object({
  source: z.string().regex(YOUTUBE_ID, "Expected an 11-character YouTube id"),
  type: z.literal("Trailer"),
});
export const posterShapeSchema = z.enum(["poster", "landscape", "square"]);
export const titleMetadataSchema = z.object({
  // "2019" or "2019-2021".
  releaseInfo: z
    .string()
    .trim()
    .regex(/^\d{4}(?:[-–]\d{0,4})?$/, "Expected a year or a year range")
    .optional(),
  // Free text as Stremio shows it, e.g. "1h 52m".
  runtime: z.string().trim().min(1).max(40).optional(),
  // 0–10 with at most one decimal, kept as the string Stremio displays.
  imdbRating: z
    .string()
    .trim()
    .regex(/^(?:10(?:\.0)?|[0-9](?:\.[0-9])?)$/, "Expected 0–10, one decimal")
    .optional(),
  cast: nameList.optional(),
  director: nameList.optional(),
  writer: nameList.optional(),
  country: shortText.optional(),
  language: shortText.optional(),
  logo: z.string().url().optional(),
  awards: z.string().trim().min(1).max(300).optional(),
  trailers: z.array(trailerSchema).max(10).optional(),
  posterShape: posterShapeSchema.optional(),
});
export type TitleMetadata = z.infer<typeof titleMetadataSchema>;
export const TITLE_METADATA_FIELDS = Object.keys(
  titleMetadataSchema.shape,
) as (keyof TitleMetadata)[];

export const libraryEntrySchema = z
  .object({
    id: z.string().min(1),
    type: z.enum(["movie", "series"]),
    name: z.string().min(1),
    description: z.string().optional(),
    poster: z.string().url().optional(),
    background: z.string().url().optional(),
    // Genre-style labels from the tag registry (src/tags.ts), stored by name.
    tags: entryTagsSchema.optional(),
    ...titleMetadataSchema.shape,
    magnetUri: z.string().startsWith("magnet:?").optional(),
    torrentFilePath: z.string().endsWith(".torrent").optional(),
    localFilePath: absolutePath.optional(),
    localFolderPath: absolutePath.optional(),
    managedMedia: z.boolean().optional(),
    sourceHash: z
      .string()
      .regex(/^[0-9a-f]{40}$/)
      .optional(),
    preferredFileIndex: z.number().int().nonnegative().optional(),
    fileOverrides: z.array(fileOverrideSchema).optional(),
    // Additional torrents merged into this series' episode list. Torrent-
    // backed series only; validated by entrySourceRules below.
    extraSources: z.array(seriesSourceSchema).optional(),
    // Manual season/episode repairs; see episodeOverrideSchema.
    episodeOverrides: episodeOverridesSchema.optional(),
    // Always offer the repaired "Compatible" stream, even when the probe
    // verdict predicts direct play would work (ADR 0010).
    forceTranscode: z.boolean().optional(),
    inspectionCache: inspectionCacheSchema.optional(),
    directPlay: directPlaySchema.optional(),
    playback: playbackStateSchema.optional(),
    diskCopy: diskCopySchema.optional(),
    // When a client last requested this entry's stream (any device, not just
    // host playback). Drives "Recently streamed" in the management UI.
    lastStreamedAt: z.string().datetime().optional(),
    searchImport: searchImportSchema.optional(),
    searchReceipts: z.array(searchReceiptSchema).optional(),
    sourceCheck: sourceCheckSchema.optional(),
    mediaFacts: z.array(mediaFactSchema).optional(),
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
    lastStreamedAt: true,
    sourceHash: true,
    searchImport: true,
    searchReceipts: true,
    sourceCheck: true,
    mediaFacts: true,
    createdAt: true,
    updatedAt: true,
  })
  .extend({
    extraSources: z
      .array(
        seriesSourceSchema
          .omit({ managedMedia: true, searchImport: true, sourceHash: true })
          .refine((source) => source.magnetUri || source.torrentFilePath, {
            message: "Each extra source needs magnetUri or torrentFilePath",
          }),
      )
      .optional(),
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

// null clears the field; every optional presentation field is clearable.
const nullableMetadata = Object.fromEntries(
  Object.entries(titleMetadataSchema.shape).map(([key, schema]) => [
    key,
    schema.nullable(),
  ]),
) as {
  [K in keyof TitleMetadata]: z.ZodNullable<
    (typeof titleMetadataSchema.shape)[K]
  >;
};

export const patchEntrySchema = createEntrySchema.partial().extend({
  description: z.string().nullable().optional(),
  // null clears every tag from the entry.
  tags: entryTagsSchema.nullable().optional(),
  poster: z.string().url().nullable().optional(),
  background: z.string().url().nullable().optional(),
  ...nullableMetadata,
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
