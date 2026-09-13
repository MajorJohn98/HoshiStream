import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { z } from "zod";

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

  constructor(path: string) {
    this.#path = path;
  }

  async #load(): Promise<MetadataSettings> {
    if (this.#state) return this.#state;
    try {
      this.#state = metadataSettingsSchema.parse(
        JSON.parse(await readFile(this.#path, "utf8")),
      );
    } catch {
      this.#state = { ...DEFAULT_METADATA_SETTINGS };
    }
    return this.#state;
  }

  async read(): Promise<MetadataSettings> {
    return { ...(await this.#load()) };
  }

  async update(patch: Partial<MetadataSettings>): Promise<MetadataSettings> {
    const next = metadataSettingsSchema.parse({
      ...(await this.#load()),
      ...patch,
    });
    await mkdir(dirname(this.#path), { recursive: true });
    const temporary = `${this.#path}.tmp`;
    await writeFile(temporary, `${JSON.stringify(next, null, 2)}\n`, {
      mode: 0o600,
    });
    await rename(temporary, this.#path);
    this.#state = next;
    return { ...next };
  }
}
