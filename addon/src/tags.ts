import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { z } from "zod";

// The tag registry behind the Tags page. Entries store tag *names*, so the
// library file stays readable and portable; renames and deletions cascade
// through Library.retag. Stored locally as a small JSON file.

export const TAG_MAX_LENGTH = 40;
export const TAGS_PER_ENTRY_MAX = 32;
// Pinned tags become Board rows (one catalog each); more than a handful
// makes the Board scroll forever, so the cap is deliberately low.
export const PINNED_TAGS_MAX = 8;

// Union of the TMDB movie/TV genre lists and IMDb's title genres, merged
// where the vocabularies overlap. Content-type labels (Adult, TV Movie,
// Short) are left out; Anime is added as the most common missing user tag.
export const DEFAULT_TAGS = [
  "Action",
  "Adventure",
  "Animation",
  "Anime",
  "Biography",
  "Comedy",
  "Crime",
  "Documentary",
  "Drama",
  "Family",
  "Fantasy",
  "Film-Noir",
  "Game Show",
  "History",
  "Horror",
  "Kids",
  "Music",
  "Musical",
  "Mystery",
  "News",
  "Reality",
  "Romance",
  "Sci-Fi",
  "Soap",
  "Sport",
  "Talk Show",
  "Thriller",
  "War",
  "Western",
] as const;

export const tagNameSchema = z
  .string()
  .trim()
  .min(1, "Tag name is required")
  .max(TAG_MAX_LENGTH, `Tag names are at most ${TAG_MAX_LENGTH} characters`);

export const entryTagsSchema = z
  .array(tagNameSchema)
  .max(TAGS_PER_ENTRY_MAX)
  .transform((tags) => dedupeTags(tags));

const registrySchema = z.object({
  tags: z.array(tagNameSchema),
  pinned: z.array(tagNameSchema).optional(),
});

export function tagKey(name: string): string {
  return name.trim().toLocaleLowerCase();
}

// Case-insensitive de-duplication that keeps the first spelling seen.
export function dedupeTags(tags: readonly string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const tag of tags) {
    const trimmed = tag.trim();
    const key = tagKey(trimmed);
    if (!trimmed || seen.has(key)) continue;
    seen.add(key);
    result.push(trimmed);
  }
  return result;
}

export class TagError extends Error {}

export class Tags {
  private readonly path: string;
  private names: string[] | undefined;
  // Pin order is Board order; holds registry spellings only.
  private pins: string[] = [];
  private queue: Promise<unknown> = Promise.resolve();

  constructor(path: string) {
    this.path = path;
  }

  private async load(): Promise<string[]> {
    if (this.names) return this.names;
    try {
      const stored = registrySchema.parse(
        JSON.parse(await readFile(this.path, "utf8")),
      );
      this.names = dedupeTags(stored.tags);
      const names = this.names;
      this.pins = dedupeTags(stored.pinned ?? [])
        .map((pin) => names.find((name) => tagKey(name) === tagKey(pin)))
        .filter((name): name is string => name !== undefined)
        .slice(0, PINNED_TAGS_MAX);
    } catch {
      // First run (or an unreadable file): seed the default genre set.
      this.names = [...DEFAULT_TAGS];
      await this.persist(this.names).catch(() => undefined);
    }
    return this.names;
  }

  private async persist(names: string[]): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true });
    const temporary = `${this.path}.tmp`;
    await writeFile(
      temporary,
      `${JSON.stringify({ tags: names, pinned: this.pins }, null, 2)}\n`,
      { mode: 0o600 },
    );
    await rename(temporary, this.path);
  }

  private mutate<T>(work: (names: string[]) => T | Promise<T>): Promise<T> {
    const run = this.queue.then(async () => {
      const names = await this.load();
      const result = await work(names);
      await this.persist(names);
      return result;
    });
    this.queue = run.catch(() => undefined);
    return run;
  }

  async list(): Promise<string[]> {
    await this.queue;
    return [...(await this.load())].sort((a, b) =>
      a.localeCompare(b, undefined, { sensitivity: "base" }),
    );
  }

  // Pinned tags in pin order, each in its registry spelling.
  async pinned(): Promise<string[]> {
    await this.queue;
    await this.load();
    return [...this.pins];
  }

  async setPinned(name: string, pinned: boolean): Promise<string> {
    return this.mutate((names) => {
      const canonical = names.find((tag) => tagKey(tag) === tagKey(name));
      if (!canonical) throw new TagError(`Tag "${name}" not found`);
      const index = this.pins.findIndex(
        (tag) => tagKey(tag) === tagKey(canonical),
      );
      if (pinned && index === -1) {
        if (this.pins.length >= PINNED_TAGS_MAX)
          throw new TagError(
            `Up to ${PINNED_TAGS_MAX} tags can be pinned to the Board`,
          );
        this.pins.push(canonical);
      } else if (!pinned && index !== -1) {
        this.pins.splice(index, 1);
      }
      return canonical;
    });
  }

  // The registry's spelling of a name, if it is registered.
  async canonical(name: string): Promise<string | undefined> {
    const key = tagKey(name);
    return (await this.load()).find((tag) => tagKey(tag) === key);
  }

  async add(name: string): Promise<string> {
    const trimmed = tagNameSchema.parse(name);
    return this.mutate((names) => {
      const existing = names.find((tag) => tagKey(tag) === tagKey(trimmed));
      if (existing) throw new TagError(`Tag "${existing}" already exists`);
      names.push(trimmed);
      return trimmed;
    });
  }

  // Registers any unknown names and returns the registry spelling of each,
  // so entry tags always match the Tags page exactly.
  async ensure(tags: readonly string[]): Promise<string[]> {
    const wanted = dedupeTags(tags);
    if (!wanted.length) return [];
    return this.mutate((names) =>
      wanted.map((tag) => {
        const existing = names.find((name) => tagKey(name) === tagKey(tag));
        if (existing) return existing;
        names.push(tag);
        return tag;
      }),
    );
  }

  // Returns the previous spelling so callers can cascade the rename.
  async rename(from: string, to: string): Promise<string> {
    const next = tagNameSchema.parse(to);
    return this.mutate((names) => {
      const index = names.findIndex((tag) => tagKey(tag) === tagKey(from));
      if (index === -1) throw new TagError(`Tag "${from}" not found`);
      const clash = names.find(
        (tag, i) => i !== index && tagKey(tag) === tagKey(next),
      );
      if (clash) throw new TagError(`Tag "${clash}" already exists`);
      const previous = names[index];
      names[index] = next;
      const pin = this.pins.findIndex((tag) => tagKey(tag) === tagKey(from));
      if (pin !== -1) this.pins[pin] = next;
      return previous;
    });
  }

  async remove(name: string): Promise<string> {
    return this.mutate((names) => {
      const index = names.findIndex((tag) => tagKey(tag) === tagKey(name));
      if (index === -1) throw new TagError(`Tag "${name}" not found`);
      this.pins = this.pins.filter((tag) => tagKey(tag) !== tagKey(name));
      return names.splice(index, 1)[0];
    });
  }
}
