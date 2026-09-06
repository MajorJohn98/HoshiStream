import { NATIVE_HOST, PROTOCOL_VERSION } from "./constants.js";
import { createNativeRequest, createProtocolError } from "./protocol.js";

export function createNativeError(code, message, extra = {}) {
  return Object.assign(new Error(message), { code, ...extra });
}

export function assertTrustedUiSender(sender, extensionOrigin) {
  return Boolean(
    sender?.url &&
    typeof sender.url === "string" &&
    sender.url.startsWith(extensionOrigin),
  );
}

function disconnectError(message) {
  const text = String(message ?? "").trim();
  if (
    /host not found|not registered|forbidden|disallowed|access to the specified native messaging host/i.test(
      text,
    )
  ) {
    return createNativeError(
      "native_host_unavailable",
      "Chrome could not reach the HoshiStream helper. Open HoshiStream, then retry. If you are developing locally, reload the unpacked extension after the app registers its helper.",
      { retryable: true, installGuidance: true, uncertain: false },
    );
  }
  return createNativeError(
    "native_host_disconnected",
    "The HoshiStream helper disconnected before confirming the request. Retry the same action.",
    { retryable: true, uncertain: true },
  );
}

export function statusFromError(error) {
  return {
    phase: "ready",
    connected: false,
    appRunning: false,
    engineReady: false,
    canStartApp: false,
    message:
      error?.message || "Open or update HoshiStream on this Mac, then retry.",
    code: error?.code || "native_unavailable",
  };
}

export function readNativeResponse(request, response) {
  if (!response || typeof response !== "object") {
    throw createNativeError(
      "invalid_native_response",
      "HoshiStream returned an unreadable response. Retry the same request.",
      { retryable: true, uncertain: true },
    );
  }
  if (response.version !== PROTOCOL_VERSION || response.id !== request.id) {
    throw createNativeError(
      "invalid_native_response",
      "HoshiStream returned a mismatched response. Retry the same request.",
      { retryable: true, uncertain: true },
    );
  }
  if (response.ok === true) return response.data;
  const code = response.error?.code;
  const message = response.error?.message;
  if (typeof code !== "string" || typeof message !== "string") {
    throw createNativeError(
      "invalid_native_response",
      "HoshiStream returned an unreadable response. Retry the same request.",
      { retryable: true, uncertain: true },
    );
  }
  const uncertain =
    response.error.uncertain === true ||
    [
      "app_unavailable",
      "invalid_app_response",
      "invalid_native_response",
    ].includes(code);
  throw createNativeError(code, message, {
    retryable: response.error.retryable === true || uncertain,
    uncertain,
  });
}

export async function sendNativeRequest(
  runtime,
  command,
  payload,
  { hostName = NATIVE_HOST } = {},
) {
  const request = createNativeRequest(command, payload);
  let port;
  try {
    port = runtime.connectNative(hostName);
  } catch {
    throw disconnectError("host not found");
  }
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(
      () =>
        finish(
          reject,
          createNativeError(
            "native_request_timeout",
            "HoshiStream did not confirm the request in time. Retry the same action.",
            { retryable: true, uncertain: true },
          ),
        ),
      80_000,
    );
    const cleanup = () => {
      clearTimeout(timer);
      port.onMessage.removeListener(onMessage);
      port.onDisconnect.removeListener(onDisconnect);
      try {
        port.disconnect();
      } catch {
        /* Port may already be closed. */
      }
    };
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      cleanup();
      callback(value);
    };
    const onMessage = (response) => {
      try {
        finish(resolve, readNativeResponse(request, response));
      } catch (error) {
        finish(reject, error);
      }
    };
    const onDisconnect = () => {
      finish(reject, disconnectError(runtime.lastError?.message));
    };
    port.onMessage.addListener(onMessage);
    port.onDisconnect.addListener(onDisconnect);
    try {
      port.postMessage(request);
    } catch (error) {
      finish(
        reject,
        createProtocolError(
          "native_request_failed",
          error?.message || "The native request could not be started.",
          { retryable: true, uncertain: false },
        ),
      );
    }
  });
}
