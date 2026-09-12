import type { IncomingMessage, ServerResponse } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { managementHtml } from "../management.ts";
import { manifestWithGenres } from "../manifest.ts";
import { ownPublicIp } from "../public-ip.ts";
import { validToken } from "../security.ts";
import {
  getStreams,
  resolveClientAwareUrls,
  resolvePublicUrls,
} from "../streams.ts";
import {
  html,
  noStoreReply,
  observeClient,
  reply,
  type RouteHandler,
} from "./context.ts";

const MANAGE_ASSET_TYPES: Record<string, string> = {
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
};

export function noStoreProtocolResource(resource: string): boolean {
  return ["catalog", "meta", "stream", "subtitles"].includes(resource);
}

export function manageAssetPath(pathname: string): string | undefined {
  const match =
    /^\/manage-assets\/((?:(?:views|vendor|components)\/)?[a-z0-9-]+\.(?:js|css))$/.exec(
      pathname,
    );
  return match?.[1];
}

// Assets revalidate on every load (ETag from mtime + size) instead of being
// cached for minutes: after an upgrade a stale module mixed with fresh ones
// breaks the page, and during development edits must show on refresh.
async function serveManageAsset(
  request: IncomingMessage,
  response: ServerResponse,
  asset: string,
): Promise<true> {
  const extension = asset.slice(asset.lastIndexOf("."));
  const url = new URL(`../../assets/manage/${asset}`, import.meta.url);
  let etag: string;
  try {
    const info = await stat(url);
    etag = `"${info.mtimeMs.toString(36)}-${info.size.toString(36)}"`;
  } catch {
    return reply(response, 404, { error: "Not found" });
  }
  const headers = {
    "cache-control": "no-cache",
    etag,
    "x-content-type-options": "nosniff",
  };
  if (request.headers["if-none-match"] === etag) {
    response.writeHead(304, headers);
    response.end();
    return true;
  }
  response.writeHead(200, {
    ...headers,
    "content-type": MANAGE_ASSET_TYPES[extension],
  });
  response.end(await readFile(url));
  return true;
}

function protocolPath(pathname: string, token: string): string | undefined {
  const prefix = `/addon/${encodeURIComponent(token)}`;
  return pathname.startsWith(`${prefix}/`)
    ? pathname.slice(prefix.length)
    : undefined;
}

// Unauthenticated endpoints: liveness, readiness, and the static assets the
// management page loads.
export const handlePublic: RouteHandler = async (
  { library, torrServer, accessToken },
  { request, response, url, method },
) => {
  if (url.pathname === "/health") return reply(response, 200, { status: "ok" });
  if (url.pathname === "/assets/hoshistream-logo.png" && method === "GET") {
    response.writeHead(200, {
      "cache-control": "public, max-age=86400",
      "content-type": "image/png",
    });
    response.end(
      await readFile(
        new URL(
          "../../assets/hoshistream-logo-transparent.png",
          import.meta.url,
        ),
      ),
    );
    return true;
  }
  const manageAsset = manageAssetPath(url.pathname);
  if (manageAsset && method === "GET") {
    return serveManageAsset(request, response, manageAsset);
  }
  if (url.pathname === "/ready") {
    await Promise.all([library.list(), torrServer.health()]);
    return reply(response, 200, { status: "ready" });
  }
  if (url.pathname === "/manifest.json") {
    return reply(response, 401, { error: "Use the tokenized add-on URL" });
  }
  const managementMatch = /^\/manage\/([^/]+)\/?$/.exec(url.pathname);
  if (
    managementMatch &&
    method === "GET" &&
    validToken(decodeURIComponent(managementMatch[1]), accessToken)
  ) {
    return html(response, managementHtml);
  }
  return false;
};

// Stremio protocol under the tokenized prefix: manifest, catalog, meta, and
// stream resources.
export const handleProtocol: RouteHandler = async (
  {
    addon,
    library,
    torrServer,
    accessToken,
    publicUrls,
    lanRedirect,
    transcode,
    tags,
    subtitles,
    volumes,
  },
  { request, response, url, method },
) => {
  const addonPath = protocolPath(url.pathname, accessToken);
  if (addonPath === undefined) return false;
  if (addonPath === "/manifest.json" && method === "GET") {
    observeClient(request, "manifest");
    return noStoreReply(
      response,
      200,
      manifestWithGenres(addon.manifest, (await tags?.list()) ?? []),
    );
  }
  const protocolMatch =
    /^\/(catalog|meta|stream|subtitles)\/(movie|series)\/([^/]+)(?:\/([^/]+))?\.json$/.exec(
      addonPath,
    );
  if (!protocolMatch || method !== "GET") return false;
  const [, resource, type, rawId, rawExtra] = protocolMatch;
  observeClient(
    request,
    resource as "catalog" | "meta" | "stream" | "subtitles",
  );
  // Subtitle URLs point back at this add-on, so like streams they need the
  // origin the client actually reached us on rather than the configured one.
  if (resource === "subtitles") {
    const resolved = resolvePublicUrls(request.headers.host, publicUrls);
    const result = await subtitles.list(
      type,
      decodeURIComponent(rawId),
      resolved.addonUrl,
      accessToken,
    );
    return noStoreReply(response, 200, result);
  }
  if (resource === "stream") {
    const clientIp = request.headers["cf-connecting-ip"];
    const ownIp =
      lanRedirect === "auto" && typeof clientIp === "string"
        ? await ownPublicIp()
        : null;
    const resolved = ownIp
      ? resolveClientAwareUrls(request.headers, publicUrls, ownIp)
      : resolvePublicUrls(request.headers.host, publicUrls);
    const result = await getStreams(
      library,
      torrServer,
      resolved.torrServerUrl,
      resolved.addonUrl,
      accessToken,
      type,
      decodeURIComponent(rawId),
      transcode
        ? {
            videoEncoder: transcode.videoEncoder,
            videoBitrateMbps: transcode.videoBitrateMbps,
            // Tunnel requests carry cf-connecting-ip; a mismatch with
            // this server's public IP means the client is remote.
            remoteClient: Boolean(
              typeof clientIp === "string" && ownIp && clientIp !== ownIp,
            ),
          }
        : undefined,
      undefined,
      volumes,
    );
    return noStoreReply(response, 200, result);
  }
  const result = await addon.get(
    resource,
    type,
    decodeURIComponent(rawId),
    Object.fromEntries(new URLSearchParams(rawExtra ?? "")),
  );
  return noStoreProtocolResource(resource)
    ? noStoreReply(response, 200, result)
    : reply(response, 200, result);
};
