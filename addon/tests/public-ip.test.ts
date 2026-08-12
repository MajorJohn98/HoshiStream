import { beforeEach, describe, expect, it } from "vitest";
import {
  ownPublicIp,
  parseTraceIp,
  resetPublicIpCache,
} from "../src/public-ip.js";

function traceResponse(body: string, ok = true): typeof fetch {
  return (async () =>
    new Response(body, { status: ok ? 200 : 502 })) as typeof fetch;
}

describe("parseTraceIp", () => {
  it("extracts the ip line", () => {
    expect(parseTraceIp("fl=1\nip=203.0.113.9\nts=2")).toBe("203.0.113.9");
  });

  it("accepts IPv6 addresses", () => {
    expect(parseTraceIp("ip=2001:db8::1")).toBe("2001:db8::1");
  });

  it("rejects invalid addresses", () => {
    expect(parseTraceIp("ip=not-an-ip")).toBeNull();
  });

  it("returns null when no ip line exists", () => {
    expect(parseTraceIp("fl=1\nts=2")).toBeNull();
  });
});

describe("ownPublicIp", () => {
  beforeEach(() => resetPublicIpCache());

  it("resolves and caches the public IP", async () => {
    let calls = 0;
    const fetchImpl = (async () => {
      calls += 1;
      return new Response("ip=203.0.113.9\n");
    }) as typeof fetch;
    expect(await ownPublicIp(fetchImpl)).toBe("203.0.113.9");
    expect(await ownPublicIp(fetchImpl)).toBe("203.0.113.9");
    expect(calls).toBe(1);
  });

  it("caches failures for a short time", async () => {
    let time = 0;
    const now = () => time;
    let calls = 0;
    const failing = (async () => {
      calls += 1;
      throw new Error("network down");
    }) as typeof fetch;
    expect(await ownPublicIp(failing, now)).toBeNull();
    expect(await ownPublicIp(failing, now)).toBeNull();
    expect(calls).toBe(1);
    time = 31_000;
    expect(await ownPublicIp(failing, now)).toBeNull();
    expect(calls).toBe(2);
  });

  it("refreshes after the success TTL expires", async () => {
    let time = 0;
    const now = () => time;
    let calls = 0;
    const fetchImpl = (async () => {
      calls += 1;
      return new Response("ip=203.0.113.9\n");
    }) as typeof fetch;
    await ownPublicIp(fetchImpl, now);
    time = 5 * 60 * 1000 + 1;
    await ownPublicIp(fetchImpl, now);
    expect(calls).toBe(2);
  });

  it("returns null on non-OK responses", async () => {
    expect(await ownPublicIp(traceResponse("ip=203.0.113.9", false))).toBeNull();
  });

  it("returns null on malformed bodies", async () => {
    expect(await ownPublicIp(traceResponse("<html>error</html>"))).toBeNull();
  });
});
