import { createHash } from "node:crypto";
import { parentPort, workerData } from "node:worker_threads";
import bencode from "bencode";
import { z } from "zod";
import { torrentSuggestedName } from "./torrent-hints.ts";

const bytes = z.instanceof(Uint8Array);
const integer = z.number().int().nonnegative().safe();
const workerInputSchema = z.object({
  data: bytes,
});
const segment = bytes.refine((value) => {
  const text = Buffer.from(value).toString("utf8");
  return (
    text.length > 0 && text !== "." && text !== ".." && !/[\\/\0]/.test(text)
  );
});
const infoSchema = z.object({
  name: segment,
  "piece length": integer.positive(),
  pieces: bytes.refine((value) => value.length > 0 && value.length % 20 === 0),
  private: z.union([z.literal(0), z.literal(1)]).optional(),
  length: integer.optional(),
  files: z
    .array(z.object({ length: integer, path: z.array(segment).min(1) }))
    .min(1)
    .max(10_000)
    .optional(),
});

try {
  const { data } = workerInputSchema.parse(workerData);
  const decoded = bencode.decode(data);
  if (!Buffer.from(bencode.encode(decoded)).equals(data))
    throw new Error("Noncanonical torrent");
  const { info: rawInfo } = z.object({ info: z.unknown() }).parse(decoded);
  const info = infoSchema.parse(rawInfo);
  if ((info.length === undefined) === (info.files === undefined))
    throw new Error("Invalid file layout");
  const size =
    info.length ?? info.files!.reduce((sum, file) => sum + file.length, 0);
  if (!Number.isSafeInteger(size) || size <= 0)
    throw new Error("Invalid torrent size");
  if (Math.ceil(size / info["piece length"]) !== info.pieces.length / 20)
    throw new Error("Invalid piece count");
  parentPort?.postMessage({
    hash: createHash("sha1").update(bencode.encode(rawInfo)).digest("hex"),
    sizeBytes: size,
    suggestedName: torrentSuggestedName(info.name),
  });
} catch {
  parentPort?.postMessage({ error: "invalid_torrent" });
}
