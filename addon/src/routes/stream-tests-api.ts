import { z } from "zod";
import { episodeHintSchema, seasonHintSchema } from "../types.ts";
import { body, noStoreReply, type RouteHandler } from "./context.ts";

const requestSchema = z
  .object({
    source: z.union([
      z
        .object({ magnetUri: z.string().startsWith("magnet:?").max(16_384) })
        .strict(),
      z
        .object({
          torrentFilePath: z
            .string()
            .max(4_096)
            .regex(/\.torrent$/i),
        })
        .strict(),
      z.object({ draftId: z.string().uuid() }).strict(),
    ]),
    type: z.enum(["movie", "series"]).optional(),
    seasonHint: seasonHintSchema.optional(),
    episodeHint: episodeHintSchema.optional(),
    fileId: z.number().int().nonnegative().optional(),
    mode: z.enum(["basic", "extended"]).optional(),
  })
  .strict();

/** Pre-add stream tests: POST starts one, GET polls it, DELETE ends it. */
export const handleStreamTests: RouteHandler = async (
  { streamTests },
  { request, response, url, method },
) => {
  const match = /^\/api\/stream-tests(?:\/([^/]+))?$/.exec(url.pathname);
  if (!match) return false;
  const testId =
    match[1] === undefined ? undefined : decodeURIComponent(match[1]);
  if (
    testId === undefined
      ? method !== "POST"
      : !["GET", "DELETE"].includes(method)
  )
    return false;
  response.setHeader("cache-control", "no-store");
  if (!streamTests)
    return noStoreReply(response, 409, {
      code: "stream_test_unavailable",
      error: "Stream tests are unavailable on this host.",
    });
  if (testId === undefined)
    return noStoreReply(
      response,
      202,
      await streamTests.start(requestSchema.parse(await body(request))),
    );
  if (method === "GET")
    return noStoreReply(response, 200, streamTests.get(testId));
  await streamTests.delete(testId);
  return noStoreReply(response, 204, undefined);
};
