import { createServer, type Server } from "node:net";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { PlayerIpc, PlayerIpcError } from "../src/player-ipc.ts";

const missingSocket =
  process.platform === "win32"
    ? `\\\\.\\pipe\\hoshistream-missing-${randomUUID()}`
    : "/nonexistent/mpv.sock";

// Speaks the same line-delimited JSON protocol as mpv's --input-ipc-server so
// the client can be exercised without the real binary installed.
async function fakeMpv(
  handler: (command: unknown[]) => { error: string; data?: unknown },
) {
  const directory = await mkdtemp(join(tmpdir(), "hoshistream-ipc-"));
  const socketPath =
    process.platform === "win32"
      ? `\\\\.\\pipe\\hoshistream-ipc-test-${randomUUID()}`
      : join(directory, "mpv.sock");
  const received: unknown[][] = [];
  const clients: import("node:net").Socket[] = [];
  const server: Server = createServer((socket) => {
    clients.push(socket);
    // The client may disconnect mid-reply; EPIPE here is expected.
    socket.on("error", () => undefined);
    let buffer = "";
    socket.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      let index = buffer.indexOf("\n");
      while (index !== -1) {
        const line = buffer.slice(0, index).trim();
        buffer = buffer.slice(index + 1);
        if (line) {
          const request = JSON.parse(line) as {
            command: unknown[];
            request_id: number;
          };
          received.push(request.command);
          const result = handler(request.command);
          if (socket.destroyed) return;
          socket.write(
            `${JSON.stringify({ ...result, request_id: request.request_id })}\n`,
          );
        }
        index = buffer.indexOf("\n");
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(socketPath, resolve));
  return {
    socketPath,
    received,
    emit(event: unknown) {
      for (const socket of clients)
        if (!socket.destroyed) socket.write(`${JSON.stringify(event)}\n`);
    },
    async close() {
      for (const socket of clients) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(directory, { recursive: true, force: true });
    },
  };
}

describe("player IPC", () => {
  it("sends commands and resolves the matching reply", async () => {
    const mpv = await fakeMpv(() => ({ error: "success", data: 42 }));
    const ipc = new PlayerIpc(mpv.socketPath);
    await ipc.connect();

    await expect(ipc.command("loadfile", "/tmp/a.mkv")).resolves.toBe(42);
    expect(mpv.received[0]).toEqual(["loadfile", "/tmp/a.mkv"]);

    ipc.close();
    await mpv.close();
  });

  it("rejects when mpv reports an error", async () => {
    const mpv = await fakeMpv(() => ({ error: "property not found" }));
    const ipc = new PlayerIpc(mpv.socketPath);
    await ipc.connect();

    await expect(ipc.property("bogus")).rejects.toBeInstanceOf(PlayerIpcError);

    ipc.close();
    await mpv.close();
  });

  it("correlates concurrent requests by id", async () => {
    const mpv = await fakeMpv((command) => ({
      error: "success",
      data: command[1],
    }));
    const ipc = new PlayerIpc(mpv.socketPath);
    await ipc.connect();

    const results = await Promise.all([
      ipc.property("time-pos"),
      ipc.property("duration"),
      ipc.property("pause"),
    ]);

    expect(results).toEqual(["time-pos", "duration", "pause"]);

    ipc.close();
    await mpv.close();
  });

  it("refuses commands when not connected", async () => {
    const ipc = new PlayerIpc(missingSocket);
    await expect(ipc.command("loadfile", "x")).rejects.toBeInstanceOf(
      PlayerIpcError,
    );
  });

  it("gives up connecting to a socket that never appears", async () => {
    const ipc = new PlayerIpc(missingSocket);
    await expect(ipc.connect(2, 1)).rejects.toBeInstanceOf(PlayerIpcError);
  });

  it("fails pending commands when the connection closes", async () => {
    const mpv = await fakeMpv(() => ({ error: "success" }));
    const ipc = new PlayerIpc(mpv.socketPath);
    await ipc.connect();
    const pending = ipc.command("get_property", "time-pos");
    ipc.close();

    await expect(pending).rejects.toBeInstanceOf(PlayerIpcError);
    await mpv.close();
  });

  it("delivers asynchronous events to listeners", async () => {
    const mpv = await fakeMpv(() => ({ error: "success" }));
    const ipc = new PlayerIpc(mpv.socketPath);
    await ipc.connect();
    const seen: Array<[string, unknown]> = [];
    ipc.onEvent((event, payload) => seen.push([event, payload]));

    mpv.emit({ event: "property-change", name: "time-pos", data: 12.5 });
    await vi.waitFor(() => expect(seen).toHaveLength(1));

    expect(seen[0][0]).toBe("property-change");
    expect(seen[0][1]).toMatchObject({ name: "time-pos", data: 12.5 });

    ipc.close();
    await mpv.close();
  });

  it("ignores malformed lines instead of crashing", async () => {
    const mpv = await fakeMpv(() => ({ error: "success", data: 1 }));
    const ipc = new PlayerIpc(mpv.socketPath);
    await ipc.connect();
    mpv.emit("not json");

    await expect(ipc.command("loadfile", "x")).resolves.toBe(1);

    ipc.close();
    await mpv.close();
  });
});
