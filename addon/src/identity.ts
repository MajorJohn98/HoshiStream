import { z } from "zod";
import { readJsonFile, writeJsonFile } from "./json-file.ts";

// Add-on identity shown on Stremio's Board tile (Phase 15): the contact
// address the viewer chooses to advertise in the manifest. Stored locally as
// a small JSON file; empty means the field is omitted from the manifest.

export const identitySchema = z.object({
  contactEmail: z
    .string()
    .trim()
    .max(254)
    .refine(
      (value) => value === "" || z.string().email().safeParse(value).success,
      {
        message: "Enter a valid e-mail address or leave the field empty",
      },
    )
    .default(""),
});

export type Identity = z.infer<typeof identitySchema>;

export class IdentityStore {
  readonly #path: string;
  #state: Identity | undefined;
  #queue: Promise<unknown> = Promise.resolve();

  constructor(path: string) {
    this.#path = path;
  }

  async #load(): Promise<Identity> {
    if (this.#state) return this.#state;
    this.#state = (await readJsonFile(this.#path, identitySchema)) ?? {
      contactEmail: "",
    };
    return this.#state;
  }

  // The manifest must keep serving when the file is unreadable, so reads
  // degrade to the default without caching it; updates surface the error.
  async read(): Promise<Identity> {
    try {
      return { ...(await this.#load()) };
    } catch {
      return { contactEmail: "" };
    }
  }

  update(patch: Partial<Identity>): Promise<Identity> {
    const run = this.#queue.then(async () => {
      const next = identitySchema.parse({ ...(await this.#load()), ...patch });
      await writeJsonFile(this.#path, next);
      this.#state = next;
      return { ...next };
    });
    this.#queue = run.catch(() => undefined);
    return run;
  }
}
