export function onboardingReport(value) {
  const state = value?.state;
  if (
    !state ||
    state.version !== 1 ||
    !["active", "dismissed", "complete"].includes(state.status) ||
    !["nuvio", "stremio"].includes(state.client) ||
    typeof state.clientConfirmed !== "boolean" ||
    typeof state.welcomePending !== "boolean" ||
    typeof value.hasMedia !== "boolean" ||
    typeof value.loopbackOnly !== "boolean" ||
    typeof value.addonUrl !== "string" ||
    ![null, "Nuvio", "Stremio"].includes(value.observedClient)
  )
    throw Error("Setup returned an unexpected response. Try again.");
  let url;
  try {
    url = new URL(value.addonUrl);
  } catch {
    throw Error("The add-on address could not be read. Try again.");
  }
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.hash
  )
    throw Error("The add-on address is not supported.");
  return value;
}

export function setupProgress(entries, report) {
  const hasMedia = entries.length > 0;
  const connected = report.state.clientConfirmed;
  return { hasMedia, connected, count: Number(hasMedia) + Number(connected) };
}
