const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const MAGNET_LINK_ROUTE = "#/add/magnet/";

export function magnetLinkRouteId(hash = location.hash) {
  if (!hash.startsWith(MAGNET_LINK_ROUTE)) return null;
  const id = hash.slice(MAGNET_LINK_ROUTE.length);
  if (!ID.test(id)) throw Error("This magnet review link is invalid.");
  return id;
}

export function magnetLinkPrefill(value, id, now = Date.now()) {
  if (
    !value ||
    value.id !== id ||
    typeof value.magnetUri !== "string" ||
    !value.magnetUri.startsWith("magnet:?") ||
    value.magnetUri.length > 16_384 ||
    typeof value.expiresAt !== "string" ||
    !Number.isFinite(Date.parse(value.expiresAt)) ||
    (value.suggestedName !== undefined &&
      (typeof value.suggestedName !== "string" ||
        value.suggestedName.length > 200))
  )
    throw Error(
      "The magnet link could not be read. Click the original link again.",
    );
  if (Date.parse(value.expiresAt) <= now)
    throw Error("This magnet link expired. Click the original link again.");
  return { magnetUri: value.magnetUri, name: value.suggestedName ?? "" };
}

export function clearMagnetLinkRoute() {
  if (location.hash.startsWith(MAGNET_LINK_ROUTE))
    history.replaceState(null, "", "#/library");
}
