import type { VercelRequest, VercelResponse } from "@vercel/node";
import { allowRequest } from "../lib/ratelimit.js";
import {
  POINTER_TTL_SECONDS,
  deleteBodySchema,
  hashToken,
  hashesEqual,
  isPrivateBaseUrl,
  pushBodySchema,
} from "../lib/relay.js";
import {
  deletePointerRecord,
  loadPointerRecord,
  savePointerRecord,
} from "../lib/store.js";

function clientIp(request: VercelRequest): string {
  const forwarded = request.headers["x-forwarded-for"];
  const first = Array.isArray(forwarded) ? forwarded[0] : forwarded;
  return first?.split(",")[0]?.trim() ?? "unknown";
}

export function bearerSecret(request: VercelRequest): string | undefined {
  const match = /^Bearer (.+)$/.exec(request.headers.authorization ?? "");
  const secret = match?.[1];
  return secret && secret.length >= 20 ? secret : undefined;
}

// Multi-tenant pointer management (ADR 0013). A tenant is the (token,
// pushSecret) pair the Mac app generates locally — no accounts.
//
// POST   /api/pointer — first push with an unseen token claims it; later
//                       pushes must present the same push secret.
// DELETE /api/pointer — removes the record ("Remove Remote Pointer").
export default async function handler(
  request: VercelRequest,
  response: VercelResponse,
): Promise<void> {
  if (request.method !== "POST" && request.method !== "DELETE") {
    response.status(405).json({ error: "Method not allowed" });
    return;
  }
  if (!(await allowRequest(`push:${clientIp(request)}`, 10, 60))) {
    response.status(429).json({ error: "Too many requests" });
    return;
  }
  const secret = bearerSecret(request);
  if (!secret) {
    response.status(401).json({ error: "Unauthorized" });
    return;
  }

  if (request.method === "DELETE") {
    const parsed = deleteBodySchema.safeParse(request.body);
    if (!parsed.success) {
      response.status(400).json({ error: "Invalid payload" });
      return;
    }
    const tokenHash = hashToken(parsed.data.token);
    const record = await loadPointerRecord(tokenHash);
    if (record && !hashesEqual(hashToken(secret), record.pushSecretHash)) {
      response.status(401).json({ error: "Unauthorized" });
      return;
    }
    if (record) await deletePointerRecord(tokenHash);
    response.status(200).json({ ok: true });
    return;
  }

  const parsed = pushBodySchema.safeParse(request.body);
  if (!parsed.success) {
    response.status(400).json({ error: "Invalid pointer payload" });
    return;
  }
  const allowPublic = process.env.ALLOW_PUBLIC_BASE_URLS === "true";
  if (!allowPublic && !isPrivateBaseUrl(parsed.data.baseUrl)) {
    response.status(400).json({
      error:
        "baseUrl must be a private/LAN address (set ALLOW_PUBLIC_BASE_URLS=true on a self-hosted deployment to allow public URLs)",
    });
    return;
  }
  const tokenHash = hashToken(parsed.data.token);
  const existing = await loadPointerRecord(tokenHash);
  if (existing && !hashesEqual(hashToken(secret), existing.pushSecretHash)) {
    response.status(401).json({ error: "Unauthorized" });
    return;
  }
  const now = new Date();
  const updatedAt = now.toISOString();
  const expiresAt = new Date(
    now.getTime() + POINTER_TTL_SECONDS * 1000,
  ).toISOString();
  await savePointerRecord({
    baseUrl: parsed.data.baseUrl,
    tokenHash,
    pushSecretHash: hashToken(secret),
    manifest: parsed.data.manifest,
    createdAt: existing?.createdAt ?? updatedAt,
    updatedAt,
    expiresAt,
  });
  response.status(200).json({ ok: true, updatedAt, expiresAt });
}
