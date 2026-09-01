import type { VercelRequest, VercelResponse } from "@vercel/node";
import { decideRelay } from "../lib/relay.js";
import { loadPointer } from "../lib/store.js";

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
// 307-redirects every other add-on resource to the Mac's last-pushed LAN
// base URL. Clients follow redirects per-request, so a pointer update takes
// effect immediately without reinstalling the add-on.
export default async function handler(
  request: VercelRequest,
  response: VercelResponse,
): Promise<void> {
  if (request.method !== "GET" && request.method !== "HEAD") {
    response.status(405).json({ error: "Method not allowed" });
    return;
  }
  const pushSecret = process.env.PUSH_SECRET;
  if (!pushSecret || pushSecret.length < 20) {
    response.status(500).json({ error: "PUSH_SECRET is not configured" });
    return;
  }
  const record = await loadPointer(pushSecret);
  const decision = decideRelay(record, requestedPath(request));
  response.setHeader("cache-control", "no-store, max-age=0");
  switch (decision.kind) {
    case "not_found":
      response.status(404).json({ error: "Not found" });
      return;
    case "unauthorized":
      response.status(401).json({ error: "Unauthorized" });
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
