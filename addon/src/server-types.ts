import type { manifest } from "./manifest.js";

export type AddonInterface = {
  manifest: typeof manifest;
  get(
    resource: string,
    type: string,
    id: string,
    extra?: Record<string, string | string[] | undefined>,
  ): Promise<unknown>;
};
