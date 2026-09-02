import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PointerClient } from "../src/pointer.js";

const TOKEN = "a-sufficiently-long-access-token";
const SECRET = "a-sufficiently-long-push-secret";

let stateDir: string;

beforeEach(async () => {
  stateDir = await mkdtemp(join(tmpdir(), "hoshi-pointer-"));
});

afterEach(async () => {
  await rm(stateDir, { recursive: true, force: true });
});

function client(overrides: {
  fetchImpl?: typeof fetch;
  lanIp?: () => string | undefined;
  statePath?: string;
}) {
  return new PointerClient({
    pointerUrl: "https://pointer.example/",
    pushSecret: SECRET,
    token: TOKEN,
    port: 7001,
    statePath: overrides.statePath ?? join(stateDir, "pointer-state.json"),
    fetchImpl: overrides.fetchImpl,
    lanIp: overrides.lanIp ?? (() => "192.168.1.42"),
  });
}

describe("PointerClient", () => {
  it("builds the permanent manifest URL without a trailing slash", () => {
    expect(client({}).manifestUrl).toBe(
      `https://pointer.example/addon/${encodeURIComponent(TOKEN)}/manifest.json`,
    );
  });

  it("reports stale before any push and fresh after one", async () => {
    const fetchImpl = vi.fn(
      async () => new Response(JSON.stringify({ ok: true }), { status: 200 }),
    ) as unknown as typeof fetch;
    const pointer = client({ fetchImpl });
    expect((await pointer.status()).stale).toBe(true);

    const pushed = await pointer.push({ id: "test-addon" });
    expect(pushed.stale).toBe(false);
    expect(pushed.lastPushedBaseUrl).toBe("http://192.168.1.42:7001");
  });

  it("sends the push secret as a bearer header and the LAN base URL", async () => {
    const fetchImpl = vi.fn(
      async () => new Response(JSON.stringify({ ok: true }), { status: 200 }),
    );
    await client({
      fetchImpl: fetchImpl as unknown as typeof fetch,
    }).push({ id: "test-addon" });
    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://pointer.example/api/pointer");
    expect((init.headers as Record<string, string>).authorization).toBe(
      `Bearer ${SECRET}`,
    );
    expect(JSON.parse(init.body as string)).toEqual({
      baseUrl: "http://192.168.1.42:7001",
      token: TOKEN,
      manifest: { id: "test-addon" },
    });
  });

  it("persists the pushed base URL for staleness across restarts", async () => {
    const statePath = join(stateDir, "pointer-state.json");
    const fetchImpl = vi.fn(
      async () => new Response(JSON.stringify({ ok: true }), { status: 200 }),
    ) as unknown as typeof fetch;
    await client({ fetchImpl, statePath }).push({ id: "test-addon" });

    const restarted = client({ statePath, lanIp: () => "192.168.1.42" });
    expect((await restarted.status()).stale).toBe(false);
    const moved = client({ statePath, lanIp: () => "10.0.0.9" });
    expect((await moved.status()).stale).toBe(true);
    expect(JSON.parse(await readFile(statePath, "utf8")).baseUrl).toBe(
      "http://192.168.1.42:7001",
    );
  });

  it("does not record a push the server rejected", async () => {
    const statePath = join(stateDir, "pointer-state.json");
    const fetchImpl = vi.fn(
      async () =>
        new Response(JSON.stringify({ error: "Unauthorized" }), {
          status: 401,
        }),
    ) as unknown as typeof fetch;
    const pointer = client({ fetchImpl, statePath });
    await expect(pointer.push({ id: "test-addon" })).rejects.toThrow("401");
    expect((await pointer.status()).stale).toBe(true);
  });

  it("refuses to push without a LAN address", async () => {
    const pointer = client({ lanIp: () => undefined });
    await expect(pointer.push({ id: "test-addon" })).rejects.toThrow(
      "No LAN IPv4 address",
    );
  });

  it("ignores a corrupt state file", async () => {
    const statePath = join(stateDir, "pointer-state.json");
    await writeFile(statePath, "not json");
    expect((await client({ statePath }).status()).stale).toBe(true);
  });

  it("removes the remote record and forgets local push state", async () => {
    const statePath = join(stateDir, "pointer-state.json");
    const fetchImpl = vi.fn(
      async () => new Response(JSON.stringify({ ok: true }), { status: 200 }),
    );
    const pointer = client({
      fetchImpl: fetchImpl as unknown as typeof fetch,
      statePath,
    });
    await pointer.push({ id: "test-addon" });
    await pointer.remove();

    const [url, init] = fetchImpl.mock.calls[1] as [string, RequestInit];
    expect(url).toBe("https://pointer.example/api/pointer");
    expect(init.method).toBe("DELETE");
    expect(JSON.parse(init.body as string)).toEqual({ token: TOKEN });
    expect((await pointer.status()).stale).toBe(true);
    await expect(readFile(statePath, "utf8")).rejects.toThrow();
  });

  it("reports remote pointer health without leaking credentials", async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            ok: true,
            baseUrl: "http://192.168.1.42:7001",
            createdAt: "2026-09-01T10:00:00.000Z",
            updatedAt: "2026-09-02T10:00:00.000Z",
            expiresAt: "2026-12-01T10:00:00.000Z",
          }),
          { status: 200 },
        ),
    );
    const status = await client({
      fetchImpl: fetchImpl as unknown as typeof fetch,
    }).remoteStatus();
    expect(status).toEqual({
      reachable: true,
      registered: true,
      baseUrl: "http://192.168.1.42:7001",
      updatedAt: "2026-09-02T10:00:00.000Z",
      expiresAt: "2026-12-01T10:00:00.000Z",
    });
    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://pointer.example/api/pointer/status");
    const headers = init.headers as Record<string, string>;
    expect(headers["x-addon-token"]).toBe(TOKEN);
  });

  it("distinguishes an unregistered pointer from an unreachable server", async () => {
    const notFound = vi.fn(
      async () =>
        new Response(JSON.stringify({ error: "Not found" }), { status: 404 }),
    ) as unknown as typeof fetch;
    expect(await client({ fetchImpl: notFound }).remoteStatus()).toEqual({
      reachable: true,
      registered: false,
    });

    const offline = vi.fn(async () => {
      throw new Error("network down");
    }) as unknown as typeof fetch;
    expect(await client({ fetchImpl: offline }).remoteStatus()).toEqual({
      reachable: false,
      registered: false,
    });
  });
});
