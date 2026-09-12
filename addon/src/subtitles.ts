import { basename, extname, posix } from "node:path";

// Sidecar subtitle handling (plan Phase 6). Everything here is a pure
// transform over file names and text so it can be tested without TorrServer
// or a filesystem: which files are subtitles, which video each belongs to,
// what language it carries, and how an SRT becomes WebVTT.

export const SUBTITLE_EXTENSIONS = new Set([".srt", ".vtt", ".ass", ".ssa"]);

export type SubtitleFormat = "srt" | "vtt" | "ass" | "ssa";

export function subtitleFormat(path: string): SubtitleFormat | undefined {
  const extension = extname(path).toLowerCase();
  return SUBTITLE_EXTENSIONS.has(extension)
    ? (extension.slice(1) as SubtitleFormat)
    : undefined;
}

export function isSubtitlePath(path: string): boolean {
  return subtitleFormat(path) !== undefined;
}

// What the player receives: SRT is converted, the rest is served as-is.
export function servedExtension(format: SubtitleFormat): "vtt" | "ass" | "ssa" {
  return format === "srt" ? "vtt" : format;
}

export function subtitleContentType(extension: "vtt" | "ass" | "ssa"): string {
  return extension === "vtt"
    ? "text/vtt; charset=utf-8"
    : "text/x-ssa; charset=utf-8";
}

// ISO 639-2/B codes keyed by the tokens release groups actually use: 639-1,
// 639-2 and English names. Stremio's language picker understands the
// three-letter form.
const LANGUAGES: Record<string, { code: string; name: string }> = {};
for (const [code, name, ...aliases] of [
  ["eng", "English", "en", "english"],
  ["spa", "Spanish", "es", "spanish", "espanol", "español", "castellano"],
  ["fre", "French", "fr", "fra", "french", "francais", "français"],
  ["ger", "German", "de", "deu", "german", "deutsch"],
  ["ita", "Italian", "it", "italian", "italiano"],
  ["por", "Portuguese", "pt", "portuguese", "portugues", "português"],
  ["rus", "Russian", "ru", "russian", "русский"],
  ["ukr", "Ukrainian", "uk", "ukrainian", "українська"],
  ["jpn", "Japanese", "ja", "japanese"],
  ["chi", "Chinese", "zh", "zho", "chinese", "cht", "chs"],
  ["kor", "Korean", "ko", "korean"],
  ["ara", "Arabic", "ar", "arabic"],
  ["tur", "Turkish", "tr", "turkish"],
  ["pol", "Polish", "pl", "polish"],
  ["dut", "Dutch", "nl", "nld", "dutch"],
  ["swe", "Swedish", "sv", "swedish"],
  ["nor", "Norwegian", "no", "nob", "norwegian"],
  ["dan", "Danish", "da", "danish"],
  ["fin", "Finnish", "fi", "finnish"],
  ["cze", "Czech", "cs", "ces", "czech"],
  ["hun", "Hungarian", "hu", "hungarian"],
  ["rum", "Romanian", "ro", "ron", "romanian"],
  ["gre", "Greek", "el", "ell", "greek"],
  ["heb", "Hebrew", "he", "hebrew"],
  ["hin", "Hindi", "hi", "hindi"],
  ["tha", "Thai", "th", "thai"],
  ["vie", "Vietnamese", "vi", "vietnamese"],
  ["ind", "Indonesian", "id", "indonesian"],
  ["bul", "Bulgarian", "bg", "bulgarian"],
  ["hrv", "Croatian", "hr", "croatian"],
  ["srp", "Serbian", "sr", "serbian"],
  ["slo", "Slovak", "sk", "slk", "slovak"],
  ["slv", "Slovenian", "sl", "slovenian"],
  ["per", "Persian", "fa", "fas", "persian", "farsi"],
  ["may", "Malay", "ms", "msa", "malay"],
  ["amh", "Amharic", "am", "amharic", "አማርኛ"],
] as const) {
  LANGUAGES[code] = { code, name };
  for (const alias of aliases) LANGUAGES[alias] = { code, name };
}

// Cyrillic-script languages whose legacy files are usually windows-1251.
const CYRILLIC = new Set(["rus", "ukr", "bul", "srp", "bel", "mkd"]);

const FLAGS: Record<string, "forced" | "sdh"> = {
  forced: "forced",
  sdh: "sdh",
  hi: "sdh",
  cc: "sdh",
};

export type SubtitleFlag = "forced" | "sdh";

export interface SubtitleCandidate {
  id: number;
  path: string;
  length: number;
  hash?: string;
}

export interface MatchedSubtitle<
  T extends SubtitleCandidate = SubtitleCandidate,
> {
  file: T;
  format: SubtitleFormat;
  /** ISO 639-2/B code, or "und" when the file name does not say. */
  lang: string;
  label: string;
  flags: SubtitleFlag[];
}

function stem(path: string): string {
  const name = basename(path.replaceAll("\\", "/"));
  return name.slice(0, name.length - extname(name).length);
}

function tokens(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[._\s-]+/)
    .filter(Boolean);
}

function classify(parts: string[]): {
  lang?: string;
  flags: SubtitleFlag[];
  unknown: string[];
} {
  let lang: string | undefined;
  const flags: SubtitleFlag[] = [];
  const unknown: string[] = [];
  for (const part of parts) {
    // "hi" is Hindi in a language slot but "hearing impaired" as a trailing
    // flag; treat it as a flag only once a language is already known.
    if (lang && FLAGS[part]) {
      if (!flags.includes(FLAGS[part])) flags.push(FLAGS[part]);
      continue;
    }
    const language = LANGUAGES[part];
    if (language && !lang) {
      lang = language.code;
      continue;
    }
    if (FLAGS[part]) {
      if (!flags.includes(FLAGS[part])) flags.push(FLAGS[part]);
      continue;
    }
    unknown.push(part);
  }
  return { lang, flags, unknown };
}

function describe(lang: string, flags: SubtitleFlag[]): string {
  const name = LANGUAGES[lang]?.name ?? "Unknown language";
  const notes = flags.map((flag) => (flag === "sdh" ? "SDH" : "forced"));
  return notes.length ? `${name} (${notes.join(", ")})` : name;
}

/**
 * Sidecars that belong to one video. A file matches when its stem equals the
 * video's stem, optionally followed by language/flag tokens
 * (`Movie.en.srt`, `Movie.eng.forced.srt`), regardless of directory (`Subs/`
 * folders). With `soleVideo` — a movie torrent or folder holding one feature
 * — every subtitle file belongs to it and the language comes from any
 * recognizable token (`Subs/2_English.srt`).
 */
export function matchSubtitles<T extends SubtitleCandidate>(
  video: { path: string },
  files: readonly T[],
  options: { soleVideo?: boolean } = {},
): MatchedSubtitle<T>[] {
  const videoStem = stem(video.path).toLowerCase();
  const matched: MatchedSubtitle<T>[] = [];
  for (const file of files) {
    const format = subtitleFormat(file.path);
    if (!format) continue;
    const fileStem = stem(file.path);
    const lower = fileStem.toLowerCase();
    let match: { lang?: string; flags: SubtitleFlag[] } | undefined;
    if (lower === videoStem) match = { flags: [] };
    else if (
      lower.startsWith(videoStem) &&
      /[._\s-]/.test(lower.charAt(videoStem.length))
    ) {
      const rest = classify(tokens(lower.slice(videoStem.length)));
      if (!rest.unknown.length) match = rest;
    }
    if (!match && options.soleVideo) {
      const all = classify(tokens(lower));
      match = { lang: all.lang, flags: all.flags };
    }
    if (!match) continue;
    const lang = match.lang ?? "und";
    matched.push({
      file,
      format,
      lang,
      label: describe(lang, match.flags),
      flags: match.flags,
    });
  }
  return matched.sort(
    (a, b) =>
      a.lang.localeCompare(b.lang) ||
      a.flags.length - b.flags.length ||
      posix.basename(a.file.path).localeCompare(posix.basename(b.file.path)),
  );
}

/** Best-effort language of a sidecar from its own file name, for decoding. */
export function subtitleLanguage(path: string): string | undefined {
  return classify(tokens(stem(path))).lang;
}

/**
 * Bytes → text. Honors a UTF-8/UTF-16 BOM, then tries strict UTF-8, then
 * falls back to the legacy code page the language makes likely. Never
 * throws: the worst case is mojibake, not a failed request.
 */
export function decodeSubtitleBytes(bytes: Uint8Array, lang?: string): string {
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe)
    return new TextDecoder("utf-16le").decode(bytes.subarray(2));
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff)
    return new TextDecoder("utf-16be").decode(bytes.subarray(2));
  try {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(
      bytes,
    );
  } catch {
    const legacy = lang && CYRILLIC.has(lang) ? "windows-1251" : "windows-1252";
    try {
      return new TextDecoder(legacy).decode(bytes);
    } catch {
      return new TextDecoder("latin1").decode(bytes);
    }
  }
}

const TIMESTAMP = String.raw`(?:(\d{1,2}):)?(\d{1,2}):(\d{1,2})(?:[,.](\d{1,3}))?`;
const TIMING = new RegExp(
  String.raw`^\s*${TIMESTAMP}\s*-->\s*${TIMESTAMP}(?:\s+(.*?))?\s*$`,
);

function vttTimestamp(
  hours: string | undefined,
  minutes: string,
  seconds: string,
  millis: string | undefined,
): string | undefined {
  const h = Number(hours ?? "0");
  const m = Number(minutes);
  const s = Number(seconds);
  if (m > 59 || s > 59) return undefined;
  const ms = (millis ?? "0").padEnd(3, "0");
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}.${ms}`;
}

function cueTime(start: string): number {
  const [h, m, rest] = start.split(":");
  return Number(h) * 3600 + Number(m) * 60 + Number(rest);
}

/**
 * SubRip → WebVTT as a pure string transform. Comma decimals become dots,
 * short or odd timestamps are normalized, ASS-style `{\an8}` overrides are
 * stripped, numeric cue counters are dropped, and any block without a valid
 * timing line is skipped rather than failing the whole file.
 */
export function srtToVtt(text: string): string {
  const source = text.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n");
  if (/^WEBVTT/.test(source))
    return source.endsWith("\n") ? source : `${source}\n`;
  const cues: string[] = [];
  for (const block of source.split(/\n{2,}/)) {
    const lines = block.split("\n");
    while (lines.length && lines[0]!.trim() === "") lines.shift();
    while (lines.length && lines.at(-1)!.trim() === "") lines.pop();
    if (!lines.length) continue;
    if (/^\d+\s*$/.test(lines[0]!)) lines.shift();
    const timing = lines.length ? TIMING.exec(lines[0]!) : null;
    if (!timing) continue;
    const start = vttTimestamp(timing[1], timing[2]!, timing[3]!, timing[4]);
    const end = vttTimestamp(timing[5], timing[6]!, timing[7]!, timing[8]);
    if (!start || !end || cueTime(end) < cueTime(start)) continue;
    const body = lines
      .slice(1)
      .map((line) => line.replace(/\{\\[^}]*\}/g, "").trimEnd())
      .join("\n")
      .trim();
    if (!body) continue;
    cues.push(`${start} --> ${end}\n${body}`);
  }
  return `WEBVTT\n\n${cues.join("\n\n")}${cues.length ? "\n" : ""}`;
}
