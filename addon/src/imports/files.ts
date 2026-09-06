import { randomUUID } from "node:crypto";
import {
  mkdir,
  readdir,
  readFile,
  rm,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { saveTorrentBytes } from "../local-media.ts";
import type { Library } from "../library.ts";

const MARKER = ".hoshistream-import-draft";
const MARKER_CONTENT = "hoshistream-import-v1\n";
const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export class ImportFiles {
  readonly root: string;

  constructor(root: string) {
    this.root = resolve(root);
  }

  async stage(bytes: Uint8Array): Promise<string> {
    const batch = randomUUID();
    const directory = join(this.root, batch);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await writeFile(join(directory, MARKER), MARKER_CONTENT, {
      flag: "wx",
      mode: 0o600,
    });
    try {
      return await saveTorrentBytes(bytes, batch, "source.torrent", this.root);
    } catch (error) {
      await this.discard(join(directory, "source.torrent"));
      throw error;
    }
  }

  async publish(path: string): Promise<void> {
    await unlink(join(dirname(path), MARKER)).catch((error) => {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    });
  }

  async discard(path: string): Promise<void> {
    const directory = dirname(resolve(path));
    if (
      dirname(directory) !== this.root ||
      !UUID.test(directory.slice(this.root.length + 1))
    )
      throw new Error("Invalid import staging directory");
    const marker = join(directory, MARKER);
    const contents = await readFile(marker, "utf8").catch((error) => {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT") return undefined;
      throw error;
    });
    if (contents === undefined || contents !== MARKER_CONTENT) return;
    await rm(directory, { recursive: true, force: true });
  }

  async sweep(
    library: Library,
    now = Date.now(),
    protectedPaths: Iterable<string> = [],
    maxAgeMs = 10 * 60 * 1_000,
  ): Promise<void> {
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    const active = new Set([...protectedPaths].map((path) => resolve(path)));
    const referenced = new Set(
      (await library.list()).flatMap((entry) =>
        [
          entry.torrentFilePath,
          ...(entry.extraSources ?? []).map((source) => source.torrentFilePath),
        ]
          .filter((path): path is string => Boolean(path))
          .map((path) => resolve(path)),
      ),
    );
    for (const directory of await readdir(this.root, { withFileTypes: true })) {
      if (!directory.isDirectory() || !UUID.test(directory.name)) continue;
      const source = join(this.root, directory.name, "source.torrent");
      if (active.has(source)) continue;
      const marker = join(this.root, directory.name, MARKER);
      const contents = await readFile(marker, "utf8").catch((error) => {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === "ENOENT") return undefined;
        throw error;
      });
      if (contents !== MARKER_CONTENT) continue;
      if (referenced.has(source)) await this.publish(source);
      else if (now - (await stat(marker)).mtimeMs > maxAgeMs)
        await this.discard(source);
    }
  }
}
