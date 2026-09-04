import { createConnection, type Socket } from "node:net";
import { z } from "zod";

// mpv's JSON IPC is line-delimited. Replies carry the request_id they answer;
// anything without one is an asynchronous event.
const replySchema = z.object({
  request_id: z.number().int(),
  error: z.string(),
  data: z.unknown().optional(),
});
const eventSchema = z.object({ event: z.string() }).passthrough();

export class PlayerIpcError extends Error {}

type Pending = {
  resolve: (data: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
};

export class PlayerIpc {
  private socket?: Socket;
  private buffer = "";
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private readonly listeners = new Set<
    (event: string, payload: unknown) => void
  >();
  private readonly socketPath: string;
  private readonly timeoutMs: number;

  constructor(socketPath: string, timeoutMs = 5_000) {
    this.socketPath = socketPath;
    this.timeoutMs = timeoutMs;
  }

  get connected(): boolean {
    return Boolean(this.socket && !this.socket.destroyed);
  }

  async connect(retries = 40, delayMs = 100): Promise<void> {
    for (let attempt = 1; ; attempt += 1) {
      try {
        this.socket = await this.open();
        this.socket.setEncoding("utf8");
        this.socket.on("data", (chunk: string) => this.consume(chunk));
        this.socket.on("close", () => this.failAll("Player connection closed"));
        this.socket.on("error", () => undefined);
        return;
      } catch (error) {
        if (attempt >= retries) {
          throw new PlayerIpcError(
            `Could not reach the player socket: ${error instanceof Error ? error.message : error}`,
          );
        }
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
    }
  }

  private open(): Promise<Socket> {
    return new Promise((resolve, reject) => {
      const socket = createConnection(this.socketPath);
      socket.once("connect", () => {
        socket.removeAllListeners("error");
        resolve(socket);
      });
      socket.once("error", reject);
    });
  }

  onEvent(listener: (event: string, payload: unknown) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  command(...command: Array<string | number | boolean>): Promise<unknown> {
    if (!this.socket || this.socket.destroyed)
      return Promise.reject(new PlayerIpcError("Player is not running"));
    const requestId = this.nextId++;
    const socket = this.socket;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        reject(new PlayerIpcError("Player did not answer in time"));
      }, this.timeoutMs);
      this.pending.set(requestId, { resolve, reject, timer });
      socket.write(`${JSON.stringify({ command, request_id: requestId })}\n`);
    });
  }

  async property(name: string): Promise<unknown> {
    return this.command("get_property", name);
  }

  close(): void {
    this.failAll("Player stopped");
    this.socket?.destroy();
    this.socket = undefined;
  }

  private consume(chunk: string): void {
    this.buffer += chunk;
    let index = this.buffer.indexOf("\n");
    while (index !== -1) {
      const line = this.buffer.slice(0, index).trim();
      this.buffer = this.buffer.slice(index + 1);
      if (line) this.dispatch(line);
      index = this.buffer.indexOf("\n");
    }
  }

  private dispatch(line: string): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      return;
    }
    const reply = replySchema.safeParse(parsed);
    if (reply.success) {
      const pending = this.pending.get(reply.data.request_id);
      if (!pending) return;
      this.pending.delete(reply.data.request_id);
      clearTimeout(pending.timer);
      if (reply.data.error === "success") pending.resolve(reply.data.data);
      else pending.reject(new PlayerIpcError(reply.data.error));
      return;
    }
    const event = eventSchema.safeParse(parsed);
    if (event.success) {
      for (const listener of this.listeners)
        listener(event.data.event, event.data);
    }
  }

  private failAll(reason: string): void {
    for (const [, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(new PlayerIpcError(reason));
    }
    this.pending.clear();
  }
}
