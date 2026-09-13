import { releaseInfo } from "./release.ts";

// Base manifest. Catalogs advertise the "genre" extra so Stremio shows a
// genre picker; its options are the live tag list, filled in per request by
// manifestWithGenres because the registry changes at runtime.
export const manifest = {
  id: "com.john.private-torrent-streamer",
  version: releaseInfo.version,
  name: "HoshiStream",
  description: "Private local library for legally owned or authorized media",
  resources: ["catalog", "meta", "stream", "subtitles"],
  types: ["movie", "series"],
  idPrefixes: ["hoshi:"],
  behaviorHints: { p2p: true },
  catalogs: [
    {
      type: "movie",
      id: "private-movies",
      name: "Private Movies",
      extra: [
        { name: "search", isRequired: false },
        { name: "genre", isRequired: false },
        { name: "skip", isRequired: false },
      ],
    },
    {
      type: "series",
      id: "private-series",
      name: "Private Series",
      extra: [
        { name: "search", isRequired: false },
        { name: "genre", isRequired: false },
        { name: "skip", isRequired: false },
      ],
    },
    // Continue Watching rows (plans/2026-09-13-watched-state-plan.md). No
    // search or genre: the row is short and ordered by recent activity.
    {
      type: "movie",
      id: "continue-watching",
      name: "Continue Watching",
      extra: [{ name: "skip", isRequired: false }],
    },
    {
      type: "series",
      id: "continue-watching",
      name: "Continue Watching",
      extra: [{ name: "skip", isRequired: false }],
    },
  ],
};

type Manifest = typeof manifest;
type ManifestCatalog = Manifest["catalogs"][number];

interface CatalogExtra {
  name: string;
  isRequired: boolean;
  options?: string[];
}

export const RECENTLY_ADDED_ID = "recently-added";
export const UNWATCHED_ID = "unwatched";
export const TAG_CATALOG_PREFIX = "tag-";

// Board rows (Phase 15). Built per manifest request like the genre options
// because pinned tags change at runtime. Row order per type: the picker,
// Continue Watching (from the base), Recently added, Unwatched, then one row
// per pinned tag in pin order.
export interface ManifestIdentity {
  /** Absolute origin of this add-on as the client reached it. */
  addonUrl?: string;
  contactEmail?: string;
}

const skipOnly: CatalogExtra[] = [{ name: "skip", isRequired: false }];

export function tagCatalogId(key: string): string {
  return `${TAG_CATALOG_PREFIX}${key}`;
}

function boardCatalogs(
  type: string,
  pinnedTags: readonly string[],
): ManifestCatalog[] {
  return [
    { type, id: RECENTLY_ADDED_ID, name: "Recently added", extra: skipOnly },
    { type, id: UNWATCHED_ID, name: "Unwatched", extra: skipOnly },
    ...pinnedTags.map((tag) => ({
      type,
      id: tagCatalogId(tag.trim().toLocaleLowerCase()),
      name: tag,
      extra: skipOnly,
    })),
  ];
}

export function manifestWithGenres<T extends Manifest>(
  base: T,
  genres: readonly string[],
): T {
  if (!genres.length) return base;
  return {
    ...base,
    catalogs: base.catalogs.map((catalog) => ({
      ...catalog,
      extra: catalog.extra.map((extra): CatalogExtra =>
        extra.name === "genre" ? { ...extra, options: [...genres] } : extra,
      ),
    })),
  };
}

export function manifestForLibrary<T extends Manifest>(
  base: T,
  genres: readonly string[],
  pinnedTags: readonly string[] = [],
  identity: ManifestIdentity = {},
): T & { logo?: string; contactEmail?: string } {
  const withGenres = manifestWithGenres(base, genres);
  // Fixtures and partial manifests may omit `types` or `catalogs`; fall back
  // to whatever the catalogs already cover so Board rows only join known types.
  const baseCatalogs = withGenres.catalogs ?? [];
  const types = base.types ?? [...new Set(baseCatalogs.map((c) => c.type))];
  const catalogs = types.flatMap((type) => [
    ...baseCatalogs.filter((catalog) => catalog.type === type),
    ...boardCatalogs(type, pinnedTags),
  ]);
  const contactEmail = identity.contactEmail?.trim();
  return {
    ...withGenres,
    catalogs,
    ...(identity.addonUrl
      ? { logo: `${identity.addonUrl}/assets/hoshistream-logo.png` }
      : {}),
    ...(contactEmail ? { contactEmail } : {}),
  };
}
