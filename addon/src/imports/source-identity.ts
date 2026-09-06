import { createHash } from "node:crypto";
import { z } from "zod";
import type { LibraryEntry } from "../types.ts";
import { ImportError } from "./errors.ts";
import { magnetSuggestedName } from "./torrent-hints.ts";
import { boundedTorrentWorker } from "./worker.ts";

export const MAX_TORRENT_BYTES = 1_000_000;

const torrentIdentitySchema = z.object({
  hash: z.string().regex(/^[0-9a-f]{40}$/),
  sizeBytes: z.number().int().positive().safe(),
  suggestedName: z.string().min(1).max(200).optional(),
});

export async function torrentIdentity(data: Uint8Array) {
  if (!data.length || data.length > MAX_TORRENT_BYTES)
    throw new ImportError(
      "torrent_size",
      "Torrent metadata must be at most 1 MB.",
    );
  return boundedTorrentWorker({ data }, torrentIdentitySchema, {
    memoryMb: 32,
    failure: () =>
      new ImportError(
        "invalid_torrent",
        "This torrent is malformed or unsupported. Choose another source.",
      ),
  });
}

export function magnetHash(magnet: string | undefined): string | undefined {
  if (!magnet?.startsWith("magnet:?")) return;
  for (const xt of new URL(magnet).searchParams.getAll("xt")) {
    const value = /^urn:btih:([a-z0-9]+)$/i.exec(xt)?.[1];
    if (!value) continue;
    if (/^[0-9a-f]{40}$/i.test(value)) return value.toLowerCase();
    if (!/^[a-z2-7]{32}$/i.test(value)) continue;
    const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
    let accumulator = 0;
    let bits = 0;
    const bytes: number[] = [];
    for (const character of value.toUpperCase()) {
      accumulator = (accumulator << 5) | alphabet.indexOf(character);
      bits += 5;
      if (bits >= 8) {
        bits -= 8;
        bytes.push((accumulator >>> bits) & 255);
      }
    }
    return Buffer.from(bytes).toString("hex");
  }
}

export function magnetIdentity(magnet: string) {
  if (
    !magnet.startsWith("magnet:?") ||
    magnet.length > 16_384 ||
    /[\p{Cc}\s]/u.test(magnet)
  )
    throw new ImportError(
      "invalid_magnet",
      "Choose a valid BitTorrent v1 magnet link.",
    );
  const url = new URL(magnet);
  if (url.hash || url.searchParams.getAll("xt").length !== 1)
    throw new ImportError(
      "invalid_magnet",
      "The magnet must identify exactly one BitTorrent v1 source.",
    );
  const hash = magnetHash(magnet);
  if (!hash)
    throw new ImportError(
      "invalid_magnet",
      "Choose a valid BitTorrent v1 magnet link.",
    );
  return { hash, suggestedName: magnetSuggestedName(magnet) };
}

export function entryHasHash(entry: LibraryEntry, hash: string): boolean {
  hash = hash.toLowerCase();
  return (
    entry.sourceHash?.toLowerCase() === hash ||
    entry.searchImport?.hash.toLowerCase() === hash ||
    magnetHash(entry.magnetUri) === hash ||
    entry.inspectionCache?.hash.toLowerCase() === hash ||
    Boolean(
      entry.extraSources?.some(
        (source) =>
          source.sourceHash?.toLowerCase() === hash ||
          source.searchImport?.hash.toLowerCase() === hash ||
          magnetHash(source.magnetUri) === hash,
      ),
    ) ||
    Boolean(
      entry.inspectionCache?.selectedFiles.some(
        (file) => file.hash?.toLowerCase() === hash,
      ),
    )
  );
}

function sourceDefinition(entry: LibraryEntry) {
  const source = (
    value: LibraryEntry | NonNullable<LibraryEntry["extraSources"]>[number],
  ) => ({
    magnetUri: value.magnetUri,
    torrentFilePath: value.torrentFilePath,
    sourceHash: value.sourceHash,
    fileOverrides: value.fileOverrides,
    seasonHint: "seasonHint" in value ? value.seasonHint : undefined,
    reviewedHash: value.searchImport?.hash,
    reviewedFile: value.searchImport?.filmPath,
    reviewedLength: value.searchImport?.filmSizeBytes,
  });
  return {
    type: entry.type,
    primary: source(entry),
    localFilePath: entry.localFilePath,
    localFolderPath: entry.localFolderPath,
    preferredFileIndex: entry.preferredFileIndex,
    extraSources: (entry.extraSources ?? []).map(source),
  };
}

export function entrySourceDefinitionRevision(entry: LibraryEntry): string {
  return createHash("sha256")
    .update(JSON.stringify(sourceDefinition(entry)))
    .digest("hex");
}

export function entrySourceRevision(entry: LibraryEntry): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        ...sourceDefinition(entry),
        hash: entry.inspectionCache?.hash,
        selectedFiles: entry.inspectionCache?.selectedFiles,
      }),
    )
    .digest("hex");
}
