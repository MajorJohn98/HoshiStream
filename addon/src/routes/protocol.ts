import type { ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { managementHtml } from "../management.js";
import { ownPublicIp } from "../public-ip.js";
import { validToken } from "../security.js";
import {
  getStreams,
  resolveClientAwareUrls,
  resolvePublicUrls,
} from "../streams.js";
import {
  html,
  noStoreReply,
  observeClient,
  reply,
  type RouteHandler,
} from "./context.js";

const MANAGE_ASSET_TYPES: Record<string, string> = {
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
};

export function noStoreProtocolResource(resource: string): boolean {
  return ["catalog", "meta", "stream"].includes(resource);
}

export function manageAssetPath(pathname: string): string | undefined {
  const match =
    /^\/manage-assets\/((?:(?:views|vendor|components)\/)?[a-z0-9-]+\.(?:js|css))$/.exec(
      pathname,
    );
  return match?.[1];
}

async function serveManageAsset(
  response: ServerResponse,
  asset: string,
): Promise<true> {
  const extension = asset.slice(asset.lastIndexOf("."));
  let content: Buffer;
  try {
    content = await readFile(
      new URL(`../../assets/manage/${asset}`, import.meta.url),
    );
  } catch {
    return reply(response, 404, { error: "Not found" });
  }
  response.writeHead(200, {
    "cache-control": "public, max-age=300",
    "content-type": MANAGE_ASSET_TYPES[extension],
    "x-content-type-options": "nosniff",
  });
  response.end(content);
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
  { response, url, method },
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
    return serveManageAsset(response, manageAsset);
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
  },
  { request, response, url, method },
) => {
  const addonPath = protocolPath(url.pathname, accessToken);
  if (addonPath === undefined) return false;
  if (addonPath === "/manifest.json" && method === "GET") {
    observeClient(request, "manifest");
    return noStoreReply(response, 200, addon.manifest);
  }
  const protocolMatch =
    /^\/(catalog|meta|stream)\/(movie|series)\/([^/]+)(?:\/([^/]+))?\.json$/.exec(
      addonPath,
    );
  if (!protocolMatch || method !== "GET") return false;
  const [, resource, type, rawId, rawExtra] = protocolMatch;
  observeClient(request, resource as "catalog" | "meta" | "stream");
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
