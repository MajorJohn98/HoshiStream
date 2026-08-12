import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { z } from "zod";
import {
  libraryEntrySchema,
  type CreateEntry,
  type LibraryEntry,
  type PatchEntry,
} from "./types.js";

const librarySchema = z.array(libraryEntrySchema);

export class LibraryError extends Error {}

export class Library {
  private queue: Promise<void> = Promise.resolve();

  constructor(private readonly path: string) {}

  async list(): Promise<LibraryEntry[]> {
    await this.queue;
    return this.read();
  }

  async get(id: string): Promise<LibraryEntry | undefined> {
    return (await this.list()).find((entry) => entry.id === id);
  }

  create(input: CreateEntry): Promise<LibraryEntry> {
    return this.update(async (entries) => {
      const now = new Date().toISOString();
      const entry = libraryEntrySchema.parse({
        ...input,
        id: `hoshi:${randomUUID()}`,
        createdAt: now,
        updatedAt: now,
      });
      entries.push(entry);
      return entry;
    });
  }

  patch(id: string, input: PatchEntry): Promise<LibraryEntry | undefined> {
    return this.update(async (entries) => {
      const index = entries.findIndex((entry) => entry.id === id);
      if (index === -1) return undefined;
      const current = entries[index];
      const candidate: Record<string, unknown> = {
        ...current,
        ...input,
        id,
        createdAt: current.createdAt,
        updatedAt: new Date().toISOString(),
      };
      if (input.description === null) delete candidate.description;
      if (input.poster === null) delete candidate.poster;
      if (input.background === null) delete candidate.background;
      const updated = libraryEntrySchema.parse(candidate);
      entries[index] = updated;
      return updated;
    });
  }

  remove(id: string): Promise<boolean> {
    return this.update(async (entries) => {
      const index = entries.findIndex((entry) => entry.id === id);
      if (index === -1) return false;
      entries.splice(index, 1);
      return true;
    });
  }

  private async read(): Promise<LibraryEntry[]> {
    try {
      return librarySchema.parse(JSON.parse(await readFile(this.path, "utf8")));
    } catch (error) {
      throw new LibraryError(
        `Cannot read library: ${error instanceof Error ? error.message : error}`,
      );
    }
  }

  private update<T>(
    change: (entries: LibraryEntry[]) => Promise<T>,
  ): Promise<T> {
    const operation = this.queue.then(async () => {
      const entries = await this.read();
      const result = await change(entries);
      await this.write(entries);
      return result;
    });
    this.queue = operation.then(
      () => undefined,
      () => undefined,
    );
    return operation;
  }

  private async write(entries: LibraryEntry[]): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true });
    const temporaryPath = `${this.path}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporaryPath, `${JSON.stringify(entries, null, 2)}\n`, {
        mode: 0o600,
      });
      await rename(temporaryPath, this.path);
    } catch (error) {
      await unlink(temporaryPath).catch(() => undefined);
      throw error;
    }
  }
}
