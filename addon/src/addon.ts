import sdk from "stremio-addon-sdk";
import { getCatalog } from "./catalog.js";
import type { Library } from "./library.js";
import { manifest } from "./manifest.js";
import { getMetadata } from "./metadata.js";
import type { AddonInterface } from "./server-types.js";
import { getStreams } from "./streams.js";
import type { TorrServerClient } from "./torrserver-client.js";

export function createAddon(
  library: Library,
  torrServer: TorrServerClient,
  publicTorrServerUrl: string,
  publicAddonUrl: string,
  accessToken: string,
): AddonInterface {
  const builder = new sdk.addonBuilder(manifest);
  builder.defineCatalogHandler(({ type, extra }) =>
    getCatalog(library, type, extra),
  );
  builder.defineMetaHandler(({ type, id }) =>
    getMetadata(library, torrServer, type, id),
  );
  builder.defineStreamHandler(({ type, id }) =>
    getStreams(
      library,
      torrServer,
      publicTorrServerUrl,
      publicAddonUrl,
      accessToken,
      type,
      id,
    ),
  );
  return builder.getInterface() as AddonInterface;
}
