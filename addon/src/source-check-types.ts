import { z } from "zod";

export const checkPhaseSchema = z.enum([
  "queued",
  "inspecting",
  "probing",
  "complete",
  "failed",
  "cancelled",
  "interrupted",
]);
export const probeSummarySchema = z.object({
  sizeBytes: z.number().nonnegative().safe(),
  durationSeconds: z.number().positive().optional(),
  bitrateMbps: z.number().nonnegative().optional(),
  recommendedMbps: z.number().nonnegative().optional(),
  container: z.string().max(100).optional(),
  containerAliases: z.array(z.string().max(100)).max(20).optional(),
  videoCodec: z.string().max(100).optional(),
  videoProfile: z.string().max(100).optional(),
  videoLevel: z.number().int().optional(),
  pixelFormat: z.string().max(100).optional(),
  videoTag: z.string().max(100).optional(),
  audioCodec: z.string().max(100).optional(),
  audioCodecs: z.array(z.string().max(100)).max(128).optional(),
  audioTracks: z.number().int().nonnegative().max(128).optional(),
  decodedVideoFrames: z.number().int().nonnegative().optional(),
  width: z.number().int().positive().optional(),
  height: z.number().int().positive().optional(),
});
export const sourceCheckSchema = z.object({
  jobId: z.string().uuid(),
  revision: z.string().regex(/^[a-f0-9]{64}$/),
  phase: checkPhaseSchema,
  mode: z.enum(["basic", "extended"]).optional(),
  outcome: z
    .enum(["observed", "inconclusive", "invalid", "unavailable"])
    .optional(),
  stage: z.enum(["metadata", "sample"]).optional(),
  probe: z.boolean(),
  updatedAt: z.string().datetime(),
  message: z.string().max(500),
  code: z.string().max(80).optional(),
  fileId: z.number().int().nonnegative().optional(),
  sourceHash: z.string().max(100).optional(),
  filePath: z.string().min(1).optional(),
  fileLength: z.number().nonnegative().safe().optional(),
  checkedFiles: z.number().int().nonnegative().optional(),
  totalFiles: z.number().int().nonnegative().optional(),
  technical: probeSummarySchema.optional(),
  browserSupport: z.enum(["likely", "limited", "unknown"]).optional(),
});
export type SourceCheck = z.infer<typeof sourceCheckSchema>;
export type ProbeSummary = z.infer<typeof probeSummarySchema>;
export const mediaFactSchema = z.object({
  revision: z.string().regex(/^[a-f0-9]{64}$/),
  jobId: z.string().uuid(),
  fileId: z.number().int().nonnegative(),
  sourceHash: z.string().max(100).optional(),
  filePath: z.string().min(1),
  fileLength: z.number().nonnegative().safe(),
  technical: probeSummarySchema,
  observedAt: z.string().datetime(),
});
export type MediaFact = z.infer<typeof mediaFactSchema>;
export const ACTIVE_CHECK_PHASES = new Set<SourceCheck["phase"]>([
  "queued",
  "inspecting",
  "probing",
]);
