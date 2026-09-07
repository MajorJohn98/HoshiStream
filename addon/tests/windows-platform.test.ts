import { randomUUID } from "node:crypto";
import {
  mkdtemp,
  mkdir,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { createServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  NativeBridgeError,
  WINDOWS_MOUNTS_SCRIPT,
  enumerateWindowsMounts,
  nativeBridgeRequest,
  parseWindowsMounts,
} from "../src/windows-platform.ts";
import {
  NativePicker,
  PickerCancelledError,
  PickerUnavailableError,
} from "../src/native-picker.ts";
import { processStats } from "../src/resources.ts";

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

async function bridge(
  handler: (request: Record<string, unknown>, socket: Socket) => void,
) {
  const directory = await mkdtemp(join(tmpdir(), "hoshi-native-"));
  cleanup.push(() => rm(directory, { recursive: true, force: true }));
  const endpoint =
    process.platform === "win32"
      ? `\\\\.\\pipe\\hoshi-native-test-${randomUUID()}`
      : join(directory, "bridge.sock");
  const clients = new Set<Socket>();
  const server = createServer((socket) => {
    clients.add(socket);
    socket.on("error", () => undefined);
    let data = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk) => {
      data += chunk;
      if (data.includes("\n")) handler(JSON.parse(data.split("\n")[0]), socket);
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(endpoint, resolve);
  });
  cleanup.push(async () => {
    for (const socket of clients) socket.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  return { endpoint, directory };
}

const reply = (socket: Socket, message: object) =>
  socket.end(`${JSON.stringify(message)}\n`);

describe("Windows native bridge", () => {
  it("pings a live pipe rather than treating it as a filesystem entry", async () => {
    const { endpoint } = await bridge((request, socket) => {
      expect(request.kind).toBe("ping");
      expect(request.nonce).toMatch(/^[0-9a-f-]{36}$/);
      reply(socket, { nonce: request.nonce, available: true });
    });
    await expect(new NativePicker(endpoint, "win32").available()).resolves.toBe(
      true,
    );
    await expect(
      new NativePicker(`${endpoint}-missing`, "win32").available(),
    ).resolves.toBe(false);
  });

  it("links file/folder selections in place and allows empty storage roots", async () => {
    let selection = "";
    const { endpoint, directory } = await bridge((request, socket) =>
      reply(socket, { nonce: request.nonce, path: selection }),
    );
    const folder = join(directory, "Series with spaces");
    await mkdir(folder);
    const video = join(folder, "Episode.mkv");
    await writeFile(video, "original-media");
    selection = video;
    const picker = new NativePicker(endpoint, "win32");
    const { grant } = await picker.issue("file");
    expect(picker.redeem(grant)).toEqual({
      kind: "file",
      path: await realpath(video),
    });
    selection = folder;
    await expect(picker.select("folder")).resolves.toBe(await realpath(folder));
    const empty = join(directory, "Storage");
    await mkdir(empty);
    selection = empty;
    await expect(picker.selectStorage()).resolves.toBe(await realpath(empty));
    await expect(picker.select("folder")).rejects.toThrow(
      "containing supported video",
    );
    expect(await readFile(video, "utf8")).toBe("original-media");
  });

  it("reports cancellation without issuing a path grant", async () => {
    const { endpoint } = await bridge((request, socket) =>
      reply(socket, { nonce: request.nonce, cancelled: true }),
    );
    await expect(
      new NativePicker(endpoint).issue("file"),
    ).rejects.toBeInstanceOf(PickerCancelledError);
  });

  it.each([
    { nonce: "wrong", path: "/movie.mkv" },
    { path: 12 },
    { cancelled: "true" },
    { cancelled: true, path: "/movie.mkv" },
  ])("rejects malformed or uncorrelated selections: %j", async (body) => {
    const { endpoint } = await bridge((request, socket) =>
      reply(socket, { nonce: request.nonce, ...body }),
    );
    await expect(
      new NativePicker(endpoint).select("file"),
    ).rejects.toBeInstanceOf(PickerUnavailableError);
  });

  it("bounds bytes, not characters, and rejects malformed JSON", async () => {
    const oversized = await bridge((request, socket) =>
      reply(socket, { nonce: request.nonce, path: "\u00e9".repeat(4_096) }),
    );
    await expect(
      nativeBridgeRequest(oversized.endpoint, { kind: "file" }, 500),
    ).rejects.toThrow("Invalid desktop response");
    const malformed = await bridge((_request, socket) =>
      socket.end("{invalid}\n"),
    );
    await expect(
      nativeBridgeRequest(malformed.endpoint, { kind: "ping" }, 500),
    ).rejects.toBeInstanceOf(NativeBridgeError);
  });

  it("handles fragmented UTF-8 without corrupting the selected path", async () => {
    const { endpoint } = await bridge((request, socket) => {
      const bytes = Buffer.from(
        `${JSON.stringify({ nonce: request.nonce, path: "C:\\M\u00e9dia\\film.mkv" })}\n`,
      );
      const split = bytes.indexOf(0xc3) + 1;
      socket.write(bytes.subarray(0, split));
      setTimeout(() => socket.end(bytes.subarray(split)), 10);
    });
    await expect(
      nativeBridgeRequest(endpoint, { kind: "file" }, 500),
    ).resolves.toMatchObject({ path: "C:\\M\u00e9dia\\film.mkv" });
  });

  it("bounds unresponsive peers and fails on incomplete disconnects", async () => {
    const silent = await bridge(() => undefined);
    await expect(
      nativeBridgeRequest(silent.endpoint, { kind: "ping" }, 25),
    ).rejects.toThrow("timed out");
    const closed = await bridge((_request, socket) => socket.end("{"));
    await expect(
      nativeBridgeRequest(closed.endpoint, { kind: "ping" }, 500),
    ).rejects.toThrow("closed");
  });
});

describe("Windows owned-process statistics", () => {
  const groups = {
    addon: { cpuPercent: 2.1, rssBytes: 4096, processes: 1 },
    torrServer: { cpuPercent: 3.2, rssBytes: 8192, processes: 1 },
    ffmpeg: { cpuPercent: 0, rssBytes: 0, processes: 0 },
  };

  it("requests only this Node tree and validates its three groups", async () => {
    const { endpoint } = await bridge((request, socket) => {
      expect(request.kind).toBe("resources");
      expect(request.pid).toBe(process.pid);
      reply(socket, {
        nonce: request.nonce,
        processes: { available: true, ...groups },
      });
    });
    expect(await processStats({ platform: "win32", endpoint })).toEqual({
      available: true,
      groups,
    });
  });

  it.each([
    { available: false },
    { available: true },
    {
      available: true,
      ...groups,
      addon: { cpuPercent: -1, rssBytes: 0, processes: 1 },
    },
    {
      available: true,
      ...groups,
      addon: { cpuPercent: 0, rssBytes: 0, processes: 0 },
    },
  ])(
    "reports unavailable instead of fabricated zeros: %j",
    async (processes) => {
      const { endpoint } = await bridge((request, socket) =>
        reply(socket, { nonce: request.nonce, processes }),
      );
      expect(await processStats({ platform: "win32", endpoint })).toEqual({
        available: false,
      });
    },
  );

  it("reports unavailable without a tray or when the collector stalls", async () => {
    vi.stubEnv("NATIVE_PICKER_SOCKET", "");
    expect(await processStats({ platform: "win32" })).toEqual({
      available: false,
    });
    vi.unstubAllEnvs();
    const { endpoint } = await bridge(() => undefined);
    expect(
      await processStats({ platform: "win32", endpoint, timeoutMs: 25 }),
    ).toEqual({ available: false });
  });
});

describe("Windows mount enumeration", () => {
  it("validates only bounded local drive roots", () => {
    expect(parseWindowsMounts('["c:\\\\","D:\\\\","C:\\\\"]')).toEqual([
      "C:\\",
      "D:\\",
    ]);
    expect(parseWindowsMounts("[]")).toEqual([]);
    for (const value of [
      '["\\\\\\\\server\\\\share"]',
      '["C:\\\\folder"]',
      '{"roots":[]}',
      JSON.stringify(Array(27).fill("C:\\")),
    ])
      expect(() => parseWindowsMounts(value)).toThrow();
  });

  it("uses a constant DriveInfo script with bounded output and no profile", async () => {
    const run = vi.fn().mockResolvedValue({ stdout: '["E:\\\\"]' });
    await expect(enumerateWindowsMounts(run)).resolves.toEqual(["E:\\"]);
    expect(run).toHaveBeenCalledWith(
      expect.stringMatching(/powershell\.exe$/),
      [
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        WINDOWS_MOUNTS_SCRIPT,
      ],
      expect.objectContaining({
        timeout: 5_000,
        maxBuffer: 8_192,
        windowsHide: true,
      }),
    );
    expect(WINDOWS_MOUNTS_SCRIPT).toContain("DriveType]::Fixed");
    expect(WINDOWS_MOUNTS_SCRIPT).toContain("DriveType]::Removable");
    expect(WINDOWS_MOUNTS_SCRIPT).not.toContain("Win32_LogicalDisk");
  });

  it("surfaces enumerator failures rather than reporting an empty drive list", async () => {
    const run = vi.fn().mockRejectedValue(new Error("PowerShell timed out"));
    await expect(enumerateWindowsMounts(run)).rejects.toThrow("timed out");
  });
});
