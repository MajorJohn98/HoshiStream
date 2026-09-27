import { z } from "zod";
import { readJsonFile, writeJsonFile } from "./json-file.ts";

// Opt-in switch for Cinemeta enrichment (ADR 0026). Off by default: with
// `enabled` false no request ever leaves the machine. `autoOnAdd` runs the
// lookup after each add; off means enrichment happens only on request.

export const metadataSettingsSchema = z
  .object({
    enabled: z.boolean().default(false),
    autoOnAdd: z.boolean().default(true),
  })
  .strict();

export type MetadataSettings = z.infer<typeof metadataSettingsSchema>;

export const DEFAULT_METADATA_SETTINGS: MetadataSettings = {
  enabled: false,
  autoOnAdd: true,
};

export class MetadataSettingsStore {
  readonly #path: string;
  #state: MetadataSettings | undefined;
  #queue: Promise<unknown> = Promise.resolve();

  constructor(path: string) {
    this.#path = path;
  }

  async #load(): Promise<MetadataSettings> {
    if (this.#state) return this.#state;
    this.#state = (await readJsonFile(this.#path, metadataSettingsSchema)) ?? {
      ...DEFAULT_METADATA_SETTINGS,
    };
    return this.#state;
  }

  // An unreadable file reads as the privacy-safe default (enrichment off)
  // without caching it; updates surface the error instead of overwriting.
  async read(): Promise<MetadataSettings> {
    try {
      return { ...(await this.#load()) };
    } catch {
      return { ...DEFAULT_METADATA_SETTINGS };
    }
  }

  update(patch: Partial<MetadataSettings>): Promise<MetadataSettings> {
    const run = this.#queue.then(async () => {
      const next = metadataSettingsSchema.parse({
        ...(await this.#load()),
        ...patch,
      });
      await writeJsonFile(this.#path, next);
      this.#state = next;
      return { ...next };
    });
    this.#queue = run.catch(() => undefined);
    return run;
  }
}
