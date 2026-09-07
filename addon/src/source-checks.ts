import { randomUUID } from "node:crypto";
import { browserSupport } from "./direct-play.ts";
import { inspectEntry } from "./inspection.ts";
import { ImportError } from "./imports/errors.ts";
import { entrySourceDefinitionRevision } from "./imports/source-identity.ts";
import type { Library } from "./library.ts";
import { MediaSelectionError } from "./media-file-selection.ts";
import { MediaProbeError, probeMedia } from "./media-probe.ts";
import { ACTIVE_CHECK_PHASES, type SourceCheck } from "./source-check-types.ts";
import { TorrServerError, type TorrServerClient } from "./torrserver-client.ts";
export { browserSupport } from "./direct-play.ts";

type CheckOptions = {
  probe?: boolean;
  fileId?: number;
  mode?: "basic" | "extended";
};
type Inspection = Awaited<ReturnType<typeof inspectEntry>>;
export type CheckResult = {
  check: SourceCheck & { entryId: string };
  inspection?: Inspection;
};
type Job = {
  entryId: string;
  check: SourceCheck;
  controller: AbortController;
  running: boolean;
  options: { probe: boolean; fileId?: number; mode: "basic" | "extended" };
  deadline: AbortController;
  expiresAt: number;
  timer?: ReturnType<typeof setTimeout>;
  inspection?: Inspection;
  pending: Set<Promise<unknown>>;
  report: Promise<CheckResult>;
  reportResult: (result: CheckResult) => void;
  drained: Promise<void>;
  drain: () => void;
};
type CheckDependencies = {
  inspect?: typeof inspectEntry;
  probe?: typeof probeMedia;
  timeoutMs?: number;
  probeTimeoutMs?: number;
};

function untilAbort<T>(
  operation: Promise<T>,
  signal: AbortSignal,
  job: Job,
): Promise<T> {
  job.pending.add(operation);
  return new Promise((resolve, reject) => {
    const abort = () => {
      signal.removeEventListener("abort", abort);
      reject(signal.reason);
    };
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    operation.then(
      (value) => {
        job.pending.delete(operation);
        signal.removeEventListener("abort", abort);
        resolve(value);
      },
      (error) => {
        job.pending.delete(operation);
        signal.removeEventListener("abort", abort);
        reject(error);
      },
    );
  });
}

export class SourceChecks {
  private readonly library: Library;
  private readonly torrServer: TorrServerClient;
  private readonly inspect: typeof inspectEntry;
  private readonly probe: typeof probeMedia;
  private readonly timeoutMs?: number;
  private readonly probeTimeoutMs?: number;
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
    this.timeoutMs = dependencies.timeoutMs;
    this.probeTimeoutMs = dependencies.probeTimeoutMs;
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
      active?.check.revision === revision &&
      active.check.jobId === entry.sourceCheck?.jobId
        ? active.check
        : entry.sourceCheck;
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
      const job = await this.enqueue(entryId, options);
      return { entryId, ...job.check };
    });
  }

  async check(
    entryId: string,
    options: CheckOptions = {},
    signal?: AbortSignal,
  ): Promise<CheckResult> {
    signal?.throwIfAborted();
    const job = await this.command(() => this.enqueue(entryId, options));
    let cancellation: Promise<unknown> | undefined;
    const abort = () => {
      cancellation = this.cancel(entryId, job.check.revision, job.check.jobId);
    };
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
    try {
      const result = await job.report;
      if (signal?.aborted) {
        await cancellation;
        await job.drained;
        signal.throwIfAborted();
      }
      return result;
    } finally {
      signal?.removeEventListener("abort", abort);
    }
  }

  private async enqueue(entryId: string, options: CheckOptions): Promise<Job> {
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
      active.check.jobId === entry.sourceCheck?.jobId &&
      !active.controller.signal.aborted
    ) {
      if (
        active.options.probe !== (options.probe ?? true) ||
        active.options.fileId !== options.fileId ||
        active.options.mode !== (options.mode ?? "basic")
      )
        throw new ImportError(
          "check_in_progress",
          "A different check is running for this entry. Cancel it before changing the check options.",
          409,
        );
      return active;
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
      this.report(active);
      active.drain();
    }
    const check: SourceCheck = {
      jobId: randomUUID(),
      revision,
      phase: "queued",
      probe: options.probe ?? true,
      mode: options.mode ?? "basic",
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
    let reportResult!: Job["reportResult"];
    let drain!: Job["drain"];
    const budget =
      this.timeoutMs ?? (check.mode === "extended" ? 180_000 : 60_000);
    const job: Job = {
      entryId,
      check,
      controller: new AbortController(),
      running: false,
      options: {
        probe: options.probe ?? true,
        fileId: options.fileId,
        mode: options.mode ?? "basic",
      },
      deadline: new AbortController(),
      expiresAt: Date.now() + budget,
      pending: new Set(),
      report: new Promise((resolve) => {
        reportResult = resolve;
      }),
      reportResult,
      drained: new Promise((resolve) => {
        drain = resolve;
      }),
      drain,
    };
    job.timer = setTimeout(() => {
      job.deadline.abort(new Error("Check deadline reached"));
      if (!job.running)
        void this.command(async () => {
          if (
            this.jobs.get(entryId) !== job ||
            !ACTIVE_CHECK_PHASES.has(job.check.phase)
          )
            return;
          await this.progress(job, {
            phase: "complete",
            outcome: "inconclusive",
            stage: "metadata",
            code: "check_timeout",
            message:
              "The check's time budget expired while queued. Retry when the current check has stopped.",
          });
          this.removeQueued(job);
        }).catch((error: unknown) => {
          if (!(
            error instanceof ImportError && error.code === "source_changed"
          )) {
            console.error(
              JSON.stringify({
                level: "error",
                event: "source_check_state_failed",
                entryId,
              }),
            );
            job.check = {
              ...job.check,
              phase: "failed",
              outcome: "unavailable",
              code: "check_state_failed",
              message: "Check status could not be saved. Refresh and retry.",
            };
          }
          this.removeQueued(job);
        });
    }, budget);
    job.timer.unref();
    this.jobs.set(entryId, job);
    this.waiting.push(job);
    this.pump();
    return job;
  }

  cancel(entryId: string, expectedRevision?: string, expectedJobId?: string) {
    return this.command(async () => {
      const job = this.jobs.get(entryId);
      if (
        job &&
        ACTIVE_CHECK_PHASES.has(job.check.phase) &&
        (expectedRevision === undefined ||
          job.check.revision === expectedRevision) &&
        (expectedJobId === undefined || job.check.jobId === expectedJobId)
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
        this.report(job);
        if (!job.running) this.removeQueued(job);
      }
      return this.get(entryId);
    });
  }

  private report(job: Job) {
    clearTimeout(job.timer);
    const check: SourceCheck = ACTIVE_CHECK_PHASES.has(job.check.phase)
      ? {
          ...job.check,
          phase: "cancelled",
          code: "source_changed",
          message: "A newer source or check replaced this attempt.",
        }
      : job.check;
    job.reportResult({
      check: { entryId: job.entryId, ...check },
      inspection: job.inspection,
    });
  }

  private removeQueued(job: Job) {
    const at = this.waiting.indexOf(job);
    if (at >= 0) this.waiting.splice(at, 1);
    if (this.jobs.get(job.entryId) === job) this.jobs.delete(job.entryId);
    this.report(job);
    job.drain();
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
          active.drain();
          this.pump();
        });
      this.running.add(operation);
      return;
    }
  }

  private async progress(job: Job, patch: Partial<SourceCheck>): Promise<void> {
    if (
      this.jobs.get(job.entryId) !== job ||
      !ACTIVE_CHECK_PHASES.has(job.check.phase)
    )
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
    const signal = AbortSignal.any([
      job.deadline.signal,
      job.controller.signal,
    ]);
    let stageSignal = signal;
    const progress = (patch: Partial<SourceCheck>) =>
      this.command(() => this.progress(job, patch));
    try {
      await progress({
        phase: "inspecting",
        stage: "metadata",
        message:
          "Resolving source metadata. Torrent sources may contact peers.",
      });
      const entry = await this.library.get(job.entryId);
      if (!entry || entrySourceDefinitionRevision(entry) !== job.check.revision)
        throw new ImportError("source_changed", "The source changed.", 409);
      signal.throwIfAborted();
      const metadataBudget = Math.max(
        1,
        Math.min(
          job.options.mode === "extended" ? 60_000 : 30_000,
          job.expiresAt - Date.now(),
        ),
      );
      stageSignal = AbortSignal.any([
        signal,
        AbortSignal.timeout(metadataBudget),
      ]);
      const inspection = await untilAbort(
        this.inspect(entry, this.torrServer, this.library, {
          signal: stageSignal,
          timeoutMs: metadataBudget,
          fileId: job.options.fileId,
        }),
        stageSignal,
        job,
      );
      stageSignal.throwIfAborted();
      job.inspection = inspection;
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
      await progress({
        phase: job.check.probe ? "probing" : "complete",
        stage: job.check.probe ? "sample" : "metadata",
        outcome: job.check.probe ? undefined : "observed",
        message: job.check.probe
          ? "Metadata resolved. Reading a limited video sample."
          : "Metadata resolved. Video playback has not been checked.",
        fileId: selected.id,
        sourceHash: selected.hash || inspection.hash || undefined,
        filePath: file.path,
        fileLength: file.length,
        totalFiles:
          "partial" in inspection && inspection.partial
            ? inspection.totalSelectedFiles
            : inspection.selectedFiles.length,
        checkedFiles: 0,
      });
      if (!job.check.probe) return;
      signal.throwIfAborted();
      const sampleBudget = Math.max(
        1,
        Math.min(
          this.probeTimeoutMs ??
            (job.options.mode === "extended" ? 120_000 : 20_000),
          job.expiresAt - Date.now(),
        ),
      );
      stageSignal = AbortSignal.any([
        signal,
        AbortSignal.timeout(sampleBudget),
      ]);
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
          { signal: stageSignal, timeoutMs: sampleBudget, bounded: true },
        ),
        stageSignal,
        job,
      );
      stageSignal.throwIfAborted();
      if (
        !technical.videoCodec ||
        !(technical.decodedVideoFrames && technical.decodedVideoFrames > 0)
      )
        throw new MediaProbeError(
          "No readable video frame was observed in the sample",
          technical.videoCodec ? "sample_unreadable" : "no_video",
          technical,
        );
      const support = browserSupport(technical);
      await progress({
        phase: "complete",
        outcome: "observed",
        checkedFiles: 1,
        technical,
        browserSupport: support,
        message:
          support === "likely"
            ? "A small video sample was read. Browser support is likely; full-file availability and sustained playback remain untested."
            : "A small video sample was read. Browser support is uncertain or limited; a native player may support this format.",
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
      let outcome: SourceCheck["outcome"] = "unavailable";
      let code = "check_failed";
      let message =
        "The entry is saved, but its source could not be checked. Retry or review the source.";
      if (job.controller.signal.aborted) {
        outcome = undefined;
        phase = this.closing ? "interrupted" : "cancelled";
        code = phase;
        message = this.closing
          ? "The check was interrupted by shutdown. Retry when ready."
          : "Check stopped. The saved entry was kept.";
      } else if (stageSignal.aborted) {
        phase = "complete";
        outcome = "inconclusive";
        code = job.deadline.signal.aborted
          ? "check_timeout"
          : job.check.stage === "sample"
            ? "probe_timeout"
            : "metadata_timeout";
        message =
          "The check reached its time limit. The entry is saved; retry later or choose another source.";
      } else if (error instanceof TorrServerError) {
        code = error.code;
        if (["metadata_timeout", "timeout"].includes(code)) {
          phase = "complete";
          outcome = "inconclusive";
        }
        message = ["metadata_timeout", "timeout"].includes(error.code)
          ? "No torrent metadata arrived in time. The swarm may be unavailable; retry later or choose another source."
          : "TorrServer could not inspect this source. Check the engine status and retry.";
      } else if (error instanceof MediaSelectionError) {
        outcome = "invalid";
        code = "no_playable_file";
        message =
          "Metadata was received, but no selected playable file was found. Review the entry's Files selection.";
      } else if (error instanceof MediaProbeError) {
        code = error.code;
        if (
          [
            "probe_timeout",
            "no_video",
            "sample_unreadable",
            "probe_failed",
            "cancelled",
          ].includes(code)
        ) {
          phase = "complete";
          outcome = "inconclusive";
        }
        message =
          error.code === "probe_unavailable"
            ? "Metadata resolved, but ffprobe is unavailable on this host."
            : error.code === "probe_timeout"
              ? "Metadata resolved, but the video sample timed out. Playback availability is still unknown."
              : error.code === "no_video"
                ? "No readable video stream was observed within the sample budget. Availability remains unknown."
                : error.code === "probe_response"
                  ? "The probe tool returned an invalid response. Media availability could not be assessed."
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
      if (
        this.jobs.get(job.entryId) === job &&
        ACTIVE_CHECK_PHASES.has(job.check.phase)
      )
        await progress({
          phase,
          outcome,
          code,
          message,
          ...(error instanceof MediaProbeError && error.technical
            ? {
                technical: error.technical,
                browserSupport: browserSupport(error.technical),
              }
            : {}),
        }).catch((failure: unknown) => {
          if (!(
            failure instanceof ImportError && failure.code === "source_changed"
          )) {
            job.check = {
              ...job.check,
              phase: "failed",
              outcome: "unavailable",
              code: "check_state_failed",
              message: "Check status could not be saved. Refresh and retry.",
            };
            throw failure;
          }
        });
    } finally {
      this.report(job);
      // Reporting a deadline is bounded; releasing the serial work slot is not
      // allowed until even an abort-ignoring dependency has physically settled.
      await Promise.allSettled([...job.pending]);
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
      this.removeQueued(job);
    }
    await Promise.allSettled([...this.running]);
  }
}
