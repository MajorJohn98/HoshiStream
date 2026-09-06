import {
  MAX_TORRENT_BASE64_LENGTH,
  MAX_TORRENT_BYTES,
  PROTOCOL_VERSION,
} from "./constants.js";

const BASE64_RE = /^[A-Za-z0-9+/]+={0,2}$/;
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function createProtocolError(code, message, extra = {}) {
  return Object.assign(new Error(message), { code, ...extra });
}

export function cleanLabel(value, maxLength = 200) {
  return String(value ?? "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxLength);
}

export function isUuid(value) {
  return UUID_RE.test(String(value ?? ""));
}

export function createNativeRequest(
  command,
  payload,
  id = crypto.randomUUID(),
) {
  return {
    version: PROTOCOL_VERSION,
    id,
    command,
    payload,
  };
}

export function normalizeMagnetUri(value) {
  return String(value ?? "").trim();
}

export function isMagnetUri(value) {
  const magnetUri = normalizeMagnetUri(value);
  if (!magnetUri.startsWith("magnet:?")) return false;
  try {
    const url = new URL(magnetUri);
    return url.protocol === "magnet:" && Boolean(url.searchParams.get("xt"));
  } catch {
    return false;
  }
}

export function parseMagnetTitle(value) {
  if (!isMagnetUri(value)) return "";
  try {
    return cleanLabel(
      new URL(normalizeMagnetUri(value)).searchParams.get("dn"),
    );
  } catch {
    return "";
  }
}

export function stripTorrentExtension(fileName) {
  return cleanLabel(String(fileName ?? "").replace(/\.torrent$/i, ""));
}

export function assertTorrentFileName(fileName) {
  const value = cleanLabel(fileName, 255);
  if (
    !value ||
    /[\\/\0]/.test(value) ||
    !value.toLowerCase().endsWith(".torrent")
  ) {
    throw createProtocolError(
      "invalid_torrent",
      "Choose a valid .torrent file no larger than 1 MB.",
    );
  }
  return value;
}

export function encodeBytesBase64(bytes) {
  let binary = "";
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    const slice = bytes.subarray(offset, offset + chunkSize);
    binary += String.fromCharCode(...slice);
  }
  return btoa(binary);
}

export function decodeTorrentBytesBase64(encoded) {
  const value = String(encoded ?? "").trim();
  if (
    !value ||
    value.length < 4 ||
    value.length > MAX_TORRENT_BASE64_LENGTH ||
    value.length % 4 !== 0 ||
    !BASE64_RE.test(value)
  ) {
    throw createProtocolError(
      "invalid_torrent",
      "Choose a valid .torrent file no larger than 1 MB.",
    );
  }
  try {
    const binary = atob(value);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index++) {
      bytes[index] = binary.charCodeAt(index);
    }
    if (
      !bytes.length ||
      bytes.length > MAX_TORRENT_BYTES ||
      encodeBytesBase64(bytes) !== value
    ) {
      throw new Error("invalid bytes");
    }
    return bytes;
  } catch {
    throw createProtocolError(
      "invalid_torrent",
      "Choose a valid .torrent file no larger than 1 MB.",
    );
  }
}
