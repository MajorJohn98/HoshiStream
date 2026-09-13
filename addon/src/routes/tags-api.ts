import { z } from "zod";
import { PINNED_TAGS_MAX, tagKey, tagNameSchema } from "../tags.ts";
import { body, logInfo, reply, type RouteHandler } from "./context.ts";

const tagBodySchema = z.object({ name: tagNameSchema });
// PATCH renames with `name` or toggles the Board row with `pinned`.
const tagPatchSchema = z.union([
  tagBodySchema,
  z.object({ pinned: z.boolean() }),
]);

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
      const pinned = await tags.pinned();
      const pinnedKeys = new Set(pinned.map(tagKey));
      return reply(response, 200, {
        tags: (await tags.list()).map((name) => ({
          name,
          count: counts.get(tagKey(name)) ?? 0,
          pinned: pinnedKeys.has(tagKey(name)),
        })),
        pinned,
        pinnedLimit: PINNED_TAGS_MAX,
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
    const patch = tagPatchSchema.parse(await body(request));
    if ("pinned" in patch) {
      const name = await tags.setPinned(current, patch.pinned);
      logInfo(patch.pinned ? "tag_pinned" : "tag_unpinned", { tag: name });
      return reply(response, 200, {
        name,
        pinned: patch.pinned,
        pinnedTags: await tags.pinned(),
      });
    }
    const { name } = patch;
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
