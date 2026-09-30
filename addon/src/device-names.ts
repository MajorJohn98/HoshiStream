import { z } from "zod";
import { readJsonFile, writeJsonFile } from "./json-file.ts";

// User-assigned device names for the Devices panel, keyed by client IP (the
// most stable identifier Stremio-family clients expose; home DHCP leases are
// effectively static). Stored locally as a small JSON file — never uploaded.

const namesSchema = z.record(z.string(), z.string().min(1).max(60));

export class DeviceNames {
  readonly #path: string;
  #names: Record<string, string> | undefined;
  #queue: Promise<unknown> = Promise.resolve();

  constructor(path: string) {
    this.#path = path;
  }

  async #load(): Promise<Record<string, string>> {
    if (this.#names) return this.#names;
    this.#names = (await readJsonFile(this.#path, namesSchema)) ?? {};
    return this.#names;
  }

  // Names are cosmetic: an unreadable file shows no names rather than
  // failing the Devices panel, and is not cached so the next read retries.
  async all(): Promise<Record<string, string>> {
    try {
      return { ...(await this.#load()) };
    } catch {
      return {};
    }
  }

  async get(ip: string): Promise<string | undefined> {
    return (await this.all())[ip];
  }

  // An empty or whitespace-only name removes the entry.
  set(ip: string, name: string): Promise<void> {
    const run = this.#queue.then(async () => {
      const names = { ...(await this.#load()) };
      const trimmed = name.trim().slice(0, 60);
      if (trimmed) names[ip] = trimmed;
      else delete names[ip];
      await writeJsonFile(this.#path, names);
      this.#names = names;
    });
    this.#queue = run.catch(() => undefined);
    return run;
  }
}
