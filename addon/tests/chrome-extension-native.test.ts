import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  assertTrustedUiSender,
  sendNativeRequest,
} from "../assets/chrome-extension/lib/native.js";

function createPort() {
  const messageListeners = new Set<(value: unknown) => void>();
  const disconnectListeners = new Set<() => void>();
  return {
    onMessage: {
      addListener(listener: (value: unknown) => void) {
        messageListeners.add(listener);
      },
      removeListener(listener: (value: unknown) => void) {
        messageListeners.delete(listener);
      },
    },
    onDisconnect: {
      addListener(listener: () => void) {
        disconnectListeners.add(listener);
      },
      removeListener(listener: () => void) {
        disconnectListeners.delete(listener);
      },
    },
    postMessage: vi.fn<(value: unknown) => void>(),
    disconnect: vi.fn(),
    emitMessage(value: unknown) {
      for (const listener of [...messageListeners]) listener(value);
    },
    emitDisconnect() {
      for (const listener of [...disconnectListeners]) listener();
    },
  };
}

describe("chrome companion native transport", () => {
  it("accepts only extension-owned UI senders", () => {
    expect(
      assertTrustedUiSender(
        {
          url: "chrome-extension://haijooeeommbnonlnkmcihmcgjmbfjgo/panel.html",
        },
        "chrome-extension://haijooeeommbnonlnkmcihmcgjmbfjgo/",
      ),
    ).toBe(true);
    expect(
      assertTrustedUiSender(
        { url: "https://example.com/bridge" },
        "chrome-extension://haijooeeommbnonlnkmcihmcgjmbfjgo/",
      ),
    ).toBe(false);
  });

  it("resolves only a correlated native response envelope", async () => {
    const port = createPort();
    const runtime = {
      lastError: undefined as { message: string } | undefined,
      connectNative: vi.fn(() => {
        port.postMessage.mockImplementation((request: { id: string }) => {
          queueMicrotask(() => {
            port.emitMessage({
              version: 1,
              id: request.id,
              ok: true,
              data: { connected: true },
            });
          });
        });
        return port;
      }),
    };
    await expect(
      sendNativeRequest(runtime as never, "status", {}),
    ).resolves.toEqual({
      connected: true,
    });
  });

  it("turns native disconnects into actionable retry errors", async () => {
    const port = createPort();
    const runtime = {
      lastError: undefined as { message: string } | undefined,
      connectNative: vi.fn(() => {
        port.postMessage.mockImplementation(() => {
          runtime.lastError = {
            message: "Specified native messaging host not found.",
          };
          queueMicrotask(() => port.emitDisconnect());
        });
        return port;
      }),
    };
    await expect(
      sendNativeRequest(runtime as never, "status", {}),
    ).rejects.toMatchObject({
      code: "native_host_unavailable",
      retryable: true,
      uncertain: false,
    });
  });

  it("rejects mismatched response ids instead of accepting stale data", async () => {
    const port = createPort();
    const runtime = {
      lastError: undefined as { message: string } | undefined,
      connectNative: vi.fn(() => {
        port.postMessage.mockImplementation(() => {
          queueMicrotask(() => {
            port.emitMessage({
              version: 1,
              id: randomUUID(),
              ok: true,
              data: { connected: true },
            });
          });
        });
        return port;
      }),
    };
    await expect(
      sendNativeRequest(runtime as never, "status", {}),
    ).rejects.toMatchObject({
      code: "invalid_native_response",
      retryable: true,
      uncertain: true,
    });
  });

  it.each(["app_unavailable", "invalid_app_response"])(
    "preserves uncertain %s confirmations for an idempotent retry",
    async (code) => {
      const port = createPort();
      const runtime = {
        lastError: undefined,
        connectNative: vi.fn(() => {
          port.postMessage.mockImplementation((request: { id: string }) => {
            queueMicrotask(() =>
              port.emitMessage({
                version: 1,
                id: request.id,
                ok: false,
                error: {
                  code,
                  message: "Retry the original confirmation.",
                  retryable: true,
                  uncertain: true,
                },
              }),
            );
          });
          return port;
        }),
      };
      await expect(
        sendNativeRequest(runtime as never, "createEntry", {}),
      ).rejects.toMatchObject({ code, retryable: true, uncertain: true });
    },
  );
});
