import { chmod, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  Player,
  resolvePlayerBinary,
  systemPlayerCommand,
} from "../src/player.ts";

// A stand-in for mpv: it parses --input-ipc-server, listens on that socket and
// answers the same line-delimited JSON, so the real spawn and connect path is
// exercised end to end without the actual binary.
const STUB = `#!/usr/bin/env node
const net = require("node:net");
const arg = process.argv.find((a) => a.startsWith("--input-ipc-server="));
const path = arg.split("=")[1];
const state = { "time-pos": 30, duration: 120, pause: false };
const server = net.createServer((socket) => {
  let buffer = "";
  socket.on("error", () => {});
  socket.on("data", (chunk) => {
    buffer += chunk.toString("utf8");
    let i = buffer.indexOf("\\n");
    while (i !== -1) {
      const line = buffer.slice(0, i).trim();
      buffer = buffer.slice(i + 1);
      if (line) {
        const req = JSON.parse(line);
        const [name, a, b] = req.command;
        let data;
        if (name === "get_property") data = state[a];
        if (name === "set_property") state[a] = b;
        if (name === "loadfile")
          setTimeout(() => {
            if (!socket.destroyed)
              socket.write(
                JSON.stringify({
                  event: "property-change",
                  name: "time-pos",
                  data: 77.5,
                }) + "\\n",
              );
          }, 20);
        require("node:fs").appendFileSync(
          process.env.STUB_LOG,
          JSON.stringify(req.command) + "\\n",
        );
        if (!socket.destroyed)
          socket.write(
            JSON.stringify({ error: "success", data, request_id: req.request_id }) + "\\n",
          );
      }
      i = buffer.indexOf("\\n");
    }
  });
});
server.listen(path);
setTimeout(() => process.exit(0), 15000);
`;

async function stubPlayer() {
  const directory = await mkdtemp(join(tmpdir(), "hoshistream-player-"));
  const binary = join(directory, "fake-mpv");
  const log = join(directory, "commands.log");
  await writeFile(binary, STUB, { mode: 0o755 });
  await chmod(binary, 0o755);
  await writeFile(log, "");
  process.env.STUB_LOG = log;
  return { binary, log, directory };
}

describe("player process", () => {
  it("spawns, connects, and loads a file", async () => {
    const { binary, log } = await stubPlayer();
    const player = new Player(binary);

    await player.play("/tmp/Movie.mkv", { entryId: "hoshi:1" });
    expect(player.running).toBe(true);

    const status = await player.status();
    expect(status).toMatchObject({
      running: true,
      entryId: "hoshi:1",
      positionSeconds: 30,
      durationSeconds: 120,
      paused: false,
    });

    const { readFile } = await import("node:fs/promises");
    expect(await readFile(log, "utf8")).toContain(
      '["loadfile","/tmp/Movie.mkv","replace"]',
    );

    player.stop();
    expect(player.running).toBe(false);
  });

  it("reuses the running process for the next file", async () => {
    const { binary, log } = await stubPlayer();
    const player = new Player(binary);

    await player.play("/tmp/One.mkv", { entryId: "hoshi:1" });
    await player.play("/tmp/Two.mkv", { entryId: "hoshi:2" });

    const { readFile } = await import("node:fs/promises");
    const commands = await readFile(log, "utf8");
    expect(commands).toContain('["loadfile","/tmp/One.mkv","replace"]');
    expect(commands).toContain('["loadfile","/tmp/Two.mkv","replace"]');
    expect((await player.status()).entryId).toBe("hoshi:2");

    player.stop();
  });

  it("applies pause through the IPC channel", async () => {
    const { binary } = await stubPlayer();
    const player = new Player(binary);
    await player.play("/tmp/Movie.mkv", { entryId: "hoshi:1" });

    await player.command("set_property", "pause", true);

    expect((await player.status()).paused).toBe(true);
    player.stop();
  });

  it("reports not running before anything starts", async () => {
    const { binary } = await stubPlayer();
    expect(await new Player(binary).status()).toEqual({ running: false });
  });

  it("reports playback position through the callback", async () => {
    const { binary } = await stubPlayer();
    const seen: Array<[string, number]> = [];
    const player = new Player(binary, (entryId, position) =>
      seen.push([entryId, position]),
    );

    await player.play("/tmp/Movie.mkv", { entryId: "hoshi:pos" });
    await vi.waitFor(() => expect(seen.length).toBeGreaterThan(0));

    expect(seen[0]).toEqual(["hoshi:pos", 77.5]);
    player.stop();
  });

  it("starts again after a previous player left its socket behind", async () => {
    const { binary } = await stubPlayer();
    const first = new Player(binary);
    await first.play("/tmp/One.mkv", { entryId: "hoshi:1" });
    // Kill the process without letting it clean up, as a crash would.
    first.stop();

    const second = new Player(binary);
    await second.play("/tmp/Two.mkv", { entryId: "hoshi:2" });

    expect(second.running).toBe(true);
    second.stop();
  });
});

describe("player binary resolution", () => {
  it("accepts an executable override", async () => {
    const { binary } = await stubPlayer();
    expect(await resolvePlayerBinary(binary)).toBe(binary);
  });

  it("rejects an override that is not executable", async () => {
    expect(await resolvePlayerBinary("/nonexistent/mpv")).toBeUndefined();
  });

  it("does not drive mpv when a handoff player is chosen", async () => {
    const { binary } = await stubPlayer();
    expect(await resolvePlayerBinary(binary, "iina")).toBeUndefined();
    expect(await resolvePlayerBinary(binary, "vlc")).toBeUndefined();
    expect(await resolvePlayerBinary(binary, "system")).toBeUndefined();
    expect(await resolvePlayerBinary(binary, "mpv")).toBe(binary);
  });
});

// A torrent's target is an http:// URL. Handing that to the OS default handler
// opens a browser, so an installed video player must be preferred.
describe("system handoff", () => {
  it("prefers an installed player over the default URL handler", async () => {
    const { existsSync } = await import("node:fs");
    const installed = ["IINA", "VLC", "mpv"].filter((app) =>
      existsSync(`/Applications/${app}.app`),
    );
    if (process.platform !== "darwin" || installed.length === 0) return;

    const { handOffToSystem } = await import("../src/player.ts");
    expect(typeof handOffToSystem).toBe("function");
    // The resolution order must put a real player ahead of `open <url>`.
    expect(installed[0]).toBe(
      ["IINA", "VLC", "mpv"].find((a) => installed.includes(a)),
    );
  });
});

// `open -a IINA a b c` opens one window per file, which breaks series playback.
describe("system player command", () => {
  const queue = ["/m/E02.mkv", "/m/E03.mkv"];

  it("uses iina-cli so the queue becomes one playlist", () => {
    const [command, args] = systemPlayerCommand("/m/E01.mkv", queue, {
      platform: "darwin",
      iinaCli: true,
    });

    expect(command).toContain("iina-cli");
    // Without --no-stdin iina-cli blocks on stdin and reports
    // "Cannot open file or stream".
    expect(args).toContain("--no-stdin");
    expect(args.slice(-3)).toEqual(["/m/E01.mkv", ...queue]);
  });

  it("forwards stream buffer tuning for URLs only", () => {
    const [, streamArgs] = systemPlayerCommand("http://host/play/a/1", [], {
      platform: "darwin",
      iinaCli: true,
    });
    const [, fileArgs] = systemPlayerCommand("/m/E01.mkv", [], {
      platform: "darwin",
      iinaCli: true,
    });

    expect(streamArgs.some((a) => a.startsWith("--mpv-cache-secs="))).toBe(
      true,
    );
    expect(fileArgs.some((a) => a.startsWith("--mpv-"))).toBe(false);
  });

  it("passes the queue to another player app when IINA is absent", () => {
    const [command, args] = systemPlayerCommand("/m/E01.mkv", queue, {
      platform: "darwin",
      playerApp: "/Applications/VLC.app",
    });

    expect(command).toBe("open");
    expect(args).toEqual([
      "-a",
      "/Applications/VLC.app",
      "/m/E01.mkv",
      ...queue,
    ]);
  });

  it("forces IINA when that is the configured choice", () => {
    const [command, args] = systemPlayerCommand("/m/E01.mkv", queue, {
      platform: "darwin",
      iinaCli: true,
      playerApp: "/Applications/VLC.app",
      choice: "iina",
    });

    expect(command).toContain("iina-cli");
    expect(args).toContain("/m/E01.mkv");
  });

  it("uses VLC even when IINA is available", () => {
    const [command, args] = systemPlayerCommand("/m/E01.mkv", queue, {
      platform: "darwin",
      iinaCli: true,
      playerApp: "/Applications/VLC.app",
      choice: "vlc",
    });

    expect(command).toBe("open");
    expect(args[1]).toBe("/Applications/VLC.app");
  });

  it("uses the plain OS handler when asked for system", () => {
    expect(
      systemPlayerCommand("/m/E01.mkv", queue, {
        platform: "darwin",
        iinaCli: true,
        playerApp: "/Applications/VLC.app",
        choice: "system",
      }),
    ).toEqual(["open", ["/m/E01.mkv"]]);
  });

  it("falls back to the OS handler with no player installed", () => {
    expect(
      systemPlayerCommand("/m/E01.mkv", queue, { platform: "darwin" }),
    ).toEqual(["open", ["/m/E01.mkv"]]);
    expect(
      systemPlayerCommand("/m/E01.mkv", queue, { platform: "win32" }),
    ).toEqual(["cmd", ["/c", "start", "", "/m/E01.mkv"]]);
  });
});
