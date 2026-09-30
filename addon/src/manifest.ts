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
    // Continue Watching (continue-watching) and the Board rows are not
    // advertised: Nuvio shows its own unified Continue Watching row. Their
    // catalog handlers stay so clients holding an older manifest still get a
    // response.
  ],
};

type Manifest = typeof manifest;

interface CatalogExtra {
  name: string;
  isRequired: boolean;
  options?: string[];
}

export const RECENTLY_ADDED_ID = "recently-added";
export const UNWATCHED_ID = "unwatched";
export const TAG_CATALOG_PREFIX = "tag-";

// Board row ids (Phase 15). Not advertised; see the note on the base catalogs.
export interface ManifestIdentity {
  /** Absolute origin of this add-on as the client reached it. */
  addonUrl?: string;
  contactEmail?: string;
}

export function tagCatalogId(key: string): string {
  return `${TAG_CATALOG_PREFIX}${key}`;
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
  identity: ManifestIdentity = {},
): T & { logo?: string; contactEmail?: string } {
  const withGenres = manifestWithGenres(base, genres);
  const contactEmail = identity.contactEmail?.trim();
  return {
    ...withGenres,
    ...(identity.addonUrl
      ? { logo: `${identity.addonUrl}/assets/hoshistream-logo.png` }
      : {}),
    ...(contactEmail ? { contactEmail } : {}),
  };
}
