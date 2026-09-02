// Best-effort hostname detection for the Devices panel: a client IP often
// reverse-resolves to something human ("Johns-Apple-TV.local"). Two sources,
// both LAN-local and privacy-neutral:
//   1. the system resolver's PTR record (router DNS), and
//   2. an mDNS reverse PTR query on 224.0.0.251:5353 (RFC 6762).
import { createSocket } from "node:dgram";
import { reverse } from "node:dns/promises";
import { readName } from "./mdns.js";

const MDNS_ADDRESS = "224.0.0.251";
const MDNS_PORT = 5353;
const TYPE_PTR = 12;
const LOOKUP_TIMEOUT_MS = 1_500;
const CACHE_TTL_MS = 10 * 60_000;
const NEGATIVE_TTL_MS = 5 * 60_000;
const CACHE_MAX_ENTRIES = 256;

interface Cached {
  hostname: string | undefined;
  expiresAt: number;
}

const cache = new Map<string, Cached>();
const inflight = new Map<string, Promise<string | undefined>>();

export function resetHostnameCache(): void {
  cache.clear();
  inflight.clear();
}

export function reverseName(ip: string): string {
  return `${ip.split(".").reverse().join(".")}.in-addr.arpa`;
}

function encodeQuestion(name: string): Buffer {
  const header = Buffer.alloc(12);
  header.writeUInt16BE(1, 4); // QDCOUNT
  const parts = name.split(".").filter(Boolean);
  const chunks: Buffer[] = [header];
  for (const part of parts) {
    const bytes = Buffer.from(part, "utf8");
    chunks.push(Buffer.from([bytes.length]), bytes);
  }
  const tail = Buffer.alloc(5);
  tail.writeUInt16BE(TYPE_PTR, 1);
  // QU bit set: ask for a unicast response back to our ephemeral port.
  tail.writeUInt16BE(0x8001, 3);
  chunks.push(tail);
  return Buffer.concat(chunks);
}

// Extracts the first PTR answer matching the queried name from a DNS
// response message. Exported for tests.
export function parsePtrAnswer(
  message: Buffer,
  queried: string,
): string | undefined {
  if (message.length < 12) return undefined;
  if ((message.readUInt16BE(2) & 0x8000) === 0) return undefined; // not a response
  const questions = message.readUInt16BE(4);
  const answers = message.readUInt16BE(6);
  let offset = 12;
  for (let index = 0; index < questions; index += 1) {
    offset = readName(message, offset).next + 4;
  }
  for (let index = 0; index < answers && offset + 10 <= message.length;) {
    const owner = readName(message, offset);
    const type = message.readUInt16BE(owner.next);
    const rdlength = message.readUInt16BE(owner.next + 8);
    const rdata = owner.next + 10;
    if (type === TYPE_PTR && owner.name === queried.toLowerCase()) {
      const target = readName(message, rdata).name;
      if (target) return target;
    }
    offset = rdata + rdlength;
    index += 1;
  }
  return undefined;
}

function mdnsReverseLookup(ip: string): Promise<string | undefined> {
  return new Promise((resolvePromise) => {
    const queried = reverseName(ip);
    const socket = createSocket("udp4");
    let settled = false;
    const finish = (result: string | undefined) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.close();
      resolvePromise(result);
    };
    const timer = setTimeout(() => finish(undefined), LOOKUP_TIMEOUT_MS);
    timer.unref();
    socket.on("error", () => finish(undefined));
    socket.on("message", (message) => {
      const target = parsePtrAnswer(message, queried);
      if (target) finish(target);
    });
    socket.bind(() => {
      const query = encodeQuestion(queried);
      // Multicast query plus a legacy direct unicast query — Apple and many
      // Android devices answer at least one of the two.
      socket.send(query, MDNS_PORT, MDNS_ADDRESS, () => undefined);
      socket.send(query, MDNS_PORT, ip, () => undefined);
    });
  });
}

async function systemReverseLookup(ip: string): Promise<string | undefined> {
  try {
    const names = await Promise.race([
      reverse(ip),
      new Promise<string[]>((_, reject) => {
        const timer = setTimeout(
          () => reject(new Error("timeout")),
          LOOKUP_TIMEOUT_MS,
        );
        timer.unref();
      }),
    ]);
    return names[0] || undefined;
  } catch {
    return undefined;
  }
}

function isLookupCandidate(ip: string): boolean {
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(ip) && !ip.startsWith("127.");
}

export async function lookupHostname(ip: string): Promise<string | undefined> {
  if (!isLookupCandidate(ip)) return undefined;
  const cached = cache.get(ip);
  if (cached && cached.expiresAt > Date.now()) return cached.hostname;
  const pending = inflight.get(ip);
  if (pending) return pending;
  const lookup = (async () => {
    const hostname =
      (await systemReverseLookup(ip)) ?? (await mdnsReverseLookup(ip));
    if (cache.size >= CACHE_MAX_ENTRIES) {
      const oldest = cache.keys().next().value;
      if (oldest !== undefined) cache.delete(oldest);
    }
    cache.set(ip, {
      hostname,
      expiresAt: Date.now() + (hostname ? CACHE_TTL_MS : NEGATIVE_TTL_MS),
    });
    inflight.delete(ip);
    return hostname;
  })();
  inflight.set(ip, lookup);
  return lookup;
}
