// Cinemeta enrichment management API (ADR 0026). Every route here answers
// 409 `metadata-disabled` until the viewer turns the feature on; the
// settings route itself is always available so the toggle can be flipped.
import { z } from "zod";
import { metadataSettingsSchema } from "../metadata-settings.ts";
import { IMDB_ID } from "../types.ts";
import { body, logInfo, noStoreReply, type RouteHandler } from "./context.ts";

const SETTINGS_PATH = "/api/metadata/settings";
const BACKFILL_PATH = "/api/metadata/backfill";
const ITEM = /^\/api\/library\/([^/]+)\/metadata(?:\/(search|apply|refresh))?$/;
const applySchema = z.object({ imdbId: z.string().regex(IMDB_ID) }).strict();

export const handleMetadataSettings: RouteHandler = async (
  { metadata },
  { request, response, url, method },
) => {
  if (url.pathname !== SETTINGS_PATH) return false;
  if (method !== "GET" && method !== "PUT") return false;
  if (!metadata)
    return noStoreReply(response, 409, {
      error: "Metadata enrichment is not configured",
      code: "metadata-unavailable",
    });
  if (method === "GET")
    return noStoreReply(response, 200, await metadata.settings.read());
  const patch = metadataSettingsSchema.partial().parse(await body(request));
  const next = await metadata.settings.update(patch);
  logInfo("metadata_settings_updated", next);
  return noStoreReply(response, 200, next);
};

export const handleMetadataBackfill: RouteHandler = async (
  { metadata },
  { response, url, method },
) => {
  if (url.pathname !== BACKFILL_PATH) return false;
  if (method !== "GET" && method !== "POST") return false;
  if (!metadata)
    return noStoreReply(response, 409, {
      error: "Metadata enrichment is not configured",
      code: "metadata-unavailable",
    });
  if (method === "GET")
    return noStoreReply(response, 200, metadata.backfillStatus());
  const progress = await metadata.startBackfill();
  logInfo("metadata_backfill_started", { total: progress.total });
  return noStoreReply(response, 202, progress);
};

export const handleMetadataItem: RouteHandler = async (
  { metadata, library },
  { request, response, url, method },
) => {
  const match = ITEM.exec(url.pathname);
  if (!match) return false;
  const id = decodeURIComponent(match[1]);
  const action = match[2];
  if (!metadata)
    return noStoreReply(response, 409, {
      error: "Metadata enrichment is not configured",
      code: "metadata-unavailable",
    });
  if (!action) {
    if (method !== "DELETE") return false;
    if (!(await library.get(id)))
      return noStoreReply(response, 404, { error: "Entry not found" });
    const entry = await metadata.unlink(id);
    logInfo("metadata_unlinked", { entryId: id });
    return noStoreReply(response, 200, entry);
  }
  if (action === "search") {
    if (method !== "GET") return false;
    const q = url.searchParams.get("q") ?? undefined;
    return noStoreReply(response, 200, await metadata.search(id, q));
  }
  if (method !== "POST") return false;
  if (action === "apply") {
    const { imdbId } = applySchema.parse(await body(request));
    const outcome = await metadata.apply(id, imdbId, "replace");
    return noStoreReply(response, 200, outcome);
  }
  const outcome = await metadata.refresh(id);
  return noStoreReply(response, 200, outcome);
};
