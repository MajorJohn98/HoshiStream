// LAN discovery (ADR 0011): a dependency-free mDNS responder advertising
// _hoshistream._tcp.local on 224.0.0.251:5353. Publishes PTR/SRV/TXT/A for
// the add-on port. The TXT record never carries the access token.
import { createSocket, type Socket } from "node:dgram";
import { networkInterfaces, hostname } from "node:os";

const MDNS_ADDRESS = "224.0.0.251";
const MDNS_PORT = 5353;
const SERVICE = "_hoshistream._tcp.local";
// Longest the goodbye packet may delay releasing the dgram handle.
const GOODBYE_TIMEOUT_MS = 1_000;
const ENUMERATION = "_services._dns-sd._udp.local";
const TTL = 4500;

const TYPE_A = 1;
const TYPE_PTR = 12;
const TYPE_TXT = 16;
const TYPE_SRV = 33;
const CLASS_IN = 1;
const CACHE_FLUSH = 0x8001;

export function lanIPv4(): string | undefined {
  for (const addresses of Object.values(networkInterfaces())) {
    for (const address of addresses ?? []) {
      if (address.family === "IPv4" && !address.internal) {
        return address.address;
      }
    }
  }
  return undefined;
}

function encodeName(name: string): Buffer {
  const parts = name.split(".").filter(Boolean);
  const chunks: Buffer[] = [];
  for (const part of parts) {
    const bytes = Buffer.from(part, "utf8");
    chunks.push(Buffer.from([bytes.length]), bytes);
  }
  chunks.push(Buffer.from([0]));
  return Buffer.concat(chunks);
}

function record(
  name: string,
  type: number,
  klass: number,
  ttl: number,
  data: Buffer,
): Buffer {
  const head = encodeName(name);
  const fixed = Buffer.alloc(10);
  fixed.writeUInt16BE(type, 0);
  fixed.writeUInt16BE(klass, 2);
  fixed.writeUInt32BE(ttl, 4);
  fixed.writeUInt16BE(data.length, 8);
  return Buffer.concat([head, fixed, data]);
}

function txtData(entries: Record<string, string>): Buffer {
  const chunks: Buffer[] = [];
  for (const [key, value] of Object.entries(entries)) {
    const bytes = Buffer.from(`${key}=${value}`, "utf8");
    chunks.push(Buffer.from([bytes.length]), bytes);
  }
  return Buffer.concat(chunks.length ? chunks : [Buffer.from([0])]);
}

function srvData(port: number, target: string): Buffer {
  const fixed = Buffer.alloc(6);
  fixed.writeUInt16BE(0, 0); // priority
  fixed.writeUInt16BE(0, 2); // weight
  fixed.writeUInt16BE(port, 4);
  return Buffer.concat([fixed, encodeName(target)]);
}

// Reads one DNS name, following compression pointers, and returns it in
// lower case. Used only for parsing incoming question sections.
export function readName(
  message: Buffer,
  offset: number,
): { name: string; next: number } {
  const labels: string[] = [];
  let position = offset;
  let next = -1;
  let hops = 0;
  for (;;) {
    if (position >= message.length || hops > 16) break;
    const length = message[position];
    if (length === 0) {
      if (next === -1) next = position + 1;
      break;
    }
    if ((length & 0xc0) === 0xc0) {
      if (next === -1) next = position + 2;
      position = ((length & 0x3f) << 8) | message[position + 1];
      hops++;
      continue;
    }
    labels.push(
      message.subarray(position + 1, position + 1 + length).toString("utf8"),
    );
    position += length + 1;
  }
  return {
    name: labels.join(".").toLowerCase(),
    next: next === -1 ? position : next,
  };
}

export function questionNames(message: Buffer): string[] {
  if (message.length < 12) return [];
  // Queries have QR=0 in the flags.
  if ((message.readUInt16BE(2) & 0x8000) !== 0) return [];
  const count = message.readUInt16BE(4);
  const names: string[] = [];
  let offset = 12;
  for (let index = 0; index < count && offset < message.length; index++) {
    const { name, next } = readName(message, offset);
    names.push(name);
    offset = next + 4; // skip QTYPE + QCLASS
  }
  return names;
}

export interface MdnsOptions {
  port: number;
  instanceName?: string;
  version?: string;
  ipCheckIntervalMs?: number;
}

export function buildAnswer(
  options: MdnsOptions,
  ip: string,
  ttl = TTL,
): Buffer {
  const instance = `${options.instanceName ?? "HoshiStream"}.${SERVICE}`;
  const target = `${hostname().split(".")[0] || "hoshistream"}.local`;
  const answers = [
    record(ENUMERATION, TYPE_PTR, CLASS_IN, ttl, encodeName(SERVICE)),
    record(SERVICE, TYPE_PTR, CLASS_IN, ttl, encodeName(instance)),
    record(instance, TYPE_SRV, CACHE_FLUSH, ttl, srvData(options.port, target)),
    record(
      instance,
      TYPE_TXT,
      CACHE_FLUSH,
      ttl,
      txtData({ version: options.version ?? "1", api: "stremio" }),
    ),
    record(
      target,
      TYPE_A,
      CACHE_FLUSH,
      ttl,
      Buffer.from(ip.split(".").map(Number)),
    ),
  ];
  const header = Buffer.alloc(12);
  header.writeUInt16BE(0x8400, 2); // authoritative response
  header.writeUInt16BE(answers.length, 6);
  return Buffer.concat([header, ...answers]);
}

export class MdnsResponder {
  readonly #options: MdnsOptions;
  #socket: Socket | undefined;
  #ip: string | undefined;
  #ipWatch: NodeJS.Timeout | undefined;

  constructor(options: MdnsOptions) {
    this.#options = options;
  }

  start(): void {
    this.#ip = lanIPv4();
    if (!this.#ip) {
      console.log(JSON.stringify({ level: "warn", event: "mdns_no_lan_ip" }));
      return;
    }
    const socket = createSocket({ type: "udp4", reuseAddr: true });
    this.#socket = socket;
    socket.on("error", (error: Error) => {
      console.log(
        JSON.stringify({
          level: "warn",
          event: "mdns_error",
          error: error.message,
        }),
      );
      socket.close();
      this.#socket = undefined;
    });
    socket.on("message", (message) => {
      if (!this.#ip) return;
      const names = questionNames(message);
      if (
        names.includes(SERVICE) ||
        names.includes(ENUMERATION) ||
        names.some((name) => name.endsWith(SERVICE))
      ) {
        this.#send(buildAnswer(this.#options, this.#ip));
      }
    });
    socket.bind(MDNS_PORT, () => {
      try {
        socket.addMembership(MDNS_ADDRESS);
        socket.setMulticastTTL(255);
      } catch {
        // interface without multicast; announcements may still work
      }
      this.#announce();
    });
    this.#ipWatch = setInterval(() => {
      const current = lanIPv4();
      if (current && current !== this.#ip) {
        this.#ip = current;
        this.#announce();
      }
    }, this.#options.ipCheckIntervalMs ?? 30_000);
    this.#ipWatch.unref();
    console.log(
      JSON.stringify({
        level: "info",
        event: "mdns_started",
        service: SERVICE,
        port: this.#options.port,
      }),
    );
  }

  #announce(): void {
    if (!this.#ip) return;
    // Two announcements a second apart, per RFC 6762 §8.3.
    this.#send(buildAnswer(this.#options, this.#ip));
    setTimeout(() => {
      if (this.#ip) this.#send(buildAnswer(this.#options, this.#ip));
    }, 1_000).unref();
  }

  #send(message: Buffer): void {
    this.#socket?.send(message, MDNS_PORT, MDNS_ADDRESS, () => undefined);
  }

  close(): void {
    if (this.#ipWatch) clearInterval(this.#ipWatch);
    // Capture the socket first: clearing the field before the send callback
    // runs made `this.#socket?.close()` a no-op, leaving the dgram handle open
    // and the process unable to exit.
    const socket = this.#socket;
    this.#socket = undefined;
    if (!socket) return;
    if (!this.#ip) {
      socket.close();
      return;
    }
    // Goodbye packet: same records with TTL 0. Close regardless of whether the
    // send reports back, so a failed send cannot strand the handle.
    let closed = false;
    const closeOnce = () => {
      if (closed) return;
      closed = true;
      socket.close();
    };
    const fallback = setTimeout(closeOnce, GOODBYE_TIMEOUT_MS);
    fallback.unref();
    socket.send(
      buildAnswer(this.#options, this.#ip, 0),
      MDNS_PORT,
      MDNS_ADDRESS,
      () => {
        clearTimeout(fallback);
        closeOnce();
      },
    );
  }
}
