import { createHash, timingSafeEqual } from "node:crypto";
import { z } from "zod";

// The record the Mac pushes on a menu-bar click. The access token itself is
// never stored — only its SHA-256, which the relay compares against the token
// segment of incoming request paths.
export const pointerRecordSchema = z.object({
  baseUrl: z
    .string()
    .url()
    .refine((value) => ["http:", "https:"].includes(new URL(value).protocol), {
      message: "baseUrl must use HTTP or HTTPS",
    }),
  tokenHash: z.string().regex(/^[0-9a-f]{64}$/),
  manifest: z.record(z.string(), z.unknown()),
  updatedAt: z.string(),
});

export type PointerRecord = z.infer<typeof pointerRecordSchema>;

export const pushBodySchema = z.object({
  baseUrl: pointerRecordSchema.shape.baseUrl,
  token: z.string().min(20),
  manifest: z.record(z.string(), z.unknown()),
});

export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export function secretsEqual(candidate: string, expected: string): boolean {
  return timingSafeEqual(
    createHash("sha256").update(candidate).digest(),
    createHash("sha256").update(expected).digest(),
  );
}

// The blob pathname is derived from the push secret so the (public) blob URL
// is unguessable without it, yet stable across pushes.
export function blobPathname(pushSecret: string): string {
  return `hoshistream-pointer-${hashToken(pushSecret).slice(0, 32)}.json`;
}

export interface AddonPath {
  token: string;
  rest: string;
}

// Matches /addon/<token>/<rest>; <rest> may itself contain slashes.
export function parseAddonPath(pathname: string): AddonPath | undefined {
  const match = /^\/addon\/([^/]+)\/(.+)$/.exec(pathname);
  if (!match) return undefined;
  return {
    token: decodeURIComponent(match[1] as string),
    rest: match[2] as string,
  };
}

export type RelayDecision =
  | { kind: "not_found" }
  | { kind: "unauthorized" }
  | { kind: "manifest"; manifest: Record<string, unknown> }
  | { kind: "redirect"; location: string };

export function decideRelay(
  record: PointerRecord | undefined,
  pathname: string,
): RelayDecision {
  const parsed = parseAddonPath(pathname);
  if (!parsed) return { kind: "not_found" };
  if (!record) return { kind: "not_found" };
  const candidateHash = hashToken(parsed.token);
  if (
    !timingSafeEqual(
      Buffer.from(candidateHash, "hex"),
      Buffer.from(record.tokenHash, "hex"),
    )
  ) {
    return { kind: "unauthorized" };
  }
  if (parsed.rest === "manifest.json") {
    return { kind: "manifest", manifest: record.manifest };
  }
  const base = record.baseUrl.replace(/\/+$/, "");
  return {
    kind: "redirect",
    location: `${base}/addon/${encodeURIComponent(parsed.token)}/${parsed.rest}`,
  };
}
