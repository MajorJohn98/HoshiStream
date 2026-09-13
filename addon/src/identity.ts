import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { z } from "zod";

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

  constructor(path: string) {
    this.#path = path;
  }

  async #load(): Promise<Identity> {
    if (this.#state) return this.#state;
    try {
      this.#state = identitySchema.parse(
        JSON.parse(await readFile(this.#path, "utf8")),
      );
    } catch {
      this.#state = { contactEmail: "" };
    }
    return this.#state;
  }

  async read(): Promise<Identity> {
    return { ...(await this.#load()) };
  }

  async update(patch: Partial<Identity>): Promise<Identity> {
    const next = identitySchema.parse({ ...(await this.#load()), ...patch });
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
