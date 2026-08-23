import { describe, expect, it } from "vitest";
import {
  MdnsResponder,
  buildAnswer,
  lanIPv4,
  questionNames,
  readName,
} from "../src/mdns.js";

function encodeQuery(names: string[]): Buffer {
  const header = Buffer.alloc(12);
  header.writeUInt16BE(names.length, 4);
  const questions = names.map((name) => {
    const labels = Buffer.concat(
      name
        .split(".")
        .map((part) =>
          Buffer.concat([Buffer.from([part.length]), Buffer.from(part)]),
        ),
    );
    const tail = Buffer.alloc(5);
    tail.writeUInt16BE(12, 1); // QTYPE PTR
    tail.writeUInt16BE(1, 3); // QCLASS IN
    return Buffer.concat([labels, tail]);
  });
  return Buffer.concat([header, ...questions]);
}

describe("questionNames", () => {
  it("parses query question names case-insensitively", () => {
    const query = encodeQuery(["_HoshiStream._tcp.local"]);
    expect(questionNames(query)).toEqual(["_hoshistream._tcp.local"]);
  });

  it("parses multiple questions", () => {
    const query = encodeQuery([
      "_services._dns-sd._udp.local",
      "_hoshistream._tcp.local",
    ]);
    expect(questionNames(query)).toEqual([
      "_services._dns-sd._udp.local",
      "_hoshistream._tcp.local",
    ]);
  });

  it("ignores responses and truncated packets", () => {
    const response = encodeQuery(["_hoshistream._tcp.local"]);
    response.writeUInt16BE(0x8400, 2);
    expect(questionNames(response)).toEqual([]);
    expect(questionNames(Buffer.alloc(4))).toEqual([]);
  });
});

describe("readName", () => {
  it("follows compression pointers", () => {
    // "local" at offset 12, then a pointer to it at offset 19.
    const message = Buffer.concat([
      Buffer.alloc(12),
      Buffer.from([5]),
      Buffer.from("local"),
      Buffer.from([0]),
      Buffer.from([3]),
      Buffer.from("foo"),
      Buffer.from([0xc0, 12]),
    ]);
    const { name } = readName(message, 19);
    expect(name).toBe("foo.local");
  });
});

describe("buildAnswer", () => {
  it("contains the service, SRV port, TXT, and A record", () => {
    const answer = buildAnswer({ port: 7001 }, "192.168.1.50");
    // Authoritative response header with 5 answers.
    expect(answer.readUInt16BE(2)).toBe(0x8400);
    expect(answer.readUInt16BE(6)).toBe(5);
    const text = answer.toString("latin1");
    expect(text).toContain("_hoshistream");
    expect(text).toContain("version=");
    // SRV data ends with port 7001 somewhere in the packet.
    const port = Buffer.alloc(2);
    port.writeUInt16BE(7001);
    expect(answer.includes(port)).toBe(true);
    // A record payload is the packed IP.
    expect(answer.includes(Buffer.from([192, 168, 1, 50]))).toBe(true);
  });

  it("never contains a token-like value", () => {
    const answer = buildAnswer(
      { port: 7001, version: "0.8.0" },
      "10.0.0.2",
    ).toString("latin1");
    expect(answer).not.toContain("token");
    expect(answer).not.toContain("ACCESS");
  });

  it("uses TTL 0 for goodbye packets", () => {
    const bye = buildAnswer({ port: 7001 }, "10.0.0.2", 0);
    // First answer's TTL field: after header(12) + name + type/class.
    const text = bye.toString("latin1");
    expect(text).toContain("_hoshistream");
    // No 4500 TTL anywhere in a goodbye packet.
    const ttl = Buffer.alloc(4);
    ttl.writeUInt32BE(4500);
    expect(bye.includes(ttl)).toBe(false);
  });
});

describe("lanIPv4", () => {
  it("returns a dotted quad or undefined", () => {
    const ip = lanIPv4();
    if (ip !== undefined) expect(ip).toMatch(/^\d+\.\d+\.\d+\.\d+$/);
  });
});

// Regression: close() cleared #socket before the goodbye-packet callback ran,
// so `this.#socket?.close()` was a no-op. The dgram handle stayed open and kept
// the event loop alive, which orphaned the daemon whenever the supervisor
// exited — the server had shut down but the process never terminated.
describe("MdnsResponder.close", () => {
  const udpHandles = () =>
    process.getActiveResourcesInfo().filter((name) => name === "UDPWrap")
      .length;

  it("releases the dgram handle so the process can exit", async () => {
    if (!lanIPv4()) return; // No LAN address: start() binds no socket.
    const before = udpHandles();
    const responder = new MdnsResponder({ port: 7791 });
    responder.start();
    expect(udpHandles()).toBeGreaterThan(before);

    responder.close();
    await new Promise((resolve) => setTimeout(resolve, 1_500));

    expect(udpHandles()).toBe(before);
  });

  it("is safe to call twice and without a prior start", () => {
    const responder = new MdnsResponder({ port: 7792 });
    expect(() => responder.close()).not.toThrow();
    responder.start();
    responder.close();
    expect(() => responder.close()).not.toThrow();
  });
});
