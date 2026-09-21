import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { expectOwnerOnly } from "./helpers/private-files.ts";
import { DeviceNames } from "../src/device-names.ts";
import { parsePtrAnswer, reverseName } from "../src/hostname.ts";

let stateDir: string;

beforeEach(async () => {
  stateDir = await mkdtemp(join(tmpdir(), "hoshi-devices-"));
});

afterEach(async () => {
  await rm(stateDir, { recursive: true, force: true });
});

describe("DeviceNames", () => {
  it("persists names across instances with owner-only permissions", async () => {
    const path = join(stateDir, "device-names.json");
    await new DeviceNames(path).set("192.168.1.60", "Bedroom TV");

    const reloaded = new DeviceNames(path);
    expect(await reloaded.get("192.168.1.60")).toBe("Bedroom TV");
    await expectOwnerOnly(path);
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual({
      "192.168.1.60": "Bedroom TV",
    });
  });

  it("clears a name when set to empty and trims whitespace", async () => {
    const path = join(stateDir, "device-names.json");
    const names = new DeviceNames(path);
    await names.set("10.0.0.5", "  Living Room  ");
    expect(await names.get("10.0.0.5")).toBe("Living Room");
    await names.set("10.0.0.5", "   ");
    expect(await names.get("10.0.0.5")).toBeUndefined();
    expect(await names.all()).toEqual({});
  });

  it("survives a corrupt store file", async () => {
    const path = join(stateDir, "device-names.json");
    await new DeviceNames(path).set("10.0.0.5", "TV");
    const corrupted = new DeviceNames(join(stateDir, "missing.json"));
    expect(await corrupted.all()).toEqual({});
  });
});

describe("hostname reverse lookup parsing", () => {
  it("builds the in-addr.arpa name", () => {
    expect(reverseName("192.168.1.60")).toBe("60.1.168.192.in-addr.arpa");
  });

  function encodeName(name: string): Buffer {
    const chunks: Buffer[] = [];
    for (const part of name.split(".").filter(Boolean)) {
      chunks.push(Buffer.from([part.length]), Buffer.from(part));
    }
    chunks.push(Buffer.from([0]));
    return Buffer.concat(chunks);
  }

  function ptrResponse(owner: string, target: string): Buffer {
    const header = Buffer.alloc(12);
    header.writeUInt16BE(0x8400, 2); // response
    header.writeUInt16BE(1, 6); // one answer
    const ownerName = encodeName(owner);
    const targetName = encodeName(target);
    const fixed = Buffer.alloc(10);
    fixed.writeUInt16BE(12, 0); // PTR
    fixed.writeUInt16BE(1, 2); // IN
    fixed.writeUInt32BE(120, 4);
    fixed.writeUInt16BE(targetName.length, 8);
    return Buffer.concat([header, ownerName, fixed, targetName]);
  }

  it("extracts the PTR target for the queried name", () => {
    const queried = "60.1.168.192.in-addr.arpa";
    const message = ptrResponse(queried, "Johns-Apple-TV.local");
    expect(parsePtrAnswer(message, queried)).toBe("johns-apple-tv.local");
  });

  it("ignores queries, other owners, and truncated packets", () => {
    const queried = "60.1.168.192.in-addr.arpa";
    expect(
      parsePtrAnswer(
        ptrResponse("5.0.0.10.in-addr.arpa", "other.local"),
        queried,
      ),
    ).toBeUndefined();
    const query = ptrResponse(queried, "x.local");
    query.writeUInt16BE(0, 2); // QR=0 → a query, not a response
    expect(parsePtrAnswer(query, queried)).toBeUndefined();
    expect(parsePtrAnswer(Buffer.alloc(4), queried)).toBeUndefined();
  });
});
