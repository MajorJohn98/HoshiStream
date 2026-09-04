import { assessDirectPlay } from "./direct-play.ts";
import { inspectEntry } from "./inspection.ts";
import type { Library } from "./library.ts";
import { probeMedia } from "./media-probe.ts";
import { homeSpeedMbps } from "./speedtest.ts";
import type { TorrServerClient } from "./torrserver-client.ts";
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

export type EntryAnalyzer = (entry: LibraryEntry) => Promise<void>;

export function defaultAnalyzer(
  library: Library,
  torrServer: TorrServerClient,
): EntryAnalyzer {
  return async (entry) => {
    const inspection = await inspectEntry(entry, torrServer, library);
    const selected = inspection.selectedFiles[0];
    const source = inspection.files.find((file) => file.id === selected?.id) as
      { id: number; length: number; localPath?: string } | undefined;
    if (!selected || !source) throw new Error("No playable file");
    const input =
      source.localPath ?? torrServer.streamUrl(inspection.hash, selected);
    const technical = await probeMedia(input, source);
    await library.setDirectPlay(
      entry.id,
      assessDirectPlay(technical, homeSpeedMbps()),
    );
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
   * entries without a stored verdict are visited. Returns false when a run
   * is already active.
   */
  async start(force: boolean): Promise<boolean> {
    if (this.#status.running) return false;
    const entries = await this.library.list();
    const targets = entries.filter((entry) => force || !entry.directPlay);
    const generation = ++this.#generation;
    this.#status = {
      running: true,
      total: targets.length,
      done: 0,
      failed: [],
      startedAt: new Date().toISOString(),
      cancelled: false,
    };
    void this.#run(targets, generation);
    return true;
  }

  cancel(): void {
    if (!this.#status.running) return;
    this.#generation += 1;
    this.#status.running = false;
    this.#status.cancelled = true;
    this.#status.finishedAt = new Date().toISOString();
  }

  async #run(targets: LibraryEntry[], generation: number): Promise<void> {
    for (const entry of targets) {
      if (this.#generation !== generation) return;
      this.#status.current = { id: entry.id, name: entry.name };
      try {
        await this.analyze(entry);
      } catch (error) {
        this.#status.failed.push({
          id: entry.id,
          name: entry.name,
          error: error instanceof Error ? error.message : String(error),
        });
      }
      if (this.#generation !== generation) return;
      this.#status.done += 1;
    }
    this.#status.running = false;
    this.#status.current = undefined;
    this.#status.finishedAt = new Date().toISOString();
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
