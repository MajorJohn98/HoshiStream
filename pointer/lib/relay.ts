import { createHash, timingSafeEqual } from "node:crypto";
import { z } from "zod";

// A tenant's pointer record lives for this long after its last push; the Mac
// app re-pushes well before expiry, and abandoned pointers age out.
export const POINTER_TTL_SECONDS = 90 * 24 * 60 * 60;

// Manifests are small JSON documents; anything bigger is abuse.
export const MAX_MANIFEST_BYTES = 64 * 1024;

const sha256Hex = z.string().regex(/^[0-9a-f]{64}$/);

const baseUrlSchema = z
  .string()
  .url()
  .refine((value) => ["http:", "https:"].includes(new URL(value).protocol), {
    message: "baseUrl must use HTTP or HTTPS",
  });

const manifestSchema = z
  .record(z.string(), z.unknown())
  .refine(
    (manifest) =>
      Buffer.byteLength(JSON.stringify(manifest), "utf8") <= MAX_MANIFEST_BYTES,
    { message: `manifest must be at most ${MAX_MANIFEST_BYTES} bytes` },
  );

// The record a Mac pushes on a menu-bar click. Neither the access token nor
// the push secret is ever stored — only their SHA-256 hashes. Records are
// keyed by hash(token); the push secret's hash proves ownership on later
// pushes (claim-on-first-push, ADR 0013).
export const pointerRecordSchema = z.object({
  baseUrl: baseUrlSchema,
  tokenHash: sha256Hex,
  pushSecretHash: sha256Hex,
  manifest: z.record(z.string(), z.unknown()),
  createdAt: z.string(),
  updatedAt: z.string(),
  expiresAt: z.string(),
});

export type PointerRecord = z.infer<typeof pointerRecordSchema>;

// Pre-multi-tenant record shape (single tenant, keyed by the deployment's
// PUSH_SECRET). Still readable so an existing install keeps working until
// its first v2 push.
export const legacyPointerRecordSchema = z.object({
  baseUrl: baseUrlSchema,
  tokenHash: sha256Hex,
  manifest: z.record(z.string(), z.unknown()),
  updatedAt: z.string(),
});

export type LegacyPointerRecord = z.infer<typeof legacyPointerRecordSchema>;

// The subset of a record the relay needs; satisfied by both shapes.
export type RelayRecord = Pick<
  PointerRecord,
  "baseUrl" | "tokenHash" | "manifest"
>;

export const pushBodySchema = z.object({
  baseUrl: baseUrlSchema,
  token: z.string().min(20),
  manifest: manifestSchema,
});

export const deleteBodySchema = z.object({
  token: z.string().min(20),
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

export function hashesEqual(
  candidateHex: string,
  expectedHex: string,
): boolean {
  if (!/^[0-9a-f]{64}$/.test(candidateHex)) return false;
  if (!/^[0-9a-f]{64}$/.test(expectedHex)) return false;
  return timingSafeEqual(
    Buffer.from(candidateHex, "hex"),
    Buffer.from(expectedHex, "hex"),
  );
}

// Open-redirect protection: on a shared deployment, pushed base URLs must
// point at private/LAN space so strangers cannot use the relay to redirect
// to arbitrary public sites. Self-hosters can opt out with
// ALLOW_PUBLIC_BASE_URLS=true (e.g. for Cloudflare Tunnel base URLs).
export function isPrivateBaseUrl(baseUrl: string): boolean {
  let hostname: string;
  try {
    hostname = new URL(baseUrl).hostname.toLowerCase();
  } catch {
    return false;
  }
  if (hostname === "localhost" || hostname.endsWith(".localhost")) return true;
  if (hostname.endsWith(".local")) return true;
  const ipv6 = hostname.replace(/^\[|\]$/g, "");
  if (ipv6 === "::1") return true;
  if (/^f[cd][0-9a-f]{2}:/i.test(ipv6)) return true; // fc00::/7 unique-local
  if (/^fe[89ab][0-9a-f]:/i.test(ipv6)) return true; // fe80::/10 link-local
  const ipv4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(hostname);
  if (!ipv4) return false;
  const [a, b] = [Number(ipv4[1]), Number(ipv4[2])];
  if (a === 10 || a === 127) return true;
  if (a === 192 && b === 168) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT / Tailscale
  if (a === 169 && b === 254) return true; // link-local
  return false;
}

// Legacy (single-tenant) blob pathname, derived from the deployment-wide
// push secret. Kept only for the backward-compat read path.
export function blobPathname(pushSecret: string): string {
  return `hoshistream-pointer-${hashToken(pushSecret).slice(0, 32)}.json`;
}

// v2 records are keyed by the token hash so the relay can look any tenant up
// directly from the URL. The (public) blob URL stays unguessable without the
// token itself.
export function recordBlobPathname(tokenHash: string): string {
  return `hoshistream-pointer-v2-${tokenHash.slice(0, 32)}.json`;
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
  record: RelayRecord | undefined,
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
