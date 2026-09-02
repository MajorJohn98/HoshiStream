import type { VercelRequest, VercelResponse } from "@vercel/node";
import { allowRequest } from "../../lib/ratelimit.js";
import { hashToken, hashesEqual } from "../../lib/relay.js";
import { loadPointerRecord } from "../../lib/store.js";
import { bearerSecret } from "../pointer.js";

// GET /api/pointer/status — pointer health for the Mac app's dashboard card.
// Requires the tenant's push secret (bearer) and token (x-addon-token header;
// a header keeps the token out of URL logs). Returns 404 for both "no such
// record" and "wrong secret" so nothing is revealed about claimed tokens.
export default async function handler(
  request: VercelRequest,
  response: VercelResponse,
): Promise<void> {
  if (request.method !== "GET") {
    response.status(405).json({ error: "Method not allowed" });
    return;
  }
  const forwarded = request.headers["x-forwarded-for"];
  const ip =
    (Array.isArray(forwarded) ? forwarded[0] : forwarded)
      ?.split(",")[0]
      ?.trim() ?? "unknown";
  if (!(await allowRequest(`status:${ip}`, 30, 60))) {
    response.status(429).json({ error: "Too many requests" });
    return;
  }
  const secret = bearerSecret(request);
  const tokenHeader = request.headers["x-addon-token"];
  const token = Array.isArray(tokenHeader) ? tokenHeader[0] : tokenHeader;
  if (!secret || !token || token.length < 20) {
    response.status(404).json({ error: "Not found" });
    return;
  }
  const record = await loadPointerRecord(hashToken(token));
  if (!record || !hashesEqual(hashToken(secret), record.pushSecretHash)) {
    response.status(404).json({ error: "Not found" });
    return;
  }
  response.setHeader("cache-control", "no-store, max-age=0");
  response.status(200).json({
    ok: true,
    baseUrl: record.baseUrl,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    expiresAt: record.expiresAt,
  });
}
