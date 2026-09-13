import { mediaFactForFile } from "./media-facts.ts";
import type { StreamTarget } from "./playback-telemetry.ts";
import { ACTIVE_CHECK_PHASES } from "./source-check-types.ts";
import type { SourceChecks } from "./source-checks.ts";
import type { LibraryEntry } from "./types.ts";

// A failed or inconclusive probe is not retried for this long, so a file the
// swarm cannot serve is not hammered on every telemetry tick.
export const PROBE_COOLDOWN_MS = 10 * 60_000;

export interface PlaybackProbesOptions {
  cooldownMs?: number;
  now?: () => number;
  log?: (line: string) => void;
  // Receives the measured bitrate so the live stream target can use it.
  onBitrate?: (target: StreamTarget, bitrateMbps: number) => void;
}

type ProbeChecks = Pick<SourceChecks, "check" | "get">;
type Library = { get(id: string): Promise<LibraryEntry | undefined> };

// Probes each episode the first time it plays and keeps the result as a
// per-file media fact, so later plays of the same file skip the probe.
export class PlaybackProbes {
  readonly #library: Library;
  readonly #checks: ProbeChecks;
  readonly #cooldownMs: number;
  readonly #now: () => number;
  readonly #log: (line: string) => void;
  readonly #onBitrate: PlaybackProbesOptions["onBitrate"];
  readonly #pending = new Set<string>();
  readonly #failedAt = new Map<string, number>();

  constructor(
    library: Library,
    checks: ProbeChecks,
    options: PlaybackProbesOptions = {},
  ) {
    this.#library = library;
    this.#checks = checks;
    this.#cooldownMs = options.cooldownMs ?? PROBE_COOLDOWN_MS;
    this.#now = options.now ?? Date.now;
    this.#log = options.log ?? ((line) => console.log(line));
    this.#onBitrate = options.onBitrate;
  }

  pending(target: Pick<StreamTarget, "entryId" | "fileId">): boolean {
    return this.#pending.has(key(target));
  }

  // Fire-and-forget: the caller is the telemetry tick, which must not wait.
  ensure(target: StreamTarget): void {
    const id = key(target);
    if (this.#pending.has(id)) return;
    const failed = this.#failedAt.get(id);
    if (failed !== undefined && this.#now() - failed < this.#cooldownMs) return;
    this.#pending.add(id);
    void this.#run(target, id)
      .catch(() => {
        this.#failedAt.set(id, this.#now());
      })
      .finally(() => {
        this.#pending.delete(id);
      });
  }

  async #run(target: StreamTarget, id: string): Promise<void> {
    const entry = await this.#library.get(target.entryId);
    if (!entry) {
      this.#failedAt.set(id, this.#now());
      return;
    }
    // An edit to the entry's sources drops its inspection cache until the
    // next inspection; the check below re-inspects, and validates the file
    // id itself, so only a cache that exists is consulted here.
    if (entry.inspectionCache) {
      const file = entry.inspectionCache.selectedFiles.find(
        (candidate) => candidate.id === target.fileId,
      );
      if (!file) {
        this.#failedAt.set(id, this.#now());
        return;
      }
      const known = mediaFactForFile(entry, file, target.hash)?.technical
        .bitrateMbps;
      if (known !== undefined) {
        // Already measured; hand the figure to a target noted without it.
        if (known > 0) this.#onBitrate?.(target, known);
        this.#failedAt.set(id, this.#now());
        return;
      }
    }
    // A check the user started (or one already probing this file) is left
    // alone; the next tick looks again.
    const current = await this.#checks.get(target.entryId);
    if ((ACTIVE_CHECK_PHASES as ReadonlySet<string>).has(current.phase)) return;
    const { check } = await this.#checks.check(target.entryId, {
      probe: true,
      fileId: target.fileId,
      mode: "extended",
    });
    const bitrateMbps = check.technical?.bitrateMbps;
    this.#log(
      JSON.stringify({
        level: "info",
        event: "playback_probe_finished",
        entryId: target.entryId,
        fileId: target.fileId,
        outcome: check.outcome ?? check.phase,
        code: check.code,
        bitrateMbps,
      }),
    );
    if (check.phase !== "complete" || check.outcome !== "observed") {
      this.#failedAt.set(id, this.#now());
      return;
    }
    if (bitrateMbps && bitrateMbps > 0) this.#onBitrate?.(target, bitrateMbps);
    else this.#failedAt.set(id, this.#now());
  }
}

function key(target: Pick<StreamTarget, "entryId" | "fileId">): string {
  return `${target.entryId}:${target.fileId}`;
}
