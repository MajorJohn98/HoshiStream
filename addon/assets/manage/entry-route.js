export function entryRouteId(hash = location.hash) {
  const match = /^#\/entry\/([^/]+)$/.exec(hash);
  return match ? decodeURIComponent(match[1]) : null;
}

export function closeDetailRoute(hash = location.hash) {
  return entryRouteId(hash) ? "#/library" : hash;
}
