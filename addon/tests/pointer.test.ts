import { createHash, randomUUID } from "node:crypto";
import {
  mkdir,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  PointerClient,
  PointerError,
  pointerSetupSchema,
  pointerUrlSchema,
  type PointerClientOptions,
} from "../src/pointer.ts";

const TOKEN = "a-sufficiently-long-access-token";
const SECRET = "a-sufficiently-long-push-secret";
const ORIGIN = "https://pointer.example";
const BASE_URL = "http://192.168.1.42:7001";
const NOW = "2026-09-07T10:00:00.000Z";
const EXPIRES = "2026-12-06T10:00:00.000Z";
const MANIFEST = { id: "test-addon" };
let stateDir: string;
const digest = (value: string) =>
  createHash("sha256").update(value).digest("hex");
const successBody = () => ({
  ok: true,
  updatedAt: NOW,
  expiresAt: EXPIRES,
});
const remoteBody = () => ({
  ...successBody(),
  baseUrl: BASE_URL,
  createdAt: NOW,
});
const upstream = (body: unknown = successBody(), status = 200) =>
  vi
    .fn<typeof fetch>()
    .mockImplementation(async () => Response.json(body, { status }));

beforeEach(async () => {
  stateDir = join(process.cwd(), `.pointer-test-${randomUUID()}`);
  await mkdir(stateDir, { mode: 0o700 });
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(NOW));
});

afterEach(async () => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  await rm(stateDir, { recursive: true, force: true });
});

function client(overrides: Partial<PointerClientOptions> = {}) {
  return new PointerClient({
    pointerUrl: `${ORIGIN}/`,
    pushSecret: SECRET,
    token: TOKEN,
    port: 7001,
    statePath: join(stateDir, "pointer-state.json"),
    lanIp: () => "192.168.1.42",
    ...overrides,
  });
}

describe("PointerClient setup", () => {
  it.each([404, 503])(
    "allows correcting an endpoint after a read-only check returns %i",
    async (status) => {
      const fetchImpl = upstream({ error: "Fixture failure" }, status);
      await client({ fetchImpl }).remoteStatus();
      const restarted = client({ fetchImpl });
      expect(
        await restarted.configure({
          enabled: true,
          pointerUrl: "https://corrected.example",
        }),
      ).toMatchObject({
        pointerUrl: "https://corrected.example",
        state: "unregistered",
        usable: false,
      });
      expect(fetchImpl).toHaveBeenCalledOnce();
    },
  );

  it("does not discard a possibly created claim after an unconfirmed push", async () => {
    const fetchImpl = upstream({ error: "Fixture failure" }, 503);
    await expect(client({ fetchImpl }).push(MANIFEST)).rejects.toThrow();
    await expect(
      client().configure({
        enabled: true,
        pointerUrl: "https://corrected.example",
      }),
    ).rejects.toMatchObject({ code: "endpoint-change-requires-removal" });
  });

  it("suggests the approved operator without opting in or making requests", async () => {
    const fetchImpl = upstream();
    const pointer = client({ pointerUrl: undefined, fetchImpl });
    expect(await pointer.status()).toEqual({
      configured: false,
      enabled: false,
      pointerUrl: "",
      suggestedUrl: "https://hoshistream-pointer.vercel.app",
      suggestedOperator: "Major John's projects",
      manifestUrl: undefined,
      currentBaseUrl: BASE_URL,
      lastPushedBaseUrl: undefined,
      lastPushedAt: undefined,
      expiresAt: undefined,
      stale: true,
      state: "unconfigured",
      message:
        "Choose a pointer service and explicitly enable it, or keep using your direct LAN URL.",
      usable: false,
    });
    expect(await pointer.remoteStatus()).toMatchObject({
      reachable: false,
      registered: false,
      state: "unconfigured",
      usable: false,
    });
    await expect(pointer.push(MANIFEST)).rejects.toMatchObject({
      state: "unconfigured",
      statusCode: 409,
    });
    await expect(pointer.remove()).rejects.toBeInstanceOf(PointerError);
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(await readdir(stateDir)).toEqual([]);
  });

  it("inherits an explicit environment endpoint without an automatic push", async () => {
    const fetchImpl = upstream();
    const pointer = client({ fetchImpl });
    expect(pointer.manifestUrl).toBe(
      `${ORIGIN}/addon/${encodeURIComponent(TOKEN)}/manifest.json`,
    );
    expect(await pointer.status()).toMatchObject({
      configured: true,
      enabled: true,
      pointerUrl: ORIGIN,
      state: "unregistered",
      usable: false,
      stale: true,
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("persists only private endpoint settings, overriding changed environment defaults", async () => {
    const fetchImpl = upstream();
    const pointer = client({ pointerUrl: undefined, fetchImpl });
    expect(
      await pointer.configure({
        enabled: true,
        pointerUrl: "https://custom.example/",
      }),
    ).toMatchObject({
      configured: true,
      pointerUrl: "https://custom.example",
      usable: false,
    });
    const path = join(stateDir, "pointer-settings.json");
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual({
      enabled: true,
      pointerUrl: "https://custom.example",
    });
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    const restarted = client({
      pointerUrl: "https://changed-env.example",
      fetchImpl,
    });
    expect(await restarted.status()).toMatchObject({
      enabled: true,
      pointerUrl: "https://custom.example",
      state: "unregistered",
    });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(await readdir(stateDir)).toEqual(["pointer-settings.json"]);
  });

  it("respects an explicit settings path and disabled setup across restarts", async () => {
    const settingsPath = join(stateDir, "private", "setup.json");
    const fetchImpl = upstream();
    const pointer = client({ settingsPath, fetchImpl });
    await pointer.configure({ enabled: false });
    expect(await pointer.status()).toMatchObject({
      enabled: false,
      pointerUrl: ORIGIN,
      state: "disabled",
      configured: false,
    });
    const restarted = client({ settingsPath, fetchImpl });
    expect(await restarted.status()).toMatchObject({
      state: "disabled",
      configured: false,
    });
    expect(await restarted.remoteStatus()).toMatchObject({
      reachable: false,
      registered: false,
      state: "disabled",
    });
    await expect(restarted.push(MANIFEST)).rejects.toMatchObject({
      state: "disabled",
    });
    await expect(restarted.remove()).rejects.toMatchObject({
      state: "disabled",
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("supports deliberately disabled blank setup without enabling the suggestion", async () => {
    const pointer = client({ pointerUrl: undefined });
    expect(
      await pointer.configure({ enabled: false, pointerUrl: "" }),
    ).toMatchObject({
      pointerUrl: "",
      enabled: false,
      state: "disabled",
      manifestUrl: undefined,
    });
    expect(await client().status()).toMatchObject({
      state: "disabled",
      pointerUrl: "",
      configured: false,
    });
  });

  it.each([undefined, "", "short", "invalid\ncredential-is-long-enough"])(
    "saves endpoints but requires recovery for credential %j",
    async (pushSecret) => {
      const fetchImpl = upstream();
      const pointer = client({
        pointerUrl: undefined,
        pushSecret,
        fetchImpl,
      });
      expect(
        await pointer.configure({
          enabled: true,
          pointerUrl: ORIGIN,
        }),
      ).toMatchObject({
        enabled: true,
        configured: false,
        state: "recovery-required",
        usable: false,
      });
      await expect(pointer.push(MANIFEST)).rejects.toMatchObject({
        state: "recovery-required",
      });
      expect(await pointer.remoteStatus()).toMatchObject({
        state: "recovery-required",
        registered: false,
      });
      expect(fetchImpl).not.toHaveBeenCalled();
      expect(
        JSON.parse(
          await readFile(join(stateDir, "pointer-settings.json"), "utf8"),
        ),
      ).toEqual({ enabled: true, pointerUrl: ORIGIN });
    },
  );

  it.each([
    "http://example.com",
    "http://192.168.1.1",
    "ftp://example.com",
    "https://user:password@example.com",
    "https://@example.com",
    "https://example.com/path",
    "https://example.com/.",
    "https://example.com//",
    "https://example.com?",
    "https://example.com?secret=value",
    "https://example.com#",
    "https://example.com#fragment",
    "https://example.com\\",
    "https://example.com\n",
    "https://example.com\t",
    "https://example.com\u0000",
    " https://example.com",
    "https://example.com ",
    "https://exa%6dple.com",
    "//example.com",
  ])("rejects unsafe/non-origin endpoint %j", async (pointerUrl) => {
    const fetchImpl = upstream();
    const pointer = client({ fetchImpl });
    expect(pointerUrlSchema.safeParse(pointerUrl).success).toBe(false);
    await expect(
      pointer.configure({ enabled: true, pointerUrl }),
    ).rejects.toMatchObject({
      code: "invalid-settings",
      statusCode: 400,
    });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(await readdir(stateDir)).toEqual([]);
  });

  it.each([
    ["https://EXAMPLE.com:443/", "https://example.com"],
    ["https://example.com:8443", "https://example.com:8443"],
    ["http://localhost:8090/", "http://localhost:8090"],
    ["http://127.0.0.1:8090", "http://127.0.0.1:8090"],
    ["http://[::1]:8090", "http://[::1]:8090"],
  ])("normalizes supported origin %s", (input, expected) => {
    expect(pointerUrlSchema.parse(input)).toBe(expected);
  });

  it("rejects missing enabled endpoints and unknown credential settings", async () => {
    for (const input of [
      { enabled: true },
      { enabled: true, pointerUrl: "" },
      { enabled: false, pointerUrl: "", pushSecret: SECRET },
    ]) {
      expect(pointerSetupSchema.safeParse(input).success).toBe(false);
      await expect(client().configure(input)).rejects.toMatchObject({
        code: "invalid-settings",
      });
    }
  });
});

describe("manual pointer lifecycle", () => {
  it("validates the push and records endpoint, credential hashes and server expiry privately", async () => {
    const fetchImpl = upstream();
    const pointer = client({ fetchImpl });
    expect(await pointer.push(MANIFEST)).toMatchObject({
      state: "registered",
      usable: true,
      stale: false,
      lastPushedBaseUrl: BASE_URL,
      lastPushedAt: NOW,
      expiresAt: EXPIRES,
    });
    expect(fetchImpl).toHaveBeenCalledExactlyOnceWith(`${ORIGIN}/api/pointer`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${SECRET}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        baseUrl: BASE_URL,
        token: TOKEN,
        manifest: MANIFEST,
      }),
      redirect: "error",
      signal: expect.any(AbortSignal),
    });
    const path = join(stateDir, "pointer-state.json");
    const contents = await readFile(path, "utf8");
    expect(JSON.parse(contents)).toEqual({
      version: 2,
      pointerUrl: ORIGIN,
      tokenHash: digest(TOKEN),
      pushSecretHash: digest(SECRET),
      baseUrl: BASE_URL,
      pushedAt: NOW,
      expiresAt: EXPIRES,
    });
    expect(contents).not.toContain(TOKEN);
    expect(contents).not.toContain(SECRET);
    expect((await stat(path)).mode & 0o777).toBe(0o600);
  });

  it("keeps two recipient claims independent and preserves both across restarts", async () => {
    const fetchImpl = upstream();
    const a = {
      statePath: join(stateDir, "a", "pointer-state.json"),
      fetchImpl,
    };
    const b = {
      statePath: join(stateDir, "b", "pointer-state.json"),
      token: "another-installation-private-token",
      pushSecret: "another-installation-private-secret",
      fetchImpl,
    };
    await client(a).push(MANIFEST);
    await client(b).push(MANIFEST);
    for (const options of [a, b])
      expect(await client(options).status()).toMatchObject({
        state: "registered",
        usable: true,
      });
    expect(client(a).manifestUrl).not.toBe(client(b).manifestUrl);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    const requests = fetchImpl.mock.calls.map(([, init]) => ({
      token: JSON.parse(init!.body as string).token,
      authorization: (init!.headers as Record<string, string>).authorization,
    }));
    expect(requests).toEqual([
      { token: TOKEN, authorization: `Bearer ${SECRET}` },
      { token: b.token, authorization: `Bearer ${b.pushSecret}` },
    ]);
  });

  it("retains confirmed evidence across restarts, LAN changes, and expiry", async () => {
    await client({ fetchImpl: upstream() }).push(MANIFEST);
    expect(await client().status()).toMatchObject({
      state: "registered",
      usable: true,
      stale: false,
    });
    for (const lanIp of [() => "10.0.0.9", () => undefined])
      expect(await client({ lanIp }).status()).toMatchObject({
        state: "stale",
        usable: false,
        stale: true,
      });
    vi.setSystemTime(new Date(EXPIRES));
    expect(await client().status()).toMatchObject({
      state: "expired",
      usable: false,
      stale: true,
    });
  });

  it("cannot associate saved success with another endpoint, token, or push secret", async () => {
    const fetchImpl = upstream();
    await client({ fetchImpl }).push(MANIFEST);
    fetchImpl.mockClear();
    for (const overrides of [
      { token: "different-installation-access-token" },
      { pushSecret: "different-installation-push-secret" },
      { pointerUrl: "https://different.example" },
    ]) {
      const pointer = client({ ...overrides, fetchImpl });
      expect(await pointer.status()).toMatchObject({
        state: "recovery-required",
        usable: false,
        lastPushedBaseUrl: undefined,
      });
      await expect(pointer.push(MANIFEST)).rejects.toMatchObject({
        code: "identity-mismatch",
      });
      await expect(pointer.remove()).rejects.toMatchObject({
        code: "identity-mismatch",
      });
      expect(await pointer.remoteStatus()).toMatchObject({
        state: "recovery-required",
        reachable: false,
        registered: false,
      });
    }
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("requires removal before endpoint changes, while allowing disable and re-enable", async () => {
    const fetchImpl = upstream();
    const pointer = client({ fetchImpl });
    await pointer.push(MANIFEST);
    await expect(
      pointer.configure({
        enabled: true,
        pointerUrl: "https://new.example",
      }),
    ).rejects.toMatchObject({
      code: "endpoint-change-requires-removal",
      state: "recovery-required",
    });
    expect(await pointer.configure({ enabled: false })).toMatchObject({
      pointerUrl: ORIGIN,
      state: "disabled",
      usable: false,
    });
    await pointer.configure({ enabled: true, pointerUrl: ORIGIN });
    await pointer.remove();
    expect(await pointer.status()).toMatchObject({
      state: "unregistered",
      usable: false,
      lastPushedBaseUrl: undefined,
    });
    await expect(
      readFile(join(stateDir, "pointer-state.json")),
    ).rejects.toMatchObject({ code: "ENOENT" });
    expect(
      await pointer.configure({
        enabled: true,
        pointerUrl: "https://new.example",
      }),
    ).toMatchObject({
      pointerUrl: "https://new.example",
      state: "unregistered",
    });
    expect(fetchImpl.mock.calls[1]).toEqual([
      `${ORIGIN}/api/pointer`,
      {
        method: "DELETE",
        headers: {
          authorization: `Bearer ${SECRET}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ token: TOKEN }),
        redirect: "error",
        signal: expect.any(AbortSignal),
      },
    ]);
  });

  it("treats legacy state as recovery evidence, never a verified successful claim", async () => {
    const path = join(stateDir, "pointer-state.json");
    await writeFile(path, JSON.stringify({ baseUrl: BASE_URL, pushedAt: NOW }));
    const fetchImpl = upstream();
    const pointer = client({ fetchImpl });
    expect(await pointer.status()).toMatchObject({
      state: "recovery-required",
      usable: false,
    });
    expect(fetchImpl).not.toHaveBeenCalled();
    await expect(
      pointer.configure({
        enabled: true,
        pointerUrl: "https://new.example",
      }),
    ).rejects.toMatchObject({ code: "endpoint-change-requires-removal" });
    expect(await pointer.push(MANIFEST)).toMatchObject({
      state: "registered",
      usable: true,
    });
    expect(JSON.parse(await readFile(path, "utf8")).version).toBe(2);
  });

  it("refuses a manual push without a LAN address before making requests", async () => {
    const fetchImpl = upstream();
    const pointer = client({ lanIp: () => undefined, fetchImpl });
    await expect(pointer.push(MANIFEST)).rejects.toMatchObject({
      code: "no-lan-address",
      state: "stale",
      message: expect.stringContaining("No LAN IPv4 address"),
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it.each([
    {},
    { ok: false },
    { ok: true },
    { ok: true, updatedAt: "invalid", expiresAt: EXPIRES },
    { ok: true, updatedAt: NOW, expiresAt: NOW },
  ])(
    "does not mark an incompatible successful HTTP push as usable: %j",
    async (body) => {
      const pointer = client({ fetchImpl: upstream(body) });
      await expect(pointer.push(MANIFEST)).rejects.toMatchObject({
        code: "invalid-response",
        state: "unreachable",
      });
      expect(await client().status()).toMatchObject({
        usable: false,
        state: "unreachable",
        lastPushedBaseUrl: undefined,
      });
    },
  );

  it("rejects invalid JSON without exposing upstream data", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        new Response(`private-upstream-data ${SECRET} ${TOKEN}`),
      );
    const pointer = client({ fetchImpl });
    await expect(pointer.push(MANIFEST)).rejects.toMatchObject({
      code: "invalid-response",
    });
    expect(JSON.stringify(await pointer.status())).not.toContain(SECRET);
  });

  it("validates DELETE success before forgetting prior push evidence", async () => {
    const fetchImpl = upstream();
    const pointer = client({ fetchImpl });
    await pointer.push(MANIFEST);
    fetchImpl.mockResolvedValueOnce(Response.json({ ok: false }));
    await expect(pointer.remove()).rejects.toMatchObject({
      code: "invalid-response",
    });
    expect(await client().status()).toMatchObject({
      state: "unreachable",
      usable: false,
      lastPushedBaseUrl: BASE_URL,
    });
    await expect(
      readFile(join(stateDir, "pointer-state.json"), "utf8"),
    ).resolves.toContain(BASE_URL);
  });

  it.each(["push", "remove"] as const)(
    "retains failed %s authentication across restart without claiming success",
    async (action) => {
      const fetchImpl = upstream();
      const pointer = client({ fetchImpl });
      await pointer.push(MANIFEST);
      fetchImpl.mockResolvedValueOnce(
        Response.json({ error: "Unauthorized" }, { status: 401 }),
      );
      await expect(
        action === "push" ? pointer.push(MANIFEST) : pointer.remove(),
      ).rejects.toMatchObject({
        code: "authentication",
        state: "authentication-failed",
      });
      expect(await client().status()).toMatchObject({
        state: "authentication-failed",
        usable: false,
        lastPushedBaseUrl: BASE_URL,
      });
    },
  );

  it("serializes configuration, push, status, and removal without endpoint races", async () => {
    let finish!: (response: Response) => void;
    const fetchImpl = upstream();
    fetchImpl.mockImplementationOnce(
      () =>
        new Promise<Response>((resolve) => {
          finish = resolve;
        }),
    );
    fetchImpl.mockImplementationOnce(async () => Response.json(remoteBody()));
    const pointer = client({ fetchImpl });
    const pushed = pointer.push(MANIFEST);
    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledOnce());
    let configured = false;
    const setup = pointer
      .configure({ enabled: true, pointerUrl: "https://new.example" })
      .then(
        () => undefined,
        (error: unknown) => {
          configured = true;
          return error;
        },
      );
    const status = pointer.status();
    const remote = pointer.remoteStatus();
    const removed = pointer.remove();
    expect(configured).toBe(false);
    expect(fetchImpl).toHaveBeenCalledOnce();
    finish(Response.json(successBody()));
    expect(await pushed).toMatchObject({ state: "registered" });
    expect(await setup).toMatchObject({
      code: "endpoint-change-requires-removal",
    });
    expect(await status).toMatchObject({ state: "registered" });
    expect(await remote).toMatchObject({ state: "registered", usable: true });
    await removed;
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(await pointer.status()).toMatchObject({ state: "unregistered" });
  });
});

describe("manual remote status and failure evidence", () => {
  it("does not create local push evidence from a successful remote read", async () => {
    const fetchImpl = upstream(remoteBody());
    const pointer = client({ fetchImpl });
    expect(await pointer.remoteStatus()).toEqual({
      reachable: true,
      registered: true,
      baseUrl: BASE_URL,
      updatedAt: NOW,
      expiresAt: EXPIRES,
      state: "recovery-required",
      message:
        "A remote record exists, but no matching successful local push with expiry is saved. Manually update the pointer using this installation's original credentials before relying on it.",
      usable: false,
    });
    expect(await client().status()).toMatchObject({
      usable: false,
      lastPushedBaseUrl: undefined,
    });
    expect(fetchImpl).toHaveBeenCalledExactlyOnceWith(
      `${ORIGIN}/api/pointer/status`,
      {
        method: "GET",
        headers: {
          authorization: `Bearer ${SECRET}`,
          "x-addon-token": TOKEN,
        },
        redirect: "error",
        signal: expect.any(AbortSignal),
      },
    );
  });

  it.each([
    [401, "authentication-failed", "authentication"],
    [403, "authentication-failed", "authentication"],
    [404, "not-found", "not-found"],
    [429, "unreachable", "rate-limited"],
    [500, "unreachable", "service-error"],
    [503, "unreachable", "service-error"],
  ])(
    "persists manual HTTP %i failure across restart and invalidates earlier success",
    async (httpStatus, state, code) => {
      const fetchImpl = upstream();
      const pointer = client({ fetchImpl });
      await pointer.push(MANIFEST);
      fetchImpl.mockResolvedValueOnce(
        Response.json(
          { error: `Do not expose ${SECRET} ${TOKEN}` },
          { status: httpStatus },
        ),
      );
      const remote = await pointer.remoteStatus();
      expect(remote).toMatchObject({
        reachable: true,
        registered: false,
        state,
        usable: false,
      });
      expect(JSON.stringify(remote)).not.toContain(TOKEN);
      expect(JSON.stringify(remote)).not.toContain(SECRET);
      expect(await client().status()).toMatchObject({
        state,
        usable: false,
        lastPushedBaseUrl: BASE_URL,
      });
      expect(
        JSON.parse(await readFile(join(stateDir, "pointer-state.json"), "utf8"))
          .observation,
      ).toBe(code);
      if (httpStatus === 404) {
        expect(remote.message).toContain("push secret may not match");
        expect(remote.message).toContain("does not confirm an unregistered");
      }
    },
  );

  it("sanitizes network failures and never silently restores old success on restart", async () => {
    const fetchImpl = upstream();
    const pointer = client({ fetchImpl });
    await pointer.push(MANIFEST);
    fetchImpl.mockRejectedValueOnce(
      new Error(`request ${TOKEN} and ${SECRET} failed`),
    );
    const remote = await pointer.remoteStatus();
    expect(remote).toMatchObject({
      reachable: false,
      registered: false,
      state: "unreachable",
      usable: false,
    });
    expect(JSON.stringify(remote)).not.toContain(TOKEN);
    expect(JSON.stringify(remote)).not.toContain(SECRET);
    expect(await client().status()).toMatchObject({
      state: "unreachable",
      usable: false,
    });
  });

  it("recovers from a failure only after a successful manual check of matching push evidence", async () => {
    const fetchImpl = upstream();
    const pointer = client({ fetchImpl });
    await pointer.push(MANIFEST);
    fetchImpl.mockRejectedValueOnce(new Error("offline"));
    await pointer.remoteStatus();
    fetchImpl.mockResolvedValueOnce(Response.json(remoteBody()));
    expect(await pointer.remoteStatus()).toMatchObject({
      state: "registered",
      usable: true,
    });
    expect(await client().status()).toMatchObject({
      state: "registered",
      usable: true,
    });
  });

  it("persists a different remote record as stale and never extends local expiry from a read", async () => {
    const fetchImpl = upstream();
    const pointer = client({ fetchImpl });
    await pointer.push(MANIFEST);
    fetchImpl.mockResolvedValueOnce(
      Response.json({
        ...remoteBody(),
        baseUrl: "http://10.0.0.9:7001",
        expiresAt: "2027-01-01T10:00:00.000Z",
      }),
    );
    expect(await pointer.remoteStatus()).toMatchObject({
      state: "stale",
      usable: false,
    });
    expect(await client().status()).toMatchObject({
      state: "stale",
      usable: false,
      expiresAt: EXPIRES,
    });
  });

  it("reports remote expiry and retains it across restart", async () => {
    const fetchImpl = upstream();
    const pointer = client({ fetchImpl });
    await pointer.push(MANIFEST);
    fetchImpl.mockResolvedValueOnce(
      Response.json({
        ...remoteBody(),
        updatedAt: "2026-08-01T00:00:00.000Z",
        expiresAt: NOW,
      }),
    );
    expect(await pointer.remoteStatus()).toMatchObject({
      reachable: true,
      registered: true,
      state: "expired",
      usable: false,
    });
    expect(await client().status()).toMatchObject({
      state: "expired",
      usable: false,
    });
  });

  it.each([
    {},
    { ok: true },
    { ...remoteBody(), ok: false },
    { ...remoteBody(), baseUrl: `https://user:${SECRET}@example.com` },
    { ...remoteBody(), updatedAt: "not-a-time" },
    { ...remoteBody(), expiresAt: NOW },
  ])(
    "does not mistake malformed status JSON for a registered pointer: %j",
    async (body) => {
      const pointer = client({ fetchImpl: upstream(body) });
      expect(await pointer.remoteStatus()).toMatchObject({
        reachable: true,
        registered: false,
        state: "unreachable",
        usable: false,
        message: expect.stringContaining("invalid or incompatible"),
      });
    },
  );

  it("rejects redirects on all manual requests without forwarding credentials", async () => {
    const timeout = vi.spyOn(AbortSignal, "timeout");
    const fetchImpl = vi.fn<typeof fetch>().mockImplementation(
      async () =>
        new Response(null, {
          status: 307,
          headers: { location: `https://elsewhere.example/${TOKEN}` },
        }),
    );
    const pointer = client({ fetchImpl });
    await expect(pointer.push(MANIFEST)).rejects.toMatchObject({
      code: "redirect",
    });
    await expect(pointer.remove()).rejects.toMatchObject({
      code: "redirect",
    });
    expect(await pointer.remoteStatus()).toMatchObject({
      state: "unreachable",
      message: expect.stringContaining("Redirects are not followed"),
    });
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(timeout).toHaveBeenCalledTimes(3);
    expect(timeout.mock.calls).toEqual([[10_000], [10_000], [10_000]]);
    for (const [url, init] of fetchImpl.mock.calls) {
      expect(String(url).startsWith(ORIGIN)).toBe(true);
      expect(init?.redirect).toBe("error");
      expect(init?.signal).toBeInstanceOf(AbortSignal);
    }
  });

  it("never exposes upstream response bodies in thrown authentication errors or logs", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});
    const pointer = client({
      fetchImpl: upstream(
        { error: `${SECRET} ${TOKEN} internal storage failure` },
        401,
      ),
    });
    const error = await pointer.push(MANIFEST).catch((error: unknown) => error);
    expect(error).toBeInstanceOf(PointerError);
    expect(error).toMatchObject({
      state: "authentication-failed",
      code: "authentication",
      statusCode: 409,
    });
    expect(String(error)).not.toContain(TOKEN);
    expect(String(error)).not.toContain(SECRET);
    expect(log).not.toHaveBeenCalled();
    expect(errorLog).not.toHaveBeenCalled();
  });
});

describe("private persistence failures", () => {
  it.each(["{broken", "null", "{}", '{"baseUrl":"invalid"}'])(
    "explicitly rejects corrupt saved state %s without overwriting it or making requests",
    async (contents) => {
      const path = join(stateDir, "pointer-state.json");
      await writeFile(path, contents);
      const fetchImpl = upstream();
      const pointer = client({ fetchImpl });
      for (const action of [
        () => pointer.status(),
        () => pointer.push(MANIFEST),
        () => pointer.remove(),
        () => pointer.remoteStatus(),
        () => pointer.configure({ enabled: false }),
      ])
        await expect(action()).rejects.toMatchObject({
          code: "storage-error",
          state: "storage-error",
          statusCode: 503,
        });
      expect(await readFile(path, "utf8")).toBe(contents);
      expect(fetchImpl).not.toHaveBeenCalled();
    },
  );

  it.each([
    "{broken",
    "null",
    "{}",
    JSON.stringify({ enabled: true, pointerUrl: "" }),
    JSON.stringify({ enabled: true, pointerUrl: ORIGIN, pushSecret: SECRET }),
  ])(
    "does not fall back to environment setup on corrupt persisted settings %s",
    async (contents) => {
      const path = join(stateDir, "pointer-settings.json");
      await writeFile(path, contents);
      const fetchImpl = upstream();
      await expect(client({ fetchImpl }).status()).rejects.toMatchObject({
        state: "storage-error",
      });
      expect(await readFile(path, "utf8")).toBe(contents);
      expect(fetchImpl).not.toHaveBeenCalled();
    },
  );

  it("does not swallow non-ENOENT state read errors", async () => {
    const statePath = join(stateDir, "pointer-state.json");
    await mkdir(statePath);
    await expect(client({ statePath }).status()).rejects.toMatchObject({
      code: "storage-error",
    });
  });

  it("keeps old in-memory setup after a failed atomic settings write and cleans staging files", async () => {
    const pointer = client();
    await pointer.status();
    await mkdir(join(stateDir, "pointer-settings.json"));
    await expect(
      pointer.configure({
        enabled: true,
        pointerUrl: "https://new.example",
      }),
    ).rejects.toMatchObject({ code: "storage-error" });
    expect(await pointer.status()).toMatchObject({
      pointerUrl: ORIGIN,
      configured: true,
    });
    expect(await readdir(stateDir)).toEqual(["pointer-settings.json"]);
  });

  it("does not send a request when in-flight evidence cannot be saved", async () => {
    const fetchImpl = upstream();
    const pointer = client({ fetchImpl });
    await pointer.status();
    await mkdir(join(stateDir, "pointer-state.json"));
    await expect(pointer.push(MANIFEST)).rejects.toMatchObject({
      code: "storage-error",
    });
    expect(fetchImpl).not.toHaveBeenCalled();
    await expect(pointer.status()).rejects.toMatchObject({
      code: "storage-error",
    });
    expect(await readdir(stateDir)).toEqual(["pointer-state.json"]);
  });

  it("does not claim success when the server accepts a push but final persistence fails", async () => {
    const path = join(stateDir, "pointer-state.json");
    const fetchImpl = vi.fn<typeof fetch>().mockImplementation(async () => {
      await rm(path);
      await mkdir(path);
      return Response.json(successBody());
    });
    const pointer = client({ fetchImpl });
    await expect(pointer.push(MANIFEST)).rejects.toMatchObject({
      code: "storage-error",
    });
    expect(fetchImpl).toHaveBeenCalledOnce();
    await expect(pointer.status()).rejects.toMatchObject({
      state: "storage-error",
    });
    await expect(client().status()).rejects.toMatchObject({
      state: "storage-error",
    });
    expect(await readdir(stateDir)).toEqual(["pointer-state.json"]);
  });

  it("fails explicitly when validated removal cannot delete local state", async () => {
    const path = join(stateDir, "pointer-state.json");
    const fetchImpl = upstream();
    const pointer = client({ fetchImpl });
    await pointer.push(MANIFEST);
    fetchImpl.mockImplementationOnce(async () => {
      await rm(path);
      await mkdir(path);
      await writeFile(join(path, "blocker"), "fixture");
      return Response.json({ ok: true });
    });
    await expect(pointer.remove()).rejects.toMatchObject({
      code: "storage-error",
      state: "storage-error",
    });
    await expect(pointer.status()).rejects.toMatchObject({
      state: "storage-error",
    });
    await expect(client().status()).rejects.toMatchObject({
      state: "storage-error",
    });
  });

  it("keeps a durable incomplete marker when a request is interrupted", async () => {
    let finish!: (response: Response) => void;
    const fetchImpl = upstream();
    const pointer = client({ fetchImpl });
    await pointer.push(MANIFEST);
    fetchImpl.mockImplementationOnce(
      () =>
        new Promise<Response>((resolve) => {
          finish = resolve;
        }),
    );
    const pushed = pointer.push(MANIFEST);
    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(2));
    expect(await client().status()).toMatchObject({
      state: "unreachable",
      usable: false,
      message: expect.stringContaining("not confirmed"),
    });
    finish(Response.json(successBody()));
    await pushed;
  });
});
