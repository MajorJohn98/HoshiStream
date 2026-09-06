import { z } from "zod";
import { body, noStoreReply, type RouteHandler } from "./context.ts";

const requestSchema = z
  .object({
    probe: z.boolean().optional(),
    fileId: z.number().int().nonnegative().optional(),
  })
  .strict();

export const handleSourceCheck: RouteHandler = async (
  { sourceChecks },
  { request, response, url, method },
) => {
  const match = /^\/api\/library\/([^/]+)\/check$/.exec(url.pathname);
  if (!match || !["GET", "POST", "DELETE"].includes(method)) return false;
  response.setHeader("cache-control", "no-store");
  if (!sourceChecks)
    return noStoreReply(response, 409, {
      code: "check_unavailable",
      error: "Source checks are unavailable on this host.",
    });
  const id = decodeURIComponent(match[1]);
  if (method === "GET")
    return noStoreReply(response, 200, await sourceChecks.get(id));
  if (method === "DELETE")
    return noStoreReply(response, 200, await sourceChecks.cancel(id));
  const hasBody =
    request.headers["transfer-encoding"] !== undefined ||
    Number(request.headers["content-length"] ?? 0) > 0;
  const input = hasBody ? await body(request) : {};
  return noStoreReply(
    response,
    202,
    await sourceChecks.start(id, requestSchema.parse(input)),
  );
};
