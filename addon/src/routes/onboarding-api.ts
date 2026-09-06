import { ZodError } from "zod";
import { listClients } from "../clients.ts";
import { OnboardingError, onboardingActionSchema } from "../onboarding.ts";
import { body, noStoreReply, type RouteHandler } from "./context.ts";

export const handleOnboarding: RouteHandler = async (
  { onboarding, library, publicUrls, accessToken },
  { request, response, url, method },
) => {
  if (url.pathname !== "/api/onboarding" || !["GET", "POST"].includes(method))
    return false;
  if (!onboarding)
    return noStoreReply(response, 409, {
      error:
        "Setup is unavailable on this host. You can still use the Library.",
    });
  try {
    const hasMedia = (await library.list()).length > 0;
    const state =
      method === "POST"
        ? await onboarding.update(
            onboardingActionSchema.parse(await body(request)),
            hasMedia,
          )
        : await onboarding.read();
    const base = new URL(publicUrls.addonUrl);
    const addonUrl = new URL(
      `addon/${encodeURIComponent(accessToken)}/manifest.json`,
      base.href.replace(/\/?$/, "/"),
    ).href;
    const recentClient = listClients().find(
      (client) =>
        ["Nuvio", "Stremio"].includes(client.device) &&
        ["catalog", "meta", "stream"].includes(client.lastResource),
    );
    return noStoreReply(response, 200, {
      state,
      hasMedia,
      addonUrl,
      loopbackOnly: ["localhost", "127.0.0.1", "[::1]"].includes(base.hostname),
      observedClient: recentClient?.device ?? null,
    });
  } catch (error) {
    const invalid = error instanceof ZodError || error instanceof SyntaxError;
    return noStoreReply(
      response,
      invalid ? 400 : error instanceof OnboardingError ? 409 : 503,
      {
        error: invalid
          ? "Invalid setup request."
          : error instanceof OnboardingError
            ? error.message
            : "Setup could not be loaded or saved. Try again; your library is unchanged.",
      },
    );
  }
};
