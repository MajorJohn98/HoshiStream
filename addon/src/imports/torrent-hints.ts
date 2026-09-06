const DECODER = new TextDecoder("utf-8", { fatal: true });

function safeLabel(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) return undefined;
  return trimmed.slice(0, 200);
}

export function magnetSuggestedName(magnet: string): string | undefined {
  try {
    return safeLabel(new URL(magnet).searchParams.get("dn") ?? undefined);
  } catch {
    return undefined;
  }
}

export function torrentSuggestedName(name: Uint8Array | undefined) {
  if (!name) return undefined;
  try {
    return safeLabel(DECODER.decode(name));
  } catch {
    return undefined;
  }
}
