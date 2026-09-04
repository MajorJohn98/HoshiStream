import sdk from "stremio-addon-sdk";
import { getCatalog } from "./catalog.ts";
import type { Library } from "./library.ts";
import { manifest } from "./manifest.ts";
import { getMetadata } from "./metadata.ts";
import type { AddonInterface } from "./server-types.ts";
import { getStreams } from "./streams.ts";
import type { TorrServerClient } from "./torrserver-client.ts";

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
