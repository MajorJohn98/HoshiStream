import { ZodError } from "zod";
import { ImportError } from "../imports/errors.ts";
import {
  importCommitInputSchema,
  importPrepareInputSchema,
  seriesCommitInputSchema,
  seriesPreviewInputSchema,
} from "../imports/service.ts";
import { MAX_TORRENT_BYTES } from "../imports/source-identity.ts";
import { body, noStoreReply, type RouteHandler } from "./context.ts";
import { classifyError } from "./errors.ts";

async function readBytes(request: Parameters<RouteHandler>[1]["request"]) {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += bytes.length;
    if (size > MAX_TORRENT_BYTES)
      throw new ImportError(
        "torrent_size",
        "Torrent metadata must be at most 1 MB.",
      );
    chunks.push(bytes);
  }
  return Buffer.concat(chunks);
}

function invalidRequest(error: unknown) {
  return error instanceof ZodError || error instanceof SyntaxError;
}

export const handleImports: RouteHandler = async (
  { imports, metadata },
  { request, response, url, method },
) => {
  const draftMatch = /^\/api\/imports\/drafts\/([^/]+)$/.exec(url.pathname);
  const previewMatch = /^\/api\/imports\/previews\/([^/]+)$/.exec(url.pathname);
  const magnetLinkMatch = /^\/api\/imports\/magnet-links\/([^/]+)$/.exec(
    url.pathname,
  );
  if (!(
    (method === "GET" &&
      (magnetLinkMatch ||
        ["/api/imports/capabilities", "/api/imports/series"].includes(
          url.pathname,
        ))) ||
    (method === "POST" &&
      [
        "/api/imports/prepare",
        "/api/imports/prepare-torrent",
        "/api/imports/commit",
        "/api/imports/series-preview",
        "/api/imports/series-commit",
        "/api/imports/magnet-links",
      ].includes(url.pathname)) ||
    (method === "DELETE" && (draftMatch || previewMatch))
  ))
    return false;
  if (!imports)
    return noStoreReply(response, 409, {
      code: "import_unavailable",
      error: "Manual imports are unavailable on this host.",
    });
  const controller = new AbortController();
  const disconnect = () => {
    if (!response.writableFinished) controller.abort();
  };
  response.once?.("close", disconnect);
  try {
    if (magnetLinkMatch && method === "GET")
      return noStoreReply(
        response,
        200,
        imports.readMagnetLink(magnetLinkMatch[1]),
      );
    if (url.pathname === "/api/imports/magnet-links")
      return noStoreReply(
        response,
        200,
        imports.createMagnetLink(
          importPrepareInputSchema.parse(await body(request)),
        ),
      );
    if (url.pathname === "/api/imports/capabilities")
      return noStoreReply(response, 200, imports.capabilities());
    if (url.pathname === "/api/imports/series")
      return noStoreReply(response, 200, await imports.listSeries());
    if (draftMatch && method === "DELETE") {
      await imports.discardDraft(draftMatch[1]);
      return noStoreReply(response, 204, null);
    }
    if (previewMatch && method === "DELETE") {
      await imports.discardPreview(previewMatch[1]);
      return noStoreReply(response, 204, null);
    }
    if (url.pathname === "/api/imports/prepare")
      return noStoreReply(
        response,
        200,
        await imports.prepareMagnet(
          importPrepareInputSchema.parse(await body(request)),
        ),
      );
    if (url.pathname === "/api/imports/prepare-torrent")
      return noStoreReply(
        response,
        200,
        await imports.prepareTorrent(await readBytes(request)),
      );
    if (url.pathname === "/api/imports/series-preview")
      return noStoreReply(
        response,
        200,
        await imports.previewSeries(
          seriesPreviewInputSchema.parse(await body(request)),
          controller.signal,
        ),
      );
    if (url.pathname === "/api/imports/series-commit") {
      const result = await imports.commitSeries(
        seriesCommitInputSchema.parse(await body(request)),
      );
      // A new season may bring new episodes: refill details in the
      // background, after the response (ADR 0026).
      if (result.outcome === "appended") metadata?.queueAuto(result.entry.id);
      return noStoreReply(response, 200, result);
    }
    const result = await imports.commit(
      importCommitInputSchema.parse(await body(request)),
    );
    if (result.outcome === "created") metadata?.queueAuto(result.entry.id);
    return noStoreReply(
      response,
      result.outcome === "created" ? 201 : 200,
      result,
    );
  } catch (error) {
    const classified = invalidRequest(error)
      ? {
          status: 400,
          message: "Invalid request",
          code: "invalid_request",
        }
      : classifyError(error);
    return noStoreReply(response, classified.status, {
      error: classified.message,
      ...(classified.code ? { code: classified.code } : {}),
    });
  } finally {
    response.off?.("close", disconnect);
  }
};
