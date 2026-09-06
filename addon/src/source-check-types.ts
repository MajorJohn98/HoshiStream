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
  videoCodec: z.string().max(100).optional(),
  audioCodec: z.string().max(100).optional(),
  width: z.number().int().positive().optional(),
  height: z.number().int().positive().optional(),
});
export const sourceCheckSchema = z.object({
  jobId: z.string().uuid(),
  revision: z.string().regex(/^[a-f0-9]{64}$/),
  phase: checkPhaseSchema,
  probe: z.boolean(),
  updatedAt: z.string().datetime(),
  message: z.string().max(500),
  code: z.string().max(80).optional(),
  fileId: z.number().int().nonnegative().optional(),
  checkedFiles: z.number().int().nonnegative().optional(),
  totalFiles: z.number().int().nonnegative().optional(),
  technical: probeSummarySchema.optional(),
  browserSupport: z.enum(["likely", "limited", "unknown"]).optional(),
});
export type SourceCheck = z.infer<typeof sourceCheckSchema>;
export type ProbeSummary = z.infer<typeof probeSummarySchema>;
export const ACTIVE_CHECK_PHASES = new Set<SourceCheck["phase"]>([
  "queued",
  "inspecting",
  "probing",
]);
