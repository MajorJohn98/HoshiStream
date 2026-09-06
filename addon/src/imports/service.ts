import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import type { Library } from "../library.ts";
import { entryTagsSchema, type Tags } from "../tags.ts";
import type { TorrServerClient } from "../torrserver-client.ts";
import {
  createEntrySchema,
  type LibraryEntry,
  type SearchReceipt,
  type SeriesSource,
} from "../types.ts";
import { ImportError } from "./errors.ts";
import { ImportFiles } from "./files.ts";
import { MagnetLinks } from "./magnet-links.ts";
import {
  ImportSeries,
  hasSeriesInspection,
  isTorrentSeriesEntry,
} from "./series.ts";
import {
  entryHasHash,
  magnetIdentity,
  MAX_TORRENT_BYTES,
  torrentIdentity,
} from "./source-identity.ts";

export const importPrepareInputSchema = z
  .object({
    magnetUri: z.string().startsWith("magnet:?").max(16_384),
  })
  .strict();
export const importCommitInputSchema = z
  .object({
    draftId: z.string().uuid(),
    name: z.string().trim().min(1).max(200),
    type: z.enum(["movie", "series"]),
    tags: entryTagsSchema.optional(),
    idempotencyKey: z.string().uuid(),
  })
  .strict();
export const seriesPreviewInputSchema = z
  .object({
    draftId: z.string().uuid(),
    entryId: z.string().min(1),
    seasonHint: z.number().int().nonnegative().optional(),
  })
  .strict();
export const seriesCommitInputSchema = z
  .object({
    previewId: z.string().uuid(),
    idempotencyKey: z.string().uuid(),
    allowReplace: z.boolean().default(false),
  })
  .strict();

const TTL_MS = 10 * 60 * 1_000;
const DRAFT_LIMIT = 100;
const PREVIEW_LIMIT = 10;

type DraftRecord = {
  source: SeriesSource;
  hash: string;
  suggestedName?: string;
  staged?: string;
  expires: number;
};
type PreviewRecord = {
  plan: Awaited<ReturnType<ImportSeries["preview"]>>;
  staged?: string;
  expires: number;
};

function receiptFingerprint(
  operation: string,
  input: Record<string, unknown>,
): string {
  return createHash("sha256")
    .update(JSON.stringify({ operation, input }))
    .digest("hex");
}

function existingEntries(entries: LibraryEntry[], hash: string) {
  return entries
    .filter((entry) => entryHasHash(entry, hash))
    .map(({ id, name, type }) => ({ id, name, type }));
}

export class ImportService {
  private readonly library: Library;
  private readonly tags?: Tags;
  private readonly files: ImportFiles;
  private readonly series: ImportSeries;
  private readonly now: () => number;
  private readonly magnetLinks: MagnetLinks;
  private readonly drafts = new Map<string, DraftRecord>();
  private readonly previews = new Map<string, PreviewRecord>();
  private cleanupTimer?: ReturnType<typeof setInterval>;
  private commands: Promise<void> = Promise.resolve();
  private closing = false;
  private pendingCommands = 0;
  private readonly lifecycle = new AbortController();

  constructor(options: {
    library: Library;
    tags?: Tags;
    torrServer: TorrServerClient;
    uploadRoot: string;
    now?: () => number;
  }) {
    this.library = options.library;
    this.tags = options.tags;
    this.files = new ImportFiles(options.uploadRoot);
    this.series = new ImportSeries(options.library, options.torrServer);
    this.now = options.now ?? Date.now;
    this.magnetLinks = new MagnetLinks(this.now);
  }

  async initialize() {
    await this.files.sweep(this.library, this.now(), this.protectedPaths());
    this.cleanupTimer = setInterval(() => {
      void this.command(async () => {
        await this.prune();
        await this.files.sweep(this.library, this.now(), this.protectedPaths());
      }).catch(() =>
        console.error(
          JSON.stringify({
            level: "warn",
            event: "import_cleanup_failed",
          }),
        ),
      );
    }, 60_000);
    this.cleanupTimer.unref();
  }

  async close() {
    this.closing = true;
    this.lifecycle.abort();
    clearInterval(this.cleanupTimer);
    this.magnetLinks.clear();
    await this.commands;
    for (const [draftId] of [...this.drafts]) await this.dropDraft(draftId);
    for (const [previewId] of [...this.previews])
      await this.dropPreview(previewId);
  }

  capabilities() {
    return { version: 1 as const, maxTorrentBytes: MAX_TORRENT_BYTES };
  }

  createMagnetLink(input: z.infer<typeof importPrepareInputSchema>) {
    this.ensureAvailable();
    return this.magnetLinks.issue(input.magnetUri);
  }

  readMagnetLink(id: string) {
    this.ensureAvailable();
    return this.magnetLinks.read(id);
  }

  async listSeries() {
    const entries = await this.library.list();
    return {
      entries: entries.filter(isTorrentSeriesEntry).map((entry) => ({
        id: entry.id,
        name: entry.name,
        inspected: hasSeriesInspection(entry),
        sourceCount: 1 + (entry.extraSources?.length ?? 0),
      })),
    };
  }

  prepareMagnet(input: z.infer<typeof importPrepareInputSchema>) {
    return this.command(async () => {
      this.ensureAvailable();
      await this.prune();
      if (this.drafts.size >= DRAFT_LIMIT)
        throw new ImportError(
          "draft_limit",
          "Close an existing import draft before preparing another.",
          429,
        );
      const { hash, suggestedName } = magnetIdentity(input.magnetUri);
      const draftId = randomUUID();
      const expires = this.now() + TTL_MS;
      this.drafts.set(draftId, {
        hash,
        suggestedName,
        expires,
        source: {
          magnetUri: input.magnetUri,
          sourceHash: hash,
        },
      });
      return this.draftResponse(
        draftId,
        this.drafts.get(draftId)!,
        await this.library.list(),
      );
    });
  }

  prepareTorrent(bytes: Uint8Array) {
    return this.command(async () => {
      this.ensureAvailable();
      await this.prune();
      if (this.drafts.size >= DRAFT_LIMIT)
        throw new ImportError(
          "draft_limit",
          "Close an existing import draft before preparing another.",
          429,
        );
      const identity = await torrentIdentity(bytes);
      const staged = await this.files.stage(bytes);
      const draftId = randomUUID();
      const expires = this.now() + TTL_MS;
      this.drafts.set(draftId, {
        hash: identity.hash,
        suggestedName: identity.suggestedName,
        staged,
        expires,
        source: {
          torrentFilePath: staged,
          managedMedia: true,
          sourceHash: identity.hash,
        },
      });
      return this.draftResponse(
        draftId,
        this.drafts.get(draftId)!,
        await this.library.list(),
      );
    });
  }

  discardDraft(draftId: string) {
    return this.command(() => this.dropDraft(draftId));
  }

  commit(input: z.infer<typeof importCommitInputSchema>) {
    return this.command(async () => {
      const receipt: SearchReceipt = {
        key: input.idempotencyKey,
        fingerprint: receiptFingerprint("manual-import-create", {
          draftId: input.draftId,
          name: input.name,
          type: input.type,
          tags: [...(input.tags ?? [])].sort(),
        }),
      };
      const replay = await this.library.searchReceipt(receipt);
      if (replay) return { entry: replay, outcome: "existing" as const };
      this.ensureAvailable();
      await this.prune();
      const draft = this.requireDraft(input.draftId);
      this.drafts.delete(input.draftId);
      let restore = true;
      try {
        const tags = this.tags
          ? await this.tags.ensure(input.tags ?? [])
          : input.tags;
        const result = await this.library.importSource(
          createEntrySchema.parse({
            name: input.name,
            type: input.type,
            tags,
            magnetUri: draft.source.magnetUri,
            torrentFilePath: draft.source.torrentFilePath,
            managedMedia: draft.source.managedMedia,
          }),
          {
            sourceHash: draft.hash,
            receipt,
          },
        );
        restore = false;
        if (draft.staged) {
          if (result.outcome === "created")
            await this.publish(draft.staged, "import_draft_publish_failed");
          else await this.files.discard(draft.staged);
        }
        return result;
      } finally {
        if (restore) this.drafts.set(input.draftId, draft);
      }
    });
  }

  previewSeries(
    input: z.infer<typeof seriesPreviewInputSchema>,
    signal = new AbortController().signal,
  ) {
    return this.command(async () => {
      this.ensureAvailable();
      await this.prune();
      if (this.previews.size >= PREVIEW_LIMIT)
        throw new ImportError(
          "preview_limit",
          "Close an existing episode preview before opening another.",
          429,
        );
      const draft = this.requireDraft(input.draftId);
      const bounded = AbortSignal.any([
        signal,
        this.lifecycle.signal,
        AbortSignal.timeout(40_000),
      ]);
      const plan = await this.series
        .preview(
          {
            ...draft.source,
            ...(input.seasonHint === undefined
              ? {}
              : { seasonHint: input.seasonHint }),
          },
          input.entryId,
          bounded,
        )
        .catch((error: unknown) => {
          if (bounded.aborted)
            throw new ImportError(
              "preview_cancelled",
              "The episode preview was cancelled or timed out.",
              408,
            );
          throw error;
        });
      if (bounded.aborted)
        throw new ImportError(
          "preview_cancelled",
          "The episode preview was cancelled or timed out.",
          408,
        );
      this.drafts.delete(input.draftId);
      const previewId = randomUUID();
      const expires = this.now() + TTL_MS;
      this.previews.set(previewId, {
        plan,
        staged: draft.staged,
        expires,
      });
      return {
        previewId,
        expiresAt: new Date(expires).toISOString(),
        entryId: plan.entryId,
        entryName: plan.entryName,
        addedEpisodes: plan.addedEpisodes,
        replacements: plan.replacements,
      };
    });
  }

  discardPreview(previewId: string) {
    return this.command(() => this.dropPreview(previewId));
  }

  commitSeries(input: z.infer<typeof seriesCommitInputSchema>) {
    return this.command(async () => {
      const receipt: SearchReceipt = {
        key: input.idempotencyKey,
        fingerprint: receiptFingerprint("manual-import-series", {
          previewId: input.previewId,
          allowReplace: input.allowReplace,
        }),
      };
      const replay = await this.library.searchReceipt(receipt);
      if (replay) return { entry: replay, outcome: "existing" as const };
      this.ensureAvailable();
      await this.prune();
      const preview = this.requirePreview(input.previewId);
      if (preview.plan.replacements.length && !input.allowReplace)
        throw new ImportError(
          "replacement_confirmation_required",
          "Confirm replacement of the overlapping episodes before adding this source.",
          409,
        );
      this.previews.delete(input.previewId);
      let committed = false;
      try {
        const result = await this.series.commit(
          preview.plan,
          receipt,
          input.allowReplace,
        );
        committed = result.outcome === "appended";
        if (preview.staged) {
          if (committed)
            await this.publish(preview.staged, "series_preview_publish_failed");
          else await this.files.discard(preview.staged);
        }
        return result;
      } catch (error) {
        if (preview.staged) await this.files.discard(preview.staged);
        throw error;
      }
    });
  }

  private async prune() {
    this.magnetLinks.prune();
    const now = this.now();
    for (const [draftId, draft] of [...this.drafts]) {
      if (draft.expires > now) continue;
      this.drafts.delete(draftId);
      if (draft.staged) await this.files.discard(draft.staged);
    }
    for (const [previewId, preview] of [...this.previews]) {
      if (preview.expires > now) continue;
      this.previews.delete(previewId);
      if (preview.staged) await this.files.discard(preview.staged);
    }
  }

  private protectedPaths() {
    return [
      ...[...this.drafts.values()].flatMap((draft) =>
        draft.staged ? [draft.staged] : [],
      ),
      ...[...this.previews.values()].flatMap((preview) =>
        preview.staged ? [preview.staged] : [],
      ),
    ];
  }

  private async publish(path: string, event: string) {
    await this.files.publish(path).catch(() => {
      console.error(
        JSON.stringify({
          level: "warn",
          event,
        }),
      );
    });
  }

  private async dropDraft(draftId: string) {
    const draft = this.drafts.get(draftId);
    this.drafts.delete(draftId);
    if (draft?.staged) await this.files.discard(draft.staged);
  }

  private async dropPreview(previewId: string) {
    const preview = this.previews.get(previewId);
    this.previews.delete(previewId);
    if (preview?.staged) await this.files.discard(preview.staged);
  }

  private ensureAvailable() {
    if (this.closing)
      throw new ImportError(
        "import_unavailable",
        "The server is shutting down. Retry after it restarts.",
        503,
      );
  }

  private requireDraft(draftId: string): DraftRecord {
    const draft = this.drafts.get(draftId);
    if (!draft)
      throw new ImportError(
        "draft_expired",
        "This import draft expired. Prepare the source again.",
        410,
      );
    return draft;
  }

  private requirePreview(previewId: string): PreviewRecord {
    const preview = this.previews.get(previewId);
    if (!preview)
      throw new ImportError(
        "preview_expired",
        "This episode preview expired. Review the episode changes again.",
        410,
      );
    return preview;
  }

  private draftResponse(
    draftId: string,
    draft: DraftRecord,
    entries: LibraryEntry[],
  ) {
    return {
      draftId,
      expiresAt: new Date(draft.expires).toISOString(),
      hash: draft.hash,
      ...(draft.suggestedName ? { suggestedName: draft.suggestedName } : {}),
      existingEntries: existingEntries(entries, draft.hash),
    };
  }

  private command<T>(action: () => Promise<T>): Promise<T> {
    if (this.pendingCommands >= 32)
      return Promise.reject(
        new ImportError(
          "import_busy",
          "The import queue is full. Retry shortly.",
          429,
        ),
      );
    this.pendingCommands++;
    const result = this.commands.then(action);
    const settled = result.finally(() => {
      this.pendingCommands--;
    });
    this.commands = settled.then(
      () => undefined,
      () => undefined,
    );
    return settled;
  }
}
