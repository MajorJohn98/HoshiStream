import { randomBytes } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import manage from "../api/pointer.js";
import status from "../api/pointer/status.js";
import relay from "../api/relay.js";
import type { PointerRecord } from "../lib/relay.js";

const records = vi.hoisted(() => new Map<string, PointerRecord>());
vi.mock("../lib/ratelimit.js", () => ({ allowRequest: async () => true }));
vi.mock("../lib/store.js", () => ({
  loadPointerRecord: async (hash: string) => {
    const record = records.get(hash);
    return record && Date.parse(record.expiresAt) > Date.now()
      ? record
      : undefined;
  },
  savePointerRecord: async (record: PointerRecord) =>
    records.set(record.tokenHash, record),
  deletePointerRecord: async (hash: string) => records.delete(hash),
  loadLegacyPointer: async () => undefined,
}));
afterEach(() => records.clear());

async function request(
  path: string,
  method = "GET",
  secret?: string,
  token?: string,
  body?: object,
) {
  let code = 200;
  let payload: unknown;
  const headers = new Headers();
  const response = {
    status(value: number) {
      code = value;
      return response;
    },
    setHeader(key: string, value: string) {
      headers.set(key, value);
      return response;
    },
    json(value: unknown) {
      payload = value;
      return response;
    },
    end() {
      return response;
    },
  };
  const incoming = {
    method,
    headers: {
      ...(secret ? { authorization: `Bearer ${secret}` } : {}),
      ...(token ? { "x-addon-token": token } : {}),
    },
    body,
    query: {},
    url: path,
  };
  const handler =
    path === "/api/pointer/status"
      ? status
      : path === "/api/pointer"
        ? manage
        : relay;
  await handler(
    incoming as Parameters<typeof handler>[0],
    response as unknown as Parameters<typeof handler>[1],
  );
  return { code, payload, headers };
}

describe("independent recipient pointer API", () => {
  it("registers, checks, relays, updates and removes two isolated tenant records", async () => {
    const recipients = [42, 43].map((host) => ({
      token: randomBytes(32).toString("base64url"),
      secret: randomBytes(32).toString("base64url"),
      baseUrl: `http://192.168.1.${host}:7001`,
      manifest: { id: `fixture-${host}`, version: "0.14.0" },
    }));
    for (const recipient of recipients) {
      const { secret, token, baseUrl, manifest } = recipient;
      const push = await request("/api/pointer", "POST", secret, undefined, {
        token,
        baseUrl,
        manifest,
      });
      expect(push.code).toBe(200);
      expect(push.payload).toMatchObject({
        ok: true,
        expiresAt: expect.any(String),
      });
      const health = await request("/api/pointer/status", "GET", secret, token);
      expect(health.code).toBe(200);
      expect(health.payload).toMatchObject({ baseUrl });
      const manifestResponse = await request(`/addon/${token}/manifest.json`);
      expect(manifestResponse.code).toBe(200);
      expect(manifestResponse.payload).toEqual(manifest);
      for (const resource of [
        "catalog/movie/private-movies.json",
        "meta/movie/hoshi%3Afixture.json",
        "stream/movie/hoshi%3Afixture.json",
      ]) {
        const response = await request(`/addon/${token}/${resource}`);
        expect(response.code).toBe(307);
        expect(response.headers.get("location")).toBe(
          `${baseUrl}/addon/${token}/${resource}`,
        );
      }
      expect(
        (
          await request("/api/pointer", "POST", secret, undefined, {
            token,
            baseUrl: "http://10.0.0.2:7001",
            manifest,
          })
        ).code,
      ).toBe(200);
    }
    expect(records.size).toBe(2);
    const [first, second] = recipients;
    if (!first || !second) throw new Error("Missing recipient fixtures");
    expect(first.secret).not.toBe(second.secret);
    expect(first.token).not.toBe(second.token);
    expect(
      (
        await request("/api/pointer", "POST", second.secret, undefined, {
          token: first.token,
          baseUrl: first.baseUrl,
          manifest: first.manifest,
        })
      ).code,
    ).toBe(401);
    expect(
      (await request("/api/pointer/status", "GET", second.secret, first.token))
        .code,
    ).toBe(404);
    expect(
      (
        await request(
          "/api/pointer/status",
          "GET",
          first.secret,
          "missing-long-fixture-token",
        )
      ).code,
    ).toBe(404);
    expect(
      (
        await request("/api/pointer", "DELETE", second.secret, undefined, {
          token: first.token,
        })
      ).code,
    ).toBe(401);
    expect(records.size).toBe(2);
    expect(
      (
        await request("/api/pointer", "DELETE", first.secret, undefined, {
          token: first.token,
        })
      ).code,
    ).toBe(200);
    expect(
      (await request("/api/pointer/status", "GET", second.secret, second.token))
        .code,
    ).toBe(200);
    expect(
      (
        await request("/api/pointer", "DELETE", second.secret, undefined, {
          token: second.token,
        })
      ).code,
    ).toBe(200);
    expect(records.size).toBe(0);
  });
});
