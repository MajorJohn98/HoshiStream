import { randomUUID } from "node:crypto";
import { ImportError } from "./errors.ts";
import { magnetIdentity } from "./source-identity.ts";

const TTL_MS = 10 * 60 * 1_000;
const LIMIT = 32;
type MagnetLink = {
  id: string;
  magnetUri: string;
  suggestedName?: string;
  expires: number;
};

export class MagnetLinks {
  private readonly links = new Map<string, MagnetLink>();
  private readonly now: () => number;

  constructor(now: () => number = Date.now) {
    this.now = now;
  }

  issue(magnetUri: string) {
    const { suggestedName } = magnetIdentity(magnetUri);
    this.prune();
    const existing = [...this.links.values()].find(
      (link) => link.magnetUri === magnetUri,
    );
    if (existing) return this.reference(existing);
    if (this.links.size >= LIMIT)
      throw new ImportError(
        "magnet_link_limit",
        "Too many magnet links are waiting for review. Try again in ten minutes.",
        429,
      );
    const link = {
      id: randomUUID(),
      magnetUri,
      suggestedName,
      expires: this.now() + TTL_MS,
    };
    this.links.set(link.id, link);
    return this.reference(link);
  }

  read(id: string) {
    this.prune();
    const link = this.links.get(id);
    if (!link)
      throw new ImportError(
        "magnet_link_expired",
        "This magnet link expired or the app restarted. Click the original link again, or paste it manually.",
        410,
      );
    return {
      ...this.reference(link),
      magnetUri: link.magnetUri,
      ...(link.suggestedName ? { suggestedName: link.suggestedName } : {}),
    };
  }

  prune() {
    for (const [id, link] of this.links)
      if (link.expires <= this.now()) this.links.delete(id);
  }

  clear() {
    this.links.clear();
  }

  private reference(link: MagnetLink) {
    return { id: link.id, expiresAt: new Date(link.expires).toISOString() };
  }
}
