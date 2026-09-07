import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  Player,
  resolvePlayerBinary,
  systemPlayerCommand,
  bundledPlayerPath,
} from "../src/player.ts";

// A stand-in for mpv: it parses --input-ipc-server, listens on that socket and
// answers the same line-delimited JSON, so the real spawn and connect path is
// exercised end to end without the actual binary.
const STUB = `
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
        if (name === "seek") state["time-pos"] = a;
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
            JSON.stringify({ error: a === "reject:queue" ? "load failed" : "success", data, request_id: req.request_id }) + "\\n",
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
  directories.push(directory);
  const script = join(directory, "fake-mpv.cjs");
  const log = join(directory, "commands.log");
  await writeFile(script, STUB);
  await writeFile(log, "");
  vi.stubEnv("STUB_LOG", log);
  const makePlayer = (onPosition?: ConstructorParameters<typeof Player>[1]) => {
    const player = new Player(process.execPath, onPosition, [script]);
    players.push(player);
    return player;
  };
  return { binary: process.execPath, log, directory, makePlayer };
}

const players: Player[] = [];
const directories: string[] = [];
afterEach(async () => {
  for (const player of players.splice(0)) player.stop();
  vi.unstubAllEnvs();
  for (const directory of directories.splice(0))
    await rm(directory, {
      recursive: true,
      force: true,
      maxRetries: 10,
      retryDelay: 50,
    });
});

describe("player process", () => {
  it("spawns, connects, and loads a file", async () => {
    const { makePlayer, log } = await stubPlayer();
    const player = makePlayer();

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
    const { makePlayer, log } = await stubPlayer();
    const player = makePlayer();

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
    const { makePlayer } = await stubPlayer();
    const player = makePlayer();
    await player.play("/tmp/Movie.mkv", { entryId: "hoshi:1" });

    await player.command("set_property", "pause", true);

    expect((await player.status()).paused).toBe(true);
    await player.command("set_property", "pause", false);
    await player.command("seek", 65, "absolute");
    expect(await player.status()).toMatchObject({
      paused: false,
      positionSeconds: 65,
    });
    player.stop();
  });

  it("reports not running before anything starts", async () => {
    const { makePlayer } = await stubPlayer();
    expect(await makePlayer().status()).toEqual({ running: false });
  });

  it("reports playback position through the callback", async () => {
    const { makePlayer } = await stubPlayer();
    const seen: Array<[string, number]> = [];
    const player = makePlayer((entryId, position) =>
      seen.push([entryId, position]),
    );

    await player.play("/tmp/Movie.mkv", { entryId: "hoshi:pos" });
    await vi.waitFor(() => expect(seen.length).toBeGreaterThan(0));

    expect(seen[0]).toEqual(["hoshi:pos", 77.5]);
    player.stop();
  });

  it("starts again after a previous player left its socket behind", async () => {
    const { makePlayer } = await stubPlayer();
    const first = makePlayer();
    await first.play("/tmp/One.mkv", { entryId: "hoshi:1" });
    // Kill the process without letting it clean up, as a crash would.
    first.stop();

    const second = makePlayer();
    await second.play("/tmp/Two.mkv", { entryId: "hoshi:2" });

    expect(second.running).toBe(true);
    second.stop();
  });

  it("preserves Windows queue paths as JSON and restarts the same controller", async () => {
    const { makePlayer, log } = await stubPlayer();
    const player = makePlayer();
    const target = "E:\\M\u00e9dia & Films\\Show\\Episode 1.mkv";
    const queue = [
      "E:\\M\u00e9dia & Films\\Show\\Episode 2.mkv",
      "http://127.0.0.1/play?a=1&b=%20",
    ];
    await player.play(target, { entryId: "hoshi:queue", fileId: 1 }, queue);
    const commands = (await readFile(log, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(commands).toContainEqual(["loadfile", target, "replace"]);
    expect(commands).toContainEqual(["loadfile", queue[0], "append"]);
    expect(commands).toContainEqual(["loadfile", queue[1], "append"]);
    player.stop();
    await player.play(queue[0], { entryId: "hoshi:queue", fileId: 2 });
    expect(await player.status()).toMatchObject({ running: true, fileId: 2 });
  });

  it("surfaces queue failures rather than silently dropping episodes", async () => {
    const { makePlayer } = await stubPlayer();
    const player = makePlayer();
    await expect(
      player.play("E:\\Movie.mkv", { entryId: "hoshi:queue-failure" }, [
        "reject:queue",
      ]),
    ).rejects.toThrow("load failed");
    expect(await player.status()).toMatchObject({
      entryId: "hoshi:queue-failure",
    });
  });
});

describe("player binary resolution", () => {
  it("locates mpv at the runtime root in both source and dist layouts", () => {
    const root = resolve("runtime with spaces");
    for (const layout of ["src/player.ts", "dist/player.js"]) {
      const url = pathToFileURL(join(root, "addon", layout)).href;
      expect(bundledPlayerPath(url, "win32", "x64")).toBe(
        join(root, "vendor", "mpv", "win32-x64", "mpv.exe"),
      );
      expect(bundledPlayerPath(url, "darwin", "arm64")).toBe(
        join(root, "vendor", "mpv", "darwin-arm64", "mpv"),
      );
    }
  });
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
    const target = 'E:\\Film & %PATH%\\$(not-a-command) "quoted".mkv';
    const [command, args] = systemPlayerCommand(target, queue, {
      platform: "win32",
    });
    expect(command).toMatch(/powershell\.exe$/);
    expect(args).toContain("-NoProfile");
    expect(args.join(" ")).not.toContain(target);
    expect(args.at(-1)).toContain("$env:HOSHISTREAM_PLAYER_TARGET");
    expect(args.at(-1)).toContain("UseShellExecute = $true");
  });
});
