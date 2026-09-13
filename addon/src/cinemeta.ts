// Cinemeta client (ADR 0026): the two public routes of Stremio's metadata
// add-on, read with hard limits. Only a cleaned title (and year) is ever
// sent — never filenames, hashes, magnets, paths or tokens. Responses are
// validated loosely so a shape drift means fewer fields, not a failure.
import { z } from "zod";

export const CINEMETA_URL = "https://v3-cinemeta.strem.io";
const TIMEOUT_MS = 10_000;
const BODY_LIMIT = 2_000_000;
const CACHE_TTL_MS = 3 * 60 * 60 * 1_000;
const MAX_CONCURRENT = 2;
const MAX_QUERY = 120;

export type CinemetaFailure = "unavailable" | "not-found" | "invalid";

export class CinemetaError extends Error {
  readonly kind: CinemetaFailure;
  constructor(kind: CinemetaFailure, message: string) {
    super(message);
    this.name = "CinemetaError";
    this.kind = kind;
  }
}

const IMDB_ID = /^tt\d{7,8}$/;
const text = z.string().trim().min(1);
const textList = z
  .array(z.string())
  .transform((values) => values.map((value) => value.trim()).filter(Boolean));
const intish = z
  .union([z.number(), z.string()])
  .transform((value) => Number(value))
  .refine((value) => Number.isInteger(value) && value >= 0);

const candidateSchema = z
  .object({
    id: z.string(),
    imdb_id: z.string().optional(),
    name: text,
    poster: z.string().optional(),
    releaseInfo: z.union([z.string(), z.number()]).optional(),
    year: z.union([z.string(), z.number()]).optional(),
  })
  .passthrough();
const searchResponseSchema = z
  .object({ metas: z.array(z.unknown()).default([]) })
  .passthrough();

export const cinemetaVideoSchema = z
  .object({
    season: intish.optional(),
    episode: intish.optional(),
    number: intish.optional(),
    name: z.string().optional(),
    title: z.string().optional(),
    overview: z.string().optional(),
    description: z.string().optional(),
    released: z.string().optional(),
    firstAired: z.string().optional(),
    thumbnail: z.string().optional(),
  })
  .passthrough();
export const cinemetaMetaSchema = z
  .object({
    id: z.string(),
    imdb_id: z.string().optional(),
    type: z.string().optional(),
    name: text,
    description: z.string().optional(),
    poster: z.string().optional(),
    background: z.string().optional(),
    logo: z.string().optional(),
    releaseInfo: z.union([z.string(), z.number()]).optional(),
    year: z.union([z.string(), z.number()]).optional(),
    runtime: z.string().optional(),
    imdbRating: z.union([z.string(), z.number()]).optional(),
    cast: textList.optional(),
    director: textList.optional(),
    writer: textList.optional(),
    country: z.string().optional(),
    language: z.string().optional(),
    awards: z.string().optional(),
    genres: textList.optional(),
    genre: textList.optional(),
    trailers: z
      .array(
        z
          .object({ source: z.string(), type: z.string().optional() })
          .passthrough(),
      )
      .optional(),
    status: z.string().optional(),
    videos: z.array(z.unknown()).optional(),
  })
  .passthrough();
const metaResponseSchema = z.object({ meta: z.unknown() }).passthrough();

export type CinemetaMeta = z.infer<typeof cinemetaMetaSchema>;
export type CinemetaVideo = z.infer<typeof cinemetaVideoSchema>;
export interface CinemetaCandidate {
  imdbId: string;
  name: string;
  releaseInfo?: string;
  poster?: string;
}
export type CinemetaType = "movie" | "series";

export interface CinemetaClientOptions {
  baseUrl?: string;
  fetch?: typeof fetch;
  userAgent?: string;
  now?: () => number;
}

// Cinemeta hands back `"2022–"` for a running show and `"2019"` for a film;
// `year` is the same value on older records. Keep it as text.
function releaseText(value: string | number | undefined): string | undefined {
  if (value === undefined) return undefined;
  const trimmed = String(value).trim();
  return trimmed ? trimmed : undefined;
}

function imdbIdOf(candidate: { id: string; imdb_id?: string }) {
  const id = candidate.imdb_id ?? candidate.id;
  return IMDB_ID.test(id) ? id : undefined;
}

async function readCapped(response: Response, limit: number): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) {
    const body = await response.text();
    if (body.length > limit)
      throw new CinemetaError("invalid", "Response exceeds the size limit");
    return body;
  }
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) {
      await reader.cancel().catch(() => undefined);
      throw new CinemetaError("invalid", "Response exceeds the size limit");
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

export class CinemetaClient {
  readonly #baseUrl: string;
  readonly #fetch: typeof fetch;
  readonly #userAgent: string;
  readonly #now: () => number;
  readonly #cache = new Map<string, { at: number; value: unknown }>();
  readonly #inflight = new Map<string, Promise<unknown>>();
  #active = 0;
  readonly #waiting: (() => void)[] = [];

  constructor(options: CinemetaClientOptions = {}) {
    this.#baseUrl = (options.baseUrl ?? CINEMETA_URL).replace(/\/+$/, "");
    this.#fetch = options.fetch ?? fetch;
    this.#userAgent = options.userAgent ?? "HoshiStream";
    this.#now = options.now ?? Date.now;
  }

  async search(
    type: CinemetaType,
    query: string,
  ): Promise<CinemetaCandidate[]> {
    const trimmed = query.trim().slice(0, MAX_QUERY);
    if (!trimmed) return [];
    const path = `/catalog/${type}/top/search=${encodeURIComponent(trimmed)}.json`;
    const payload = await this.#get(path, "search");
    const parsed = searchResponseSchema.safeParse(payload);
    if (!parsed.success)
      throw new CinemetaError("invalid", "Unexpected search response");
    const candidates: CinemetaCandidate[] = [];
    for (const raw of parsed.data.metas) {
      const candidate = candidateSchema.safeParse(raw);
      if (!candidate.success) continue;
      const imdbId = imdbIdOf(candidate.data);
      if (!imdbId) continue;
      const poster = candidate.data.poster;
      candidates.push({
        imdbId,
        name: candidate.data.name,
        releaseInfo: releaseText(
          candidate.data.releaseInfo ?? candidate.data.year,
        ),
        ...(poster && /^https:\/\//.test(poster) ? { poster } : {}),
      });
    }
    return candidates;
  }

  /** `fresh` skips the cache — an explicit Refresh should see new data. */
  async meta(
    type: CinemetaType,
    imdbId: string,
    options: { fresh?: boolean } = {},
  ): Promise<CinemetaMeta> {
    if (!IMDB_ID.test(imdbId))
      throw new CinemetaError("invalid", "Not an IMDb id");
    const path = `/meta/${type}/${imdbId}.json`;
    if (options.fresh) this.#cache.delete(path);
    const payload = await this.#get(path, "meta");
    const envelope = metaResponseSchema.safeParse(payload);
    const meta = envelope.success
      ? cinemetaMetaSchema.safeParse(envelope.data.meta)
      : undefined;
    if (!meta?.success) {
      if (envelope.success && envelope.data.meta === null)
        throw new CinemetaError("not-found", "No such title");
      throw new CinemetaError("invalid", "Unexpected meta response");
    }
    return meta.data;
  }

  /** Drop cached responses; tests. */
  clearCache(): void {
    this.#cache.clear();
  }

  async #get(path: string, route: "search" | "meta"): Promise<unknown> {
    const cached = this.#cache.get(path);
    if (cached && this.#now() - cached.at < CACHE_TTL_MS) return cached.value;
    const pending = this.#inflight.get(path);
    if (pending) return pending;
    const request = this.#request(path, route).then((value) => {
      this.#cache.set(path, { at: this.#now(), value });
      return value;
    });
    this.#inflight.set(path, request);
    try {
      return await request;
    } finally {
      this.#inflight.delete(path);
    }
  }

  async #request(path: string, route: "search" | "meta"): Promise<unknown> {
    await this.#acquire();
    const started = this.#now();
    let status = 0;
    let bytes = 0;
    try {
      let response: Response;
      try {
        response = await this.#fetch(`${this.#baseUrl}${path}`, {
          headers: {
            accept: "application/json",
            "user-agent": this.#userAgent,
          },
          redirect: "follow",
          signal: AbortSignal.timeout(TIMEOUT_MS),
        });
      } catch (error) {
        throw new CinemetaError(
          "unavailable",
          error instanceof Error && error.name === "TimeoutError"
            ? "Cinemeta did not answer in time"
            : "Cinemeta could not be reached",
        );
      }
      status = response.status;
      if (response.status === 404)
        throw new CinemetaError("not-found", "No such title");
      if (!response.ok)
        throw new CinemetaError(
          "unavailable",
          `Cinemeta answered ${response.status}`,
        );
      const body = await readCapped(response, BODY_LIMIT);
      bytes = body.length;
      try {
        return JSON.parse(body) as unknown;
      } catch {
        throw new CinemetaError("invalid", "Cinemeta sent malformed JSON");
      }
    } finally {
      this.#release();
      console.log(
        JSON.stringify({
          level: "info",
          event: "cinemeta_request",
          route,
          status,
          bytes,
          durationMs: this.#now() - started,
        }),
      );
    }
  }

  #acquire(): Promise<void> {
    if (this.#active < MAX_CONCURRENT) {
      this.#active += 1;
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      this.#waiting.push(() => {
        this.#active += 1;
        resolve();
      });
    });
  }

  #release(): void {
    this.#active -= 1;
    this.#waiting.shift()?.();
  }
}
