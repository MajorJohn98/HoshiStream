import type { VercelRequest, VercelResponse } from "@vercel/node";
import { hashToken, pushBodySchema, secretsEqual } from "../lib/relay.js";
import { savePointer } from "../lib/store.js";

// POST /api/pointer — called by the Mac's "Update Remote Pointer" menu item.
// Requires the shared PUSH_SECRET; stores the pointer record (token hashed,
// never the token itself).
export default async function handler(
  request: VercelRequest,
  response: VercelResponse,
): Promise<void> {
  if (request.method !== "POST") {
    response.status(405).json({ error: "Method not allowed" });
    return;
  }
  const pushSecret = process.env.PUSH_SECRET;
  if (!pushSecret || pushSecret.length < 20) {
    response.status(500).json({ error: "PUSH_SECRET is not configured" });
    return;
  }
  const bearer = /^Bearer (.+)$/.exec(request.headers.authorization ?? "")?.[1];
  if (!bearer || !secretsEqual(bearer, pushSecret)) {
    response.status(401).json({ error: "Unauthorized" });
    return;
  }
  const parsed = pushBodySchema.safeParse(request.body);
  if (!parsed.success) {
    response.status(400).json({ error: "Invalid pointer payload" });
    return;
  }
  const updatedAt = new Date().toISOString();
  await savePointer(pushSecret, {
    baseUrl: parsed.data.baseUrl,
    tokenHash: hashToken(parsed.data.token),
    manifest: parsed.data.manifest,
    updatedAt,
  });
  response.status(200).json({ ok: true, updatedAt });
}
