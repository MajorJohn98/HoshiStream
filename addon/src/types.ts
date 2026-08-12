import { z } from "zod";
import { isAbsolute } from "node:path";

const absolutePath = z.string().refine(isAbsolute, {
  message: "Local media path must be absolute",
});
const fileOverrideSchema = z.object({
  id: z.number().int().nonnegative(),
  included: z.boolean(),
  season: z.number().int().positive().optional(),
  episode: z.number().int().positive().optional(),
});
const cachedFileSchema = z.object({
  id: z.number().int().nonnegative(),
  path: z.string().min(1),
  length: z.number().int().nonnegative(),
  season: z.number().int().positive().optional(),
  episode: z.number().int().positive().optional(),
});
export const inspectionCacheSchema = z.object({
  hash: z.string().min(1),
  selectedFiles: z.array(cachedFileSchema).min(1),
  inspectedAt: z.string().datetime(),
});

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
    inspectionCache: inspectionCacheSchema.optional(),
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
  );

export const createEntrySchema = libraryEntrySchema
  .omit({
    id: true,
    inspectionCache: true,
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
  );

export const patchEntrySchema = createEntrySchema.partial().extend({
  description: z.string().nullable().optional(),
  poster: z.string().url().nullable().optional(),
  background: z.string().url().nullable().optional(),
});

export type LibraryEntry = z.infer<typeof libraryEntrySchema>;
export type InspectionCache = z.infer<typeof inspectionCacheSchema>;
export type CreateEntry = z.infer<typeof createEntrySchema>;
export type PatchEntry = z.infer<typeof patchEntrySchema>;
export type ContentType = LibraryEntry["type"];
