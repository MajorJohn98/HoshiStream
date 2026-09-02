import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { z } from "zod";

// User-assigned device names for the Devices panel, keyed by client IP (the
// most stable identifier Stremio-family clients expose; home DHCP leases are
// effectively static). Stored locally as a small JSON file — never uploaded.

const namesSchema = z.record(z.string(), z.string().min(1).max(60));

export class DeviceNames {
  readonly #path: string;
  #names: Record<string, string> | undefined;

  constructor(path: string) {
    this.#path = path;
  }

  async #load(): Promise<Record<string, string>> {
    if (this.#names) return this.#names;
    try {
      this.#names = namesSchema.parse(
        JSON.parse(await readFile(this.#path, "utf8")),
      );
    } catch {
      this.#names = {};
    }
    return this.#names;
  }

  async all(): Promise<Record<string, string>> {
    return { ...(await this.#load()) };
  }

  async get(ip: string): Promise<string | undefined> {
    return (await this.#load())[ip];
  }

  // An empty or whitespace-only name removes the entry.
  async set(ip: string, name: string): Promise<void> {
    const names = await this.#load();
    const trimmed = name.trim().slice(0, 60);
    if (trimmed) names[ip] = trimmed;
    else delete names[ip];
    await mkdir(dirname(this.#path), { recursive: true });
    const temporary = `${this.#path}.tmp`;
    await writeFile(temporary, `${JSON.stringify(names, null, 2)}\n`, {
      mode: 0o600,
    });
    await rename(temporary, this.#path);
  }
}
