// Pure helpers behind the Metadata tab: turn form text into the validated
// shapes the library accepts (and back), without touching the DOM.

const YOUTUBE_ID = /^[A-Za-z0-9_-]{11}$/;

export const POSTER_SHAPES = [
  ["poster", "Poster (2:3)"],
  ["landscape", "Landscape (16:9)"],
  ["square", "Square"],
];

// "Name, Other Name" or one per line → trimmed unique list; empty → null so
// the PATCH clears the field.
export function parseNameList(text) {
  const names = [];
  for (const part of String(text ?? "").split(/[\n,]/)) {
    const name = part.trim();
    if (name && !names.includes(name)) names.push(name);
  }
  return names.length ? names : null;
}

export function joinNameList(names) {
  return (names ?? []).join(", ");
}

// Accepts a bare YouTube id, watch/shorts/embed URLs, or youtu.be links.
// Returns the id or undefined when nothing usable is found.
export function youtubeId(text) {
  const value = String(text ?? "").trim();
  if (!value) return undefined;
  if (YOUTUBE_ID.test(value)) return value;
  let url;
  try {
    url = new URL(value);
  } catch {
    return undefined;
  }
  const host = url.hostname.replace(/^www\.|^m\./, "");
  let candidate;
  if (host === "youtu.be") candidate = url.pathname.slice(1).split("/")[0];
  else if (host === "youtube.com" || host === "youtube-nocookie.com") {
    candidate =
      url.searchParams.get("v") ??
      /^\/(?:embed|shorts|v|live)\/([^/?]+)/.exec(url.pathname)?.[1];
  }
  return candidate && YOUTUBE_ID.test(candidate) ? candidate : undefined;
}

// One trailer per line; throws with a readable message on the first bad one.
export function parseTrailers(text) {
  const trailers = [];
  for (const line of String(text ?? "").split(/\n/)) {
    const value = line.trim();
    if (!value) continue;
    const source = youtubeId(value);
    if (!source)
      throw Error(
        `"${value}" is not a YouTube link or id. Paste the watch URL or the 11-character id.`,
      );
    if (!trailers.some((trailer) => trailer.source === source))
      trailers.push({ source, type: "Trailer" });
  }
  return trailers.length ? trailers : null;
}

export function joinTrailers(trailers) {
  return (trailers ?? [])
    .map((trailer) => "https://www.youtube.com/watch?v=" + trailer.source)
    .join("\n");
}

function text(value) {
  const trimmed = String(value ?? "").trim();
  return trimmed ? trimmed : null;
}

// Form fields (a plain object from FormData) → PATCH body. Every field is
// present so blanks clear the stored value.
export function metadataPatch(fields) {
  return {
    releaseInfo: text(fields.releaseInfo),
    runtime: text(fields.runtime),
    imdbRating: text(fields.imdbRating),
    cast: parseNameList(fields.cast),
    director: parseNameList(fields.director),
    writer: parseNameList(fields.writer),
    country: text(fields.country),
    language: text(fields.language),
    logo: text(fields.logo),
    awards: text(fields.awards),
    trailers: parseTrailers(fields.trailers),
    posterShape:
      fields.posterShape && fields.posterShape !== "poster"
        ? fields.posterShape
        : null,
  };
}
