import { z } from "zod";

export const NATIVE_HOST = "com.hoshistream.chrome";
export const PROTOCOL_VERSION = 1;
export const MAX_TORRENT_BYTES = 1_000_000;
export const MAX_NATIVE_INPUT = 2_000_000;
export const MAX_NATIVE_OUTPUT = 1_000_000;
const entryId = z.string().min(1).max(200);
const uuid = z.string().uuid();
const empty = z.object({}).strict();
const commit = {
  draftId: uuid,
  name: z.string().trim().min(1).max(200),
  type: z.enum(["movie", "series"]),
  tags: z.array(z.string().trim().min(1).max(40)).max(32).optional(),
  idempotencyKey: uuid,
  checkAfterSave: z.boolean(),
};
const envelope = { version: z.literal(PROTOCOL_VERSION), id: uuid };
const command = <T extends string, S extends z.ZodType>(name: T, payload: S) =>
  z.object({ ...envelope, command: z.literal(name), payload }).strict();

export const nativeRequestSchema = z.discriminatedUnion("command", [
  command("status", empty),
  command("startApp", empty),
  command("tags", empty),
  command("series", empty),
  command(
    "prepareMagnet",
    z
      .object({ magnetUri: z.string().startsWith("magnet:?").max(16_384) })
      .strict(),
  ),
  command(
    "prepareTorrent",
    z
      .object({
        bytesBase64: z
          .string()
          .min(4)
          .max(1_333_336)
          .regex(/^[A-Za-z0-9+/]+={0,2}$/),
        fileName: z
          .string()
          .min(1)
          .max(255)
          .refine(
            (name) =>
              !/[\\/\0]/.test(name) && name.toLowerCase().endsWith(".torrent"),
          ),
      })
      .strict(),
  ),
  command("discardDraft", z.object({ draftId: uuid }).strict()),
  command("createEntry", z.object(commit).strict()),
  command(
    "previewSeries",
    z
      .object({
        draftId: uuid,
        entryId,
        seasonHint: z.number().int().nonnegative().optional(),
      })
      .strict(),
  ),
  command(
    "commitSeries",
    z
      .object({
        previewId: uuid,
        idempotencyKey: uuid,
        allowReplace: z.boolean(),
        checkAfterSave: z.boolean(),
      })
      .strict(),
  ),
  command("discardPreview", z.object({ previewId: uuid }).strict()),
  command(
    "startCheck",
    z
      .object({
        entryId,
        fileId: z.number().int().nonnegative().optional(),
        mode: z.enum(["basic", "extended"]).optional(),
      })
      .strict(),
  ),
  command("getCheck", z.object({ entryId }).strict()),
  command("cancelCheck", z.object({ entryId }).strict()),
  command("openEntry", z.object({ entryId }).strict()),
]);

export type NativeRequest = z.infer<typeof nativeRequestSchema>;
export type NativeResponse =
  | { version: 1; id: string; ok: true; data: unknown }
  | {
      version: 1;
      id: string;
      ok: false;
      error: {
        code: string;
        message: string;
        retryable?: boolean;
        uncertain?: boolean;
      };
    };

export class NativeBridgeError extends Error {
  readonly code: string;
  readonly status?: number;
  constructor(code: string, message: string, status?: number) {
    super(message);
    this.code = code;
    this.status = status;
  }
}
