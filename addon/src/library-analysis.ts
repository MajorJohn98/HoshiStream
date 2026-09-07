import type { Library } from "./library.ts";
import type { SourceChecks } from "./source-checks.ts";
import { entrySourceDefinitionRevision } from "./imports/source-identity.ts";
import type { LibraryEntry } from "./types.ts";

// Library-wide playback analysis: one entry at a time, same pipeline as the
// per-entry "Analyze playback" action (inspect → ffprobe → direct-play
// verdict). Sequential on purpose — inspection registers torrents and the
// probe reads real bytes, so parallelism would thrash TorrServer's cache.

export interface AnalysisStatus {
  running: boolean;
  total: number;
  done: number;
  current?: { id: string; name: string };
  failed: { id: string; name: string; error: string }[];
  startedAt?: string;
  finishedAt?: string;
  cancelled: boolean;
}

export type EntryAnalyzer = (
  entry: LibraryEntry,
  signal: AbortSignal,
) => Promise<void>;

export function defaultAnalyzer(checks: SourceChecks): EntryAnalyzer {
  return async (entry, signal) => {
    const { check } = await checks.check(entry.id, { probe: true }, signal);
    if (
      check.phase !== "complete" ||
      check.outcome !== "observed" ||
      !check.checkedFiles
    )
      throw new Error(check.message);
  };
}

export class LibraryAnalysis {
  #status: AnalysisStatus = {
    running: false,
    total: 0,
    done: 0,
    failed: [],
    cancelled: false,
  };
  #generation = 0;
  #controller?: AbortController;
  #operation?: Promise<void>;
  private readonly library: Library;
  private readonly analyze: EntryAnalyzer;

  constructor(library: Library, analyze: EntryAnalyzer) {
    this.library = library;
    this.analyze = analyze;
  }

  status(): AnalysisStatus {
    return structuredClone(this.#status);
  }

  /**
   * Start a sequential run. `force` re-analyzes everything; otherwise only
   * entries without a current check attempt are visited. Returns false when a run
   * is already active.
   */
  async start(force: boolean): Promise<boolean> {
    if (this.#status.running) return false;
    const generation = ++this.#generation;
    const controller = new AbortController();
    this.#controller = controller;
    this.#status = {
      running: true,
      total: 0,
      done: 0,
      failed: [],
      startedAt: new Date().toISOString(),
      cancelled: false,
    };
    this.#operation = (async () => {
      try {
        const entries = await this.library.list();
        controller.signal.throwIfAborted();
        const targets = entries.filter(
          (entry) =>
            force ||
            !entry.sourceCheck ||
            entry.sourceCheck.revision !== entrySourceDefinitionRevision(entry),
        );
        this.#status.total = targets.length;
        await this.#run(targets, generation, controller.signal);
      } catch {
        if (!controller.signal.aborted)
          this.#status.failed.push({
            id: "",
            name: "Library",
            error: "The library could not be read.",
          });
      } finally {
        if (generation === this.#generation) {
          this.#status.running = false;
          this.#status.current = undefined;
          this.#status.finishedAt = new Date().toISOString();
        }
      }
    })();
    return true;
  }

  async cancel(): Promise<void> {
    if (!this.#status.running) return;
    this.#status.cancelled = true;
    this.#controller?.abort();
    await this.#operation;
  }

  async #run(
    targets: LibraryEntry[],
    generation: number,
    signal: AbortSignal,
  ): Promise<void> {
    for (const entry of targets) {
      if (this.#generation !== generation || signal.aborted) return;
      this.#status.current = { id: entry.id, name: entry.name };
      try {
        await this.analyze(entry, signal);
      } catch (error) {
        if (this.#generation !== generation || signal.aborted) return;
        this.#status.failed.push({
          id: entry.id,
          name: entry.name,
          error: error instanceof Error ? error.message : String(error),
        });
      }
      if (this.#generation !== generation || signal.aborted) return;
      this.#status.done += 1;
    }
    console.log(
      JSON.stringify({
        level: "info",
        event: "library_analysis_finished",
        analyzed: this.#status.done,
        failed: this.#status.failed.length,
      }),
    );
  }
}
