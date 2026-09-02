import type { VercelRequest, VercelResponse } from "@vercel/node";
import { allowRequest } from "../lib/ratelimit.js";
import {
  decideRelay,
  hashToken,
  parseAddonPath,
  type RelayRecord,
} from "../lib/relay.js";
import { loadLegacyPointer, loadPointerRecord } from "../lib/store.js";

function requestedPath(request: VercelRequest): string {
  const fromQuery = request.query.path;
  if (typeof fromQuery === "string" && fromQuery.startsWith("/addon/")) {
    return fromQuery;
  }
  // Fallback when the platform passes the original URL through unchanged.
  const raw = request.url ?? "";
  const pathname = raw.split("?")[0] ?? "";
  return pathname;
}

// GET /addon/<token>/… — serves the stored manifest for manifest.json and
// 307-redirects every other add-on resource to the tenant's last-pushed LAN
// base URL. Records are looked up by hash(token), so any number of tenants
// can share one deployment. Unknown and wrong tokens both return 404 so the
// relay reveals nothing about which tokens exist.
export default async function handler(
  request: VercelRequest,
  response: VercelResponse,
): Promise<void> {
  if (request.method !== "GET" && request.method !== "HEAD") {
    response.status(405).json({ error: "Method not allowed" });
    return;
  }
  const path = requestedPath(request);
  const parsed = parseAddonPath(path);
  if (!parsed) {
    response.status(404).json({ error: "Not found" });
    return;
  }
  const tokenHash = hashToken(parsed.token);
  if (!(await allowRequest(`relay:${tokenHash.slice(0, 16)}`, 120, 60))) {
    response.status(429).json({ error: "Too many requests" });
    return;
  }
  let record: RelayRecord | undefined = await loadPointerRecord(tokenHash);
  // Backward compatibility: fall back to the single-tenant record stored
  // under the deployment's PUSH_SECRET until the first v2 push replaces it.
  const legacySecret = process.env.PUSH_SECRET;
  if (!record && legacySecret) {
    record = await loadLegacyPointer(legacySecret);
  }
  const decision = decideRelay(record, path);
  response.setHeader("cache-control", "no-store, max-age=0");
  switch (decision.kind) {
    case "not_found":
    case "unauthorized":
      response.status(404).json({ error: "Not found" });
      return;
    case "manifest":
      response.setHeader("access-control-allow-origin", "*");
      response.status(200).json(decision.manifest);
      return;
    case "redirect":
      response.setHeader("access-control-allow-origin", "*");
      response.setHeader("location", decision.location);
      response.status(307).end();
      return;
  }
}
