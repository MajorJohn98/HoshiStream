import { MAX_CAPTURE_CANDIDATES } from "./constants.js";
import {
  cleanLabel,
  isMagnetUri,
  normalizeMagnetUri,
  parseMagnetTitle,
  stripTorrentExtension,
} from "./protocol.js";

function safeUrl(value, base) {
  try {
    return new URL(value, base);
  } catch {
    return null;
  }
}

function hostLabel(value) {
  return safeUrl(value)?.host ?? "";
}

function magnetKey(magnetUri) {
  try {
    const url = new URL(normalizeMagnetUri(magnetUri));
    const xt = url.searchParams.get("xt");
    return xt ? xt.toLowerCase() : url.toString().toLowerCase();
  } catch {
    return normalizeMagnetUri(magnetUri).toLowerCase();
  }
}

function looksLikeTorrentLink(link, pageUrl) {
  const url = safeUrl(link.href, pageUrl);
  if (!url || !/^https?:$/.test(url.protocol)) return false;
  const downloadName = cleanLabel(link.download, 255);
  if (downloadName.toLowerCase().endsWith(".torrent")) return true;
  const pathname = decodeURIComponent(url.pathname).toLowerCase();
  return pathname.endsWith(".torrent");
}

function torrentName(link, pageUrl) {
  const downloadName = cleanLabel(link.download, 255);
  if (downloadName.toLowerCase().endsWith(".torrent")) return downloadName;
  const url = safeUrl(link.href, pageUrl);
  const fileName = url
    ? decodeURIComponent(url.pathname.split("/").pop() ?? "")
    : "";
  return fileName.toLowerCase().endsWith(".torrent") ? fileName : "";
}

function firstNonEmpty(...values) {
  return values.find((value) => cleanLabel(value))
    ? cleanLabel(values.find((value) => cleanLabel(value)))
    : "";
}

export function normalizeCapturedLinks(rawCapture = {}) {
  const links = Array.isArray(rawCapture.links) ? rawCapture.links : [];
  const pageTitle = cleanLabel(rawCapture.pageTitle);
  const pageUrl = String(rawCapture.pageUrl ?? "");
  const seen = new Set();
  const candidates = [];

  for (const link of links) {
    const href = cleanLabel(link?.href, 16_384);
    if (!href) continue;

    if (isMagnetUri(href)) {
      const key = `magnet:${magnetKey(href)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const magnetUri = normalizeMagnetUri(href);
      const titleSuggestion = firstNonEmpty(
        parseMagnetTitle(magnetUri),
        link?.text,
        link?.title,
        link?.ariaLabel,
        pageTitle,
      );
      candidates.push({
        id: crypto.randomUUID(),
        kind: "magnet",
        magnetUri,
        titleSuggestion,
        label: firstNonEmpty(
          link?.text,
          parseMagnetTitle(magnetUri),
          "Magnet link",
        ),
        secondary: firstNonEmpty(link?.title, hostLabel(pageUrl)),
      });
      continue;
    }

    if (!looksLikeTorrentLink(link, pageUrl)) continue;
    const url = safeUrl(href, pageUrl);
    if (!url) continue;
    const key = `torrent:${url.toString()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const fileName = torrentName(link, pageUrl);
    candidates.push({
      id: crypto.randomUUID(),
      kind: "torrent-link-hint",
      href: url.toString(),
      fileName,
      titleSuggestion: firstNonEmpty(
        stripTorrentExtension(fileName),
        link?.text,
        link?.title,
        pageTitle,
      ),
      label: firstNonEmpty(
        link?.text,
        stripTorrentExtension(fileName),
        "Download .torrent in Chrome",
      ),
      secondary:
        "Protected downloads stay in Chrome. Choose the file here after it saves.",
    });
  }

  return candidates.slice(0, MAX_CAPTURE_CANDIDATES);
}

export function sourceFromCandidate(candidate) {
  if (candidate?.kind === "magnet") {
    return {
      kind: "magnet",
      magnetUri: candidate.magnetUri,
      titleSuggestion: cleanLabel(candidate.titleSuggestion),
      captureLabel: cleanLabel(candidate.label),
    };
  }
  if (candidate?.kind === "torrent-link-hint") {
    return {
      kind: "torrent-link-hint",
      href: candidate.href,
      fileName: cleanLabel(candidate.fileName, 255),
      titleSuggestion: cleanLabel(candidate.titleSuggestion),
      captureLabel: cleanLabel(candidate.label),
    };
  }
  return { kind: "none" };
}
