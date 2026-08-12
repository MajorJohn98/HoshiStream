declare module "stremio-addon-sdk" {
  type Handler = (args: {
    type: string;
    id: string;
    extra: Record<string, string>;
  }) => Promise<unknown>;

  class AddonBuilder {
    constructor(manifest: object);
    defineCatalogHandler(handler: Handler): this;
    defineMetaHandler(handler: Handler): this;
    defineStreamHandler(handler: Handler): this;
    getInterface(): unknown;
  }

  const sdk: { addonBuilder: typeof AddonBuilder };
  export default sdk;
}
