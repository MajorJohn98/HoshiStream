import { z } from "zod";
import { tagKey, tagNameSchema } from "../tags.ts";
import { body, logInfo, reply, type RouteHandler } from "./context.ts";

const tagBodySchema = z.object({ name: tagNameSchema });

// Tag registry CRUD. Renames and deletions cascade to library entries so the
// Tags page is the single place a tag's spelling lives.
export const handleTags: RouteHandler = async (
  { library, tags },
  { request, response, url, method },
) => {
  if (!url.pathname.startsWith("/api/tags")) return false;
  if (!tags) return reply(response, 409, { error: "Tags unavailable" });
  if (url.pathname === "/api/tags") {
    if (method === "GET") {
      const counts = new Map<string, number>();
      for (const entry of await library.list()) {
        for (const tag of entry.tags ?? []) {
          const key = tagKey(tag);
          counts.set(key, (counts.get(key) ?? 0) + 1);
        }
      }
      return reply(response, 200, {
        tags: (await tags.list()).map((name) => ({
          name,
          count: counts.get(tagKey(name)) ?? 0,
        })),
      });
    }
    if (method === "POST") {
      const { name } = tagBodySchema.parse(await body(request));
      const created = await tags.add(name);
      logInfo("tag_created", { tag: created });
      return reply(response, 201, { name: created });
    }
    return false;
  }
  const itemMatch = /^\/api\/tags\/([^/]+)$/.exec(url.pathname);
  if (!itemMatch) return false;
  const current = decodeURIComponent(itemMatch[1]);
  if (method === "PATCH") {
    const { name } = tagBodySchema.parse(await body(request));
    const previous = await tags.rename(current, name);
    const entries = await library.retag(previous, name);
    logInfo("tag_renamed", { from: previous, to: name, entries });
    return reply(response, 200, { name, entries });
  }
  if (method === "DELETE") {
    const removed = await tags.remove(current);
    const entries = await library.retag(removed, undefined);
    logInfo("tag_deleted", { tag: removed, entries });
    return reply(response, 200, { name: removed, entries });
  }
  return false;
};
