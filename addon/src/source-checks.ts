import { randomUUID } from "node:crypto";
import { assessDirectPlay } from "./direct-play.ts";
import { inspectEntry } from "./inspection.ts";
import { ImportError } from "./imports/errors.ts";
import { entrySourceDefinitionRevision } from "./imports/source-identity.ts";
import type { Library } from "./library.ts";
import { MediaSelectionError } from "./media-file-selection.ts";
import { MediaProbeError, probeMedia } from "./media-probe.ts";
import {
  ACTIVE_CHECK_PHASES,
  type SourceCheck,
  type ProbeSummary,
} from "./source-check-types.ts";
import { TorrServerError, type TorrServerClient } from "./torrserver-client.ts";
import { homeSpeedMbps } from "./speedtest.ts";

type CheckOptions = { probe?: boolean; fileId?: number };
type Job = {
  entryId: string;
  check: SourceCheck;
  controller: AbortController;
  running: boolean;
  options: { probe: boolean; fileId?: number };
};
type CheckDependencies = {
  inspect?: typeof inspectEntry;
  probe?: typeof probeMedia;
  timeoutMs?: number;
  probeTimeoutMs?: number;
};

function untilAbort<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => {
      signal.removeEventListener("abort", abort);
      reject(signal.reason);
    };
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    operation.then(
      (value) => {
        signal.removeEventListener("abort", abort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener("abort", abort);
        reject(error);
      },
    );
  });
}

export function browserSupport(
  probe: ProbeSummary,
): SourceCheck["browserSupport"] {
  const container = probe.container?.toLowerCase();
  const video = probe.videoCodec?.toLowerCase();
  const audio = probe.audioCodec?.toLowerCase();
  if (!container || !video) return "unknown";
  if (
    ["mov", "mp4"].includes(container) &&
    video === "h264" &&
    (!audio || ["aac", "mp3"].includes(audio))
  )
    return "likely";
  if (
    ["webm", "matroska"].includes(container) &&
    ["vp8", "vp9", "av1"].includes(video) &&
    (!audio || ["opus", "vorbis"].includes(audio))
  )
    return "likely";
  return "limited";
}

export class SourceChecks {
  private readonly library: Library;
  private readonly torrServer: TorrServerClient;
  private readonly inspect: typeof inspectEntry;
  private readonly probe: typeof probeMedia;
  private readonly timeoutMs: number;
  private readonly probeTimeoutMs: number;
  private readonly jobs = new Map<string, Job>();
  private readonly waiting: Job[] = [];
  private readonly running = new Set<Promise<void>>();
  private commands: Promise<void> = Promise.resolve();
  private closing = false;

  constructor(
    library: Library,
    torrServer: TorrServerClient,
    dependencies: CheckDependencies = {},
  ) {
    this.library = library;
    this.torrServer = torrServer;
    this.inspect = dependencies.inspect ?? inspectEntry;
    this.probe = dependencies.probe ?? probeMedia;
    this.timeoutMs = dependencies.timeoutMs ?? 60_000;
    this.probeTimeoutMs = dependencies.probeTimeoutMs ?? 20_000;
  }

  async initialize() {
    for (const entry of await this.library.list()) {
      const check = entry.sourceCheck;
      if (check && ACTIVE_CHECK_PHASES.has(check.phase)) {
        await this.library.setSourceCheck(
          entry.id,
          {
            ...check,
            phase: "interrupted",
            code: "interrupted",
            updatedAt: new Date().toISOString(),
            message:
              "The previous check was interrupted. Retry when ready; no network check was restarted automatically.",
          },
          entrySourceDefinitionRevision(entry),
          check.jobId,
        );
      }
    }
  }

  private command<T>(action: () => Promise<T>): Promise<T> {
    const result = this.commands.then(action);
    this.commands = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  async get(entryId: string) {
    const entry = await this.library.get(entryId);
    if (!entry)
      throw new ImportError(
        "not_found",
        "The library entry no longer exists.",
        404,
      );
    const revision = entrySourceDefinitionRevision(entry);
    const active = this.jobs.get(entryId);
    const check =
      active?.check.revision === revision ? active.check : entry.sourceCheck;
    if (!check || check.revision !== revision)
      return {
        entryId,
        phase: "unchecked" as const,
        message: "This source has not been checked.",
      };
    if (ACTIVE_CHECK_PHASES.has(check.phase) && !active)
      return {
        entryId,
        ...check,
        phase: "interrupted" as const,
        message: "The check was interrupted. Retry when ready.",
      };
    return { entryId, ...check };
  }

  start(entryId: string, options: CheckOptions = {}) {
    return this.command(async () => {
      if (this.closing)
        throw new ImportError(
          "check_unavailable",
          "The server is shutting down. Retry after it restarts.",
          503,
        );
      const entry = await this.library.get(entryId);
      if (!entry)
        throw new ImportError(
          "not_found",
          "The library entry no longer exists.",
          404,
        );
      const revision = entrySourceDefinitionRevision(entry);
      const active = this.jobs.get(entryId);
      if (
        active &&
        ACTIVE_CHECK_PHASES.has(active.check.phase) &&
        active.check.revision === revision &&
        !active.controller.signal.aborted
      ) {
        if (
          active.options.probe !== (options.probe ?? true) ||
          active.options.fileId !== options.fileId
        )
          throw new ImportError(
            "check_in_progress",
            "A different check is running for this entry. Cancel it before changing the check options.",
            409,
          );
        return { entryId, ...active.check };
      }
      if (this.jobs.size >= 32)
        throw new ImportError(
          "check_queue_full",
          "The check queue is full. Your entry is saved; retry the check later.",
          429,
        );
      active?.controller.abort();
      if (active && !active.running) {
        const at = this.waiting.indexOf(active);
        if (at >= 0) this.waiting.splice(at, 1);
      }
      const check: SourceCheck = {
        jobId: randomUUID(),
        revision,
        phase: "queued",
        probe: options.probe ?? true,
        updatedAt: new Date().toISOString(),
        message: "Saved. Waiting to inspect the source.",
        ...(options.fileId === undefined ? {} : { fileId: options.fileId }),
      };
      if (!(await this.library.setSourceCheck(entryId, check, revision)))
        throw new ImportError(
          "source_changed",
          "The source changed. Start a new check.",
          409,
        );
      const job: Job = {
        entryId,
        check,
        controller: new AbortController(),
        running: false,
        options: { probe: options.probe ?? true, fileId: options.fileId },
      };
      this.jobs.set(entryId, job);
      this.waiting.push(job);
      this.pump();
      return { entryId, ...check };
    });
  }

  cancel(entryId: string, expectedRevision?: string) {
    return this.command(async () => {
      const job = this.jobs.get(entryId);
      if (
        job &&
        ACTIVE_CHECK_PHASES.has(job.check.phase) &&
        (expectedRevision === undefined ||
          job.check.revision === expectedRevision)
      ) {
        job.controller.abort();
        try {
          await this.progress(job, {
            phase: "cancelled",
            code: "cancelled",
            message: "Check stopped. The saved entry was kept.",
          });
        } catch (error) {
          if (!(
            error instanceof ImportError && error.code === "source_changed"
          ))
            throw error;
        }
        if (!job.running && this.jobs.get(entryId) === job) {
          this.jobs.delete(entryId);
          const at = this.waiting.indexOf(job);
          if (at >= 0) this.waiting.splice(at, 1);
        }
      }
      return this.get(entryId);
    });
  }

  private pump() {
    if (this.closing || this.running.size) return;
    let job: Job | undefined;
    while ((job = this.waiting.shift())) {
      if (job.controller.signal.aborted || this.jobs.get(job.entryId) !== job)
        continue;
      const active = job;
      active.running = true;
      const operation = this.run(active)
        .catch(() => {
          console.error(
            JSON.stringify({
              level: "error",
              event: "source_check_state_failed",
              entryId: active.entryId,
            }),
          );
        })
        .finally(() => {
          this.running.delete(operation);
          if (this.jobs.get(active.entryId) === active)
            this.jobs.delete(active.entryId);
          this.pump();
        });
      this.running.add(operation);
      return;
    }
  }

  private async progress(job: Job, patch: Partial<SourceCheck>): Promise<void> {
    if (this.jobs.get(job.entryId) !== job)
      throw new ImportError(
        "source_changed",
        "A newer check replaced this one.",
        409,
      );
    const next = {
      ...job.check,
      ...patch,
      updatedAt: new Date().toISOString(),
    };
    if (
      !(await this.library.setSourceCheck(
        job.entryId,
        next,
        job.check.revision,
        job.check.jobId,
      ))
    )
      throw new ImportError(
        "source_changed",
        "The source changed while it was being checked.",
        409,
      );
    job.check = next;
  }

  private async run(job: Job) {
    const deadline = AbortSignal.timeout(this.timeoutMs);
    const signal = AbortSignal.any([deadline, job.controller.signal]);
    try {
      await this.progress(job, {
        phase: "inspecting",
        message:
          "Resolving source metadata. Torrent sources may contact peers.",
      });
      const entry = await this.library.get(job.entryId);
      if (!entry || entrySourceDefinitionRevision(entry) !== job.check.revision)
        throw new ImportError("source_changed", "The source changed.", 409);
      const inspection = await untilAbort(
        this.inspect(entry, this.torrServer, this.library, {
          signal,
          timeoutMs: 30_000,
        }),
        signal,
      );
      signal.throwIfAborted();
      const selected =
        job.check.fileId === undefined
          ? inspection.selectedFiles[0]
          : inspection.selectedFiles.find(
              (file) => file.id === job.check.fileId,
            );
      if (!selected) throw new MediaSelectionError("No selected playable file");
      const file = inspection.files.find((file) => file.id === selected.id);
      if (!file)
        throw new MediaSelectionError("The selected file was not found");
      await this.progress(job, {
        phase: job.check.probe ? "probing" : "complete",
        message: job.check.probe
          ? "Metadata resolved. Reading a limited video sample."
          : "Metadata resolved. Video playback has not been checked.",
        fileId: selected.id,
        totalFiles: inspection.selectedFiles.length,
        checkedFiles: 0,
      });
      if (!job.check.probe) return;
      const localPath =
        "localPath" in file && typeof file.localPath === "string"
          ? file.localPath
          : undefined;
      const technical = await untilAbort(
        this.probe(
          localPath ?? this.torrServer.streamUrl(inspection.hash, selected),
          {
            id: file.id,
            length: file.length,
            ...(localPath ? { localPath } : {}),
          },
          { signal, timeoutMs: this.probeTimeoutMs, bounded: true },
        ),
        signal,
      );
      signal.throwIfAborted();
      if (!technical.videoCodec)
        throw new MediaProbeError(
          "No video stream was found in the sample",
          "no_video",
        );
      const directPlay = assessDirectPlay(technical, homeSpeedMbps());
      await this.library.setDirectPlay(
        job.entryId,
        directPlay,
        job.check.revision,
      );
      const support = browserSupport(technical);
      await this.progress(job, {
        phase: "complete",
        checkedFiles: 1,
        technical,
        browserSupport: support,
        message:
          support === "likely"
            ? "Basic playback check passed. Player support and network availability can still vary."
            : "Media metadata is available, but this format may need Compatible quality or a native player.",
      });
    } catch (error) {
      if (error instanceof ImportError && error.code === "source_changed") {
        console.log(
          JSON.stringify({
            level: "info",
            event: "source_check_superseded",
            entryId: job.entryId,
          }),
        );
        return;
      }
      let phase: SourceCheck["phase"] = "failed";
      let code = "check_failed";
      let message =
        "The entry is saved, but its source could not be checked. Retry or review the source.";
      if (job.controller.signal.aborted) {
        phase = this.closing ? "interrupted" : "cancelled";
        code = phase;
        message = this.closing
          ? "The check was interrupted by shutdown. Retry when ready."
          : "Check stopped. The saved entry was kept.";
      } else if (deadline.aborted) {
        code = "check_timeout";
        message =
          "The check reached its time limit. The entry is saved; retry later or choose another source.";
      } else if (error instanceof TorrServerError) {
        code = error.code;
        message = ["metadata_timeout", "timeout"].includes(error.code)
          ? "No torrent metadata arrived in time. The swarm may be unavailable; retry later or choose another source."
          : "TorrServer could not inspect this source. Check the engine status and retry.";
      } else if (error instanceof MediaSelectionError) {
        code = "no_playable_file";
        message =
          "Metadata was received, but no selected playable file was found. Review the entry's Files selection.";
      } else if (error instanceof MediaProbeError) {
        code = error.code;
        message =
          error.code === "probe_unavailable"
            ? "Metadata resolved, but ffprobe is unavailable on this host."
            : error.code === "probe_timeout"
              ? "Metadata resolved, but the video sample timed out. Playback availability is still unknown."
              : error.code === "no_video"
                ? "The selected file does not contain a readable video stream."
                : "Metadata resolved, but the video sample could not be read. Retry or use another source.";
      } else if (
        error instanceof Error &&
        "code" in error &&
        error.code === "ENOENT"
      ) {
        code = "source_missing";
        message =
          "The source file is missing. Relink it or choose another source; the library entry was kept.";
      }
      console.error(
        JSON.stringify({
          level: "warn",
          event: "source_check_failed",
          entryId: job.entryId,
          code,
        }),
      );
      await this.progress(job, { phase, code, message });
    }
  }

  async close() {
    this.closing = true;
    await this.commands;
    for (const job of this.jobs.values()) job.controller.abort();
    for (const job of this.waiting.splice(0)) {
      if (this.jobs.get(job.entryId) !== job) continue;
      try {
        await this.progress(job, {
          phase: "interrupted",
          code: "interrupted",
          message: "The check was interrupted by shutdown. Retry when ready.",
        });
      } catch (error) {
        if (!(error instanceof ImportError && error.code === "source_changed"))
          console.error(
            JSON.stringify({
              level: "warn",
              event: "source_check_shutdown_state_failed",
              entryId: job.entryId,
            }),
          );
      }
      this.jobs.delete(job.entryId);
    }
    await Promise.allSettled([...this.running]);
  }
}
