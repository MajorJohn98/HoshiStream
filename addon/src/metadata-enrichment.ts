// Metadata enrichment from Cinemeta (ADR 0026). Pull-and-store: fetched
// values are written into the entry once and marked as enrichment-owned in
// `entry.metadata`, so viewer edits win and Unlink can take back exactly
// what was fetched. Nothing here runs unless the settings toggle is on.
import type { ArtworkCache } from "./artwork-cache.ts";
import {
  CinemetaClient,
  CinemetaError,
  type CinemetaCandidate,
  type CinemetaMeta,
  type CinemetaType,
  cinemetaVideoSchema,
} from "./cinemeta.ts";
import type { Library } from "./library.ts";
import type { MetadataSettingsStore } from "./metadata-settings.ts";
import { tagKey, tagNameSchema, type Tags } from "./tags.ts";
import {
  normalizeTitle,
  releaseYear,
  titleQuery,
  type TitleQuery,
} from "./title-query.ts";
import {
  ARTWORK_KINDS,
  ENRICHABLE_FIELDS,
  YOUTUBE_ID,
  episodeKey,
  episodeMetadataSchema,
  titleMetadataSchema,
  type ArtworkKind,
  type ArtworkRef,
  type EnrichableField,
  type EntryMetadata,
  type Episodes,
  type LibraryEntry,
  type MetadataCandidate,
  type TitleMetadata,
} from "./types.ts";

export type EnrichMode = "fill" | "replace";
export type EnrichmentField = Exclude<EnrichableField, "tags" | "ongoing">;
const MAX_CANDIDATES = 5;
const MAX_EPISODES = 500;
const BACKFILL_GAP_MS = 500;

export interface MappedMeta {
  fields: Partial<Record<EnrichmentField, unknown>>;
  genres: string[];
  ongoing: boolean | undefined;
  episodes: Episodes;
  images: Partial<Record<ArtworkKind, string>>;
}

export class MetadataError extends Error {
  readonly code:
    "disabled" | "not-found" | "no-match" | "unavailable" | "busy" | "invalid";
  constructor(code: MetadataError["code"], message: string) {
    super(message);
    this.name = "MetadataError";
    this.code = code;
  }
}

const HTTPS = /^https:\/\//;
const cinemetaTypeOf = (entry: LibraryEntry): CinemetaType =>
  entry.type === "series" ? "series" : "movie";

function isEmpty(value: unknown): boolean {
  if (value === undefined || value === null || value === false) return true;
  if (typeof value === "string") return value.trim() === "";
  if (Array.isArray(value)) return value.length === 0;
  return false;
}

function httpsUrl(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed && HTTPS.test(trimmed) ? trimmed : undefined;
}

function nameList(values: string[] | undefined): string[] | undefined {
  if (!values) return undefined;
  const seen = new Set<string>();
  const names: string[] = [];
  for (const raw of values) {
    const name = raw.trim().slice(0, 200);
    if (!name || seen.has(name.toLowerCase())) continue;
    seen.add(name.toLowerCase());
    names.push(name);
    if (names.length === 50) break;
  }
  return names.length ? names : undefined;
}

const RATING = /^(?:10(?:\.0)?|[0-9](?:\.[0-9])?)$/;
function rating(value: string | number | undefined): string | undefined {
  if (value === undefined) return undefined;
  // Keep Cinemeta's own display text ("8.6", "9.0") when it already fits.
  if (typeof value === "string" && RATING.test(value.trim()))
    return /^0(?:\.0)?$/.test(value.trim()) ? undefined : value.trim();
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0 || number > 10) return undefined;
  const text = Number.isInteger(number) ? String(number) : number.toFixed(1);
  return text === "0" || text === "0.0" ? undefined : text;
}

function releaseInfo(meta: CinemetaMeta): string | undefined {
  const raw = meta.releaseInfo ?? meta.year;
  if (raw === undefined) return undefined;
  const text = String(raw).trim().replace(/[–—]/g, "-");
  return /^\d{4}(?:-\d{0,4})?$/.test(text) ? text : undefined;
}

/** Cinemeta meta → our field shapes, validated against our own limits. */
export function mapCinemetaMeta(
  meta: CinemetaMeta,
  entry: Pick<LibraryEntry, "type" | "inspectionCache" | "episodeOverrides">,
): MappedMeta {
  const title: Partial<Record<keyof TitleMetadata, unknown>> = {
    releaseInfo: releaseInfo(meta),
    runtime: meta.runtime?.trim().slice(0, 40) || undefined,
    imdbRating: rating(meta.imdbRating),
    cast: nameList(meta.cast),
    director: nameList(meta.director),
    writer: nameList(meta.writer),
    country: meta.country?.trim().slice(0, 200) || undefined,
    language: meta.language?.trim().slice(0, 200) || undefined,
    logo: httpsUrl(meta.logo),
    awards: meta.awards?.trim().slice(0, 300) || undefined,
    trailers: (() => {
      const seen = new Set<string>();
      const trailers = (meta.trailers ?? [])
        .filter((trailer) => YOUTUBE_ID.test(trailer.source))
        .filter((trailer) => {
          if (seen.has(trailer.source)) return false;
          seen.add(trailer.source);
          return true;
        })
        .slice(0, 10)
        .map((trailer) => ({ source: trailer.source, type: "Trailer" }));
      return trailers.length ? trailers : undefined;
    })(),
  };
  const fields: MappedMeta["fields"] = {};
  const description = meta.description?.trim();
  if (description) fields.description = description.slice(0, 4000);
  const poster = httpsUrl(meta.poster);
  if (poster) fields.poster = poster;
  const background = httpsUrl(meta.background);
  if (background) fields.background = background;
  for (const [key, value] of Object.entries(title)) {
    if (value === undefined) continue;
    const parsed =
      titleMetadataSchema.shape[key as keyof TitleMetadata].safeParse(value);
    if (parsed.success && parsed.data !== undefined)
      fields[key as keyof TitleMetadata] = parsed.data;
  }

  const genres: string[] = [];
  const genreKeys = new Set<string>();
  for (const raw of meta.genres ?? meta.genre ?? []) {
    const parsed = tagNameSchema.safeParse(raw);
    if (!parsed.success || genreKeys.has(tagKey(parsed.data))) continue;
    genreKeys.add(tagKey(parsed.data));
    genres.push(parsed.data);
  }

  const series = entry.type === "series";
  const ongoing = series
    ? meta.status?.trim().toLowerCase() === "continuing"
    : undefined;

  const images: MappedMeta["images"] = {};
  if (poster) images.poster = poster;
  if (background) images.background = background;
  const logo = httpsUrl(meta.logo);
  if (logo) images.logo = logo;

  return {
    fields,
    genres,
    ongoing,
    episodes: series ? mapEpisodes(meta, entry) : {},
    images,
  };
}

function mapEpisodes(
  meta: CinemetaMeta,
  entry: Pick<LibraryEntry, "inspectionCache" | "episodeOverrides">,
): Episodes {
  const knownSeasons = new Set<number>();
  for (const file of entry.inspectionCache?.selectedFiles ?? [])
    if (file.season !== undefined) knownSeasons.add(file.season);
  for (const override of entry.episodeOverrides ?? [])
    knownSeasons.add(override.season);
  const rows: { season: number; episode: number; key: string }[] = [];
  const episodes: Episodes = {};
  for (const raw of meta.videos ?? []) {
    const video = cinemetaVideoSchema.safeParse(raw);
    if (!video.success) continue;
    const season = video.data.season;
    const episode = video.data.episode ?? video.data.number;
    if (season === undefined || episode === undefined || episode < 1) continue;
    if (season === 0 && !knownSeasons.has(0)) continue;
    const key = episodeKey(season, episode);
    if (key in episodes) continue;
    const candidate = {
      title: video.data.name?.trim() || video.data.title?.trim() || undefined,
      overview:
        video.data.overview?.trim() ||
        video.data.description?.trim() ||
        undefined,
      released: video.data.released ?? video.data.firstAired,
    };
    const parsed = episodeMetadataSchema.safeParse(candidate);
    const value = parsed.success
      ? parsed.data
      : episodeMetadataSchema.safeParse({
          title: candidate.title?.slice(0, 200),
          overview: candidate.overview?.slice(0, 2000),
        }).data;
    if (!value || !Object.keys(value).length) continue;
    episodes[key] = value;
    rows.push({ season, episode, key });
  }
  if (rows.length <= MAX_EPISODES) return episodes;
  // Over the cap: seasons the entry has files for come first, then by number.
  rows.sort((a, b) => {
    const aKnown = knownSeasons.has(a.season) ? 0 : 1;
    const bKnown = knownSeasons.has(b.season) ? 0 : 1;
    return aKnown - bKnown || a.season - b.season || a.episode - b.episode;
  });
  const kept: Episodes = {};
  for (const row of rows.slice(0, MAX_EPISODES))
    kept[row.key] = episodes[row.key];
  return kept;
}

export interface MergeResult {
  candidate: Record<string, unknown>;
  metadata: EntryMetadata;
  written: string[];
}

/**
 * Ownership merge (ADR 0026). `fill` writes only empty fields; `replace`
 * also rewrites enrichment-owned ones and drops owned values the new meta no
 * longer has. Tags are a whole field: viewer tags stay, genres are added.
 */
export function mergeEnrichment(
  current: LibraryEntry,
  mapped: MappedMeta,
  mode: EnrichMode,
  base: EntryMetadata,
  genreTags: string[],
): MergeResult {
  const candidate: Record<string, unknown> = { ...current };
  const owned = new Set<EnrichableField>(base.owned);
  const written: string[] = [];
  const mayWrite = (field: EnrichableField) =>
    isEmpty(current[field]) || (mode === "replace" && owned.has(field));

  for (const field of ENRICHABLE_FIELDS) {
    if (field === "tags" || field === "ongoing") continue;
    const value = mapped.fields[field];
    if (value !== undefined) {
      if (!mayWrite(field)) continue;
      candidate[field] = value;
      owned.add(field);
      written.push(field);
    } else if (mode === "replace" && owned.has(field)) {
      delete candidate[field];
      owned.delete(field);
      written.push(field);
    }
  }

  if (mapped.ongoing !== undefined) {
    if (mayWrite("ongoing")) {
      if (mapped.ongoing) {
        if (!current.ongoing) written.push("ongoing");
        candidate.ongoing = true;
        owned.add("ongoing");
      } else {
        if (current.ongoing) written.push("ongoing");
        delete candidate.ongoing;
        owned.delete("ongoing");
      }
    }
  }

  let ownedTags = base.ownedTags;
  if (genreTags.length && mayWrite("tags")) {
    const ownedKeys = new Set(base.ownedTags.map(tagKey));
    const viewerTags = (current.tags ?? []).filter(
      (tag) => !ownedKeys.has(tagKey(tag)),
    );
    const viewerKeys = new Set(viewerTags.map(tagKey));
    const added = genreTags.filter((tag) => !viewerKeys.has(tagKey(tag)));
    const tags = [...viewerTags, ...added].slice(0, 32);
    ownedTags = added.filter((tag) => tags.includes(tag));
    if (tags.length) candidate.tags = tags;
    else delete candidate.tags;
    if (ownedTags.length) owned.add("tags");
    else owned.delete("tags");
    if (JSON.stringify(tags) !== JSON.stringify(current.tags ?? []))
      written.push("tags");
  }

  const ownedEpisodes = new Set(base.ownedEpisodes);
  const episodes: Episodes = { ...(current.episodes ?? {}) };
  let episodesChanged = false;
  for (const [key, value] of Object.entries(mapped.episodes)) {
    const existing = episodes[key];
    const writable =
      !existing || (mode === "replace" && ownedEpisodes.has(key));
    if (!writable) continue;
    if (JSON.stringify(existing) !== JSON.stringify(value))
      episodesChanged = true;
    episodes[key] = value;
    ownedEpisodes.add(key);
  }
  if (mode === "replace")
    for (const key of [...ownedEpisodes])
      if (!(key in mapped.episodes) && key in episodes) {
        delete episodes[key];
        ownedEpisodes.delete(key);
        episodesChanged = true;
      }
  if (Object.keys(episodes).length > MAX_EPISODES) {
    // Keep viewer keys; trim enrichment keys past the schema cap.
    for (const key of [...ownedEpisodes].reverse()) {
      if (Object.keys(episodes).length <= MAX_EPISODES) break;
      if (current.episodes?.[key] && !base.ownedEpisodes.includes(key))
        continue;
      delete episodes[key];
      ownedEpisodes.delete(key);
    }
  }
  if (episodesChanged) written.push("episodes");
  if (Object.keys(episodes).length) candidate.episodes = episodes;
  else delete candidate.episodes;

  const metadata: EntryMetadata = {
    ...base,
    owned: [...owned],
    ownedTags,
    ownedEpisodes: [...ownedEpisodes].filter((key) => key in episodes),
  };
  candidate.metadata = metadata;
  return { candidate, metadata, written };
}

/** Strip everything enrichment owns; returns the entry without `metadata`. */
export function stripEnrichment(entry: LibraryEntry): Record<string, unknown> {
  const candidate: Record<string, unknown> = { ...entry };
  const metadata = entry.metadata;
  if (!metadata) return candidate;
  for (const field of metadata.owned) {
    if (field === "tags") {
      const ownedKeys = new Set(metadata.ownedTags.map(tagKey));
      const tags = (entry.tags ?? []).filter(
        (tag) => !ownedKeys.has(tagKey(tag)),
      );
      if (tags.length) candidate.tags = tags;
      else delete candidate.tags;
      continue;
    }
    delete candidate[field];
  }
  if (metadata.ownedEpisodes.length && entry.episodes) {
    const episodes = { ...entry.episodes };
    for (const key of metadata.ownedEpisodes) delete episodes[key];
    if (Object.keys(episodes).length) candidate.episodes = episodes;
    else delete candidate.episodes;
  }
  delete candidate.metadata;
  return candidate;
}

// Auto-accept only when the answer is unambiguous: a single hit, or a top
// hit whose name equals the cleaned title (and year, when both are known).
export function pickCandidate(
  query: TitleQuery,
  candidates: CinemetaCandidate[],
): CinemetaCandidate | undefined {
  if (!candidates.length) return undefined;
  if (candidates.length === 1) return candidates[0];
  const top = candidates[0];
  if (normalizeTitle(top.name) !== normalizeTitle(query.title))
    return undefined;
  const year = releaseYear(top.releaseInfo);
  if (query.year !== undefined && year !== undefined && year !== query.year)
    return undefined;
  return top;
}

export interface EnrichOutcome {
  status: EntryMetadata["status"];
  written: string[];
  metadata?: EntryMetadata;
}

export interface BackfillProgress {
  running: boolean;
  done: number;
  total: number;
  matched: number;
  needsReview: number;
  failed: number;
  startedAt?: string;
  finishedAt?: string;
}

export interface MetadataEnrichmentOptions {
  library: Library;
  tags: Tags;
  settings: MetadataSettingsStore;
  client: CinemetaClient;
  artwork?: ArtworkCache;
  sleep?: (ms: number) => Promise<void>;
  now?: () => Date;
}

export class MetadataEnrichment {
  readonly #library: Library;
  readonly #tags: Tags;
  readonly #settings: MetadataSettingsStore;
  readonly #client: CinemetaClient;
  readonly #artwork?: ArtworkCache;
  readonly #sleep: (ms: number) => Promise<void>;
  readonly #now: () => Date;
  readonly #pending = new Set<Promise<unknown>>();
  #backfill: BackfillProgress = {
    running: false,
    done: 0,
    total: 0,
    matched: 0,
    needsReview: 0,
    failed: 0,
  };
  #backfillRun?: Promise<void>;

  constructor(options: MetadataEnrichmentOptions) {
    this.#library = options.library;
    this.#tags = options.tags;
    this.#settings = options.settings;
    this.#client = options.client;
    this.#artwork = options.artwork;
    this.#sleep =
      options.sleep ??
      ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.#now = options.now ?? (() => new Date());
  }

  get settings(): MetadataSettingsStore {
    return this.#settings;
  }

  async enabled(): Promise<boolean> {
    return (await this.#settings.read()).enabled;
  }

  /** True when a new entry should be enriched in the background. */
  async autoOnAdd(): Promise<boolean> {
    const settings = await this.#settings.read();
    return settings.enabled && settings.autoOnAdd;
  }

  /**
   * Fire-and-forget enrichment after an add. Never throws and never delays
   * the caller; failures land in `entry.metadata.lastError`.
   */
  queueAuto(entryId: string): void {
    const run = this.autoOnAdd()
      .then(async (auto) => {
        if (!auto) return;
        const entry = await this.#library.get(entryId);
        if (!entry) return;
        const imdbId = entry.metadata?.imdbId;
        return imdbId
          ? this.apply(entryId, imdbId, "fill")
          : this.enrich(entryId, "fill");
      })
      .catch((error: unknown) => {
        console.warn(
          JSON.stringify({
            level: "warn",
            event: "metadata_auto_failed",
            entryId,
            message: error instanceof Error ? error.message : String(error),
          }),
        );
      })
      .finally(() => this.#pending.delete(run));
    this.#pending.add(run);
  }

  /** Wait for queued automatic runs; tests and shutdown. */
  async settle(): Promise<void> {
    while (this.#pending.size) await Promise.allSettled([...this.#pending]);
  }

  async search(entryId: string, query?: string) {
    await this.#requireEnabled();
    const entry = await this.#entry(entryId);
    const parsed = query?.trim()
      ? { title: query.trim() }
      : titleQuery(entry.name);
    const candidates = await this.#search(cinemetaTypeOf(entry), parsed);
    return { query: parsed, candidates: candidates.slice(0, 20) };
  }

  /** Search by name, auto-accept when unambiguous, then fetch and merge. */
  async enrich(entryId: string, mode: EnrichMode): Promise<EnrichOutcome> {
    await this.#requireEnabled();
    const entry = await this.#entry(entryId);
    const query = titleQuery(entry.name);
    const base = this.#base(entry, { query });
    let candidates: CinemetaCandidate[];
    try {
      candidates = await this.#search(cinemetaTypeOf(entry), query);
    } catch (error) {
      return this.#fail(entryId, base, error);
    }
    const chosen = pickCandidate(query, candidates);
    if (!chosen) {
      const status = candidates.length ? "needs-review" : "unmatched";
      const metadata: EntryMetadata = {
        ...base,
        status,
        imdbId: undefined,
        candidates: candidates.slice(0, MAX_CANDIDATES).map(toCandidate),
        fetchedAt: this.#now().toISOString(),
        lastError: undefined,
      };
      await this.#setMetadata(entryId, metadata);
      return { status, written: [], metadata };
    }
    return this.apply(entryId, chosen.imdbId, mode, { query });
  }

  /** Fetch one IMDb id and merge it into the entry. */
  async apply(
    entryId: string,
    imdbId: string,
    mode: EnrichMode,
    context: { query?: TitleQuery; fresh?: boolean } = {},
  ): Promise<EnrichOutcome> {
    await this.#requireEnabled();
    const entry = await this.#entry(entryId);
    const base = this.#base(entry, context);
    let meta: CinemetaMeta;
    try {
      meta = await this.#client.meta(cinemetaTypeOf(entry), imdbId, {
        fresh: context.fresh,
      });
    } catch (error) {
      if (error instanceof CinemetaError && error.kind === "not-found")
        throw new MetadataError("no-match", "Cinemeta has no such title");
      return this.#fail(entryId, { ...base, imdbId }, error);
    }
    const mapped = mapCinemetaMeta(meta, entry);
    const genreTags = mapped.genres.length
      ? await this.#tags.ensure(mapped.genres)
      : [];
    const fetchedAt = this.#now().toISOString();
    let result: MergeResult | undefined;
    const artworkBefore = base.artwork;
    const updated = await this.#library.mutate(entryId, (current) => {
      const currentBase: EntryMetadata = {
        ...base,
        ...(current.metadata ?? {}),
        query: base.query,
        provider: "cinemeta",
        imdbId,
        status: "matched",
        fetchedAt,
        candidates: undefined,
        lastError: undefined,
      };
      result = mergeEnrichment(current, mapped, mode, currentBase, genreTags);
      return result.candidate;
    });
    if (!updated || !result)
      throw new MetadataError("not-found", "Entry not found");
    const outcome = result as MergeResult;
    await this.#cacheArtwork(entryId, mapped.images, artworkBefore);
    console.log(
      JSON.stringify({
        level: "info",
        event: "metadata_applied",
        entryId,
        mode,
        written: outcome.written,
      }),
    );
    const final = await this.#library.get(entryId);
    return {
      status: "matched",
      written: outcome.written,
      metadata: final?.metadata ?? outcome.metadata,
    };
  }

  async refresh(entryId: string): Promise<EnrichOutcome> {
    await this.#requireEnabled();
    const entry = await this.#entry(entryId);
    const imdbId = entry.metadata?.imdbId;
    if (!imdbId)
      throw new MetadataError("no-match", "This entry has no match yet");
    return this.apply(entryId, imdbId, "replace", { fresh: true });
  }

  /** Remove owned values, cached artwork and the metadata block. */
  async unlink(entryId: string): Promise<LibraryEntry> {
    const updated = await this.#library.mutate(entryId, (current) =>
      current.metadata ? stripEnrichment(current) : undefined,
    );
    if (!updated) throw new MetadataError("not-found", "Entry not found");
    await this.#artwork?.remove(entryId).catch(() => undefined);
    return updated;
  }

  /** Called when an entry is deleted. */
  async forget(entryId: string): Promise<void> {
    await this.#artwork?.remove(entryId).catch(() => undefined);
  }

  backfillStatus(): BackfillProgress {
    return { ...this.#backfill };
  }

  /** Enrich every entry without a match, one at a time. */
  async startBackfill(): Promise<BackfillProgress> {
    await this.#requireEnabled();
    if (this.#backfill.running)
      throw new MetadataError("busy", "A backfill is already running");
    const entries = await this.#library.list();
    const targets = entries
      .filter((entry) => !entry.metadata?.imdbId)
      .map((entry) => entry.id);
    this.#backfill = {
      running: targets.length > 0,
      done: 0,
      total: targets.length,
      matched: 0,
      needsReview: 0,
      failed: 0,
      startedAt: this.#now().toISOString(),
      ...(targets.length ? {} : { finishedAt: this.#now().toISOString() }),
    };
    if (targets.length) this.#backfillRun = this.#runBackfill(targets);
    return this.backfillStatus();
  }

  /** Wait for a running backfill; tests. */
  async awaitBackfill(): Promise<void> {
    await this.#backfillRun;
  }

  async #runBackfill(targets: string[]): Promise<void> {
    for (const [index, entryId] of targets.entries()) {
      if (index > 0) await this.#sleep(BACKFILL_GAP_MS);
      if (!(await this.enabled())) break;
      try {
        const outcome = await this.enrich(entryId, "fill");
        if (outcome.status === "matched") this.#backfill.matched += 1;
        else if (outcome.status === "needs-review")
          this.#backfill.needsReview += 1;
        else if (outcome.status === "unavailable") this.#backfill.failed += 1;
      } catch (error) {
        if (error instanceof MetadataError && error.code === "not-found") {
          // Removed while the backfill ran.
        } else this.#backfill.failed += 1;
      }
      this.#backfill.done += 1;
    }
    this.#backfill.running = false;
    this.#backfill.finishedAt = this.#now().toISOString();
    this.#backfillRun = undefined;
  }

  async #search(type: CinemetaType, query: TitleQuery) {
    // Cinemeta's search ignores years; the year only steers auto-accept.
    return this.#client.search(type, query.title);
  }

  async #cacheArtwork(
    entryId: string,
    images: MappedMeta["images"],
    previous: EntryMetadata["artwork"],
  ) {
    if (!this.#artwork) return;
    const artwork: NonNullable<EntryMetadata["artwork"]> = {};
    let changed = false;
    for (const kind of ARTWORK_KINDS) {
      const url = images[kind];
      const before: ArtworkRef | undefined = previous?.[kind];
      if (!url) {
        if (before) changed = true;
        continue;
      }
      const ref = await this.#artwork.store(entryId, kind, url, before);
      if (ref) {
        artwork[kind] = ref;
        if (ref !== before) changed = true;
      } else if (before) changed = true;
    }
    if (!changed && previous) return;
    await this.#library.mutate(entryId, (current) => {
      if (!current.metadata) return undefined;
      const metadata: EntryMetadata = { ...current.metadata };
      if (Object.keys(artwork).length) metadata.artwork = artwork;
      else delete metadata.artwork;
      return { ...current, metadata };
    });
  }

  #base(entry: LibraryEntry, context: { query?: TitleQuery }): EntryMetadata {
    const existing = entry.metadata;
    return {
      provider: "cinemeta",
      status: existing?.status ?? "unmatched",
      imdbId: existing?.imdbId,
      fetchedAt: existing?.fetchedAt,
      query: context.query ?? existing?.query,
      candidates: existing?.candidates,
      owned: existing?.owned ?? [],
      ownedEpisodes: existing?.ownedEpisodes ?? [],
      ownedTags: existing?.ownedTags ?? [],
      artwork: existing?.artwork,
      lastError: existing?.lastError,
    };
  }

  async #fail(
    entryId: string,
    base: EntryMetadata,
    error: unknown,
  ): Promise<EnrichOutcome> {
    const message =
      error instanceof Error ? error.message : "Cinemeta request failed";
    const metadata: EntryMetadata = {
      ...base,
      status: base.imdbId ? base.status : "unavailable",
      lastError: message.slice(0, 200),
      fetchedAt: this.#now().toISOString(),
    };
    await this.#setMetadata(entryId, metadata);
    console.warn(
      JSON.stringify({
        level: "warn",
        event: "metadata_fetch_failed",
        entryId,
        kind: error instanceof CinemetaError ? error.kind : "error",
      }),
    );
    return { status: metadata.status, written: [], metadata };
  }

  async #setMetadata(entryId: string, metadata: EntryMetadata) {
    await this.#library.mutate(entryId, (current) => ({
      ...current,
      metadata: { ...metadata, artwork: current.metadata?.artwork },
    }));
  }

  async #entry(entryId: string): Promise<LibraryEntry> {
    const entry = await this.#library.get(entryId);
    if (!entry) throw new MetadataError("not-found", "Entry not found");
    return entry;
  }

  async #requireEnabled() {
    if (!(await this.enabled()))
      throw new MetadataError(
        "disabled",
        "Title details from Cinemeta are turned off",
      );
  }
}

function toCandidate(candidate: CinemetaCandidate): MetadataCandidate {
  return {
    imdbId: candidate.imdbId,
    name: candidate.name.slice(0, 200),
    ...(candidate.releaseInfo
      ? { releaseInfo: candidate.releaseInfo.slice(0, 40) }
      : {}),
    ...(candidate.poster ? { poster: candidate.poster } : {}),
  };
}
