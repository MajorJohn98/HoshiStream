import { createServer } from "node:http";
import { pathToFileURL } from "node:url";
import { createAddon } from "./addon.js";
import { config } from "./config.js";
import { Library } from "./library.js";
import { NativePicker } from "./native-picker.js";
import { Playback } from "./playback.js";
import { createHandler } from "./routes.js";
import { TorrServerClient } from "./torrserver-client.js";
import { TranscodeManager, detectVideoEncoder } from "./transcode.js";
import { MdnsResponder } from "./mdns.js";
import { runSpeedTest } from "./speedtest.js";

export async function startHoshiStream(settings = config) {
  const library = new Library(settings.LIBRARY_PATH);
  const torrServer = new TorrServerClient(settings.TORRSERVER_INTERNAL_URL);
  const nativePicker = new NativePicker(settings.NATIVE_PICKER_SOCKET);
  let transcode: TranscodeManager | undefined;
  if (settings.TRANSCODE_ENABLED) {
    const videoEncoder = await detectVideoEncoder(settings.FFMPEG_PATH);
    transcode = new TranscodeManager({
      dir: settings.TRANSCODE_DIR,
      ffmpegPath: settings.FFMPEG_PATH,
      maxSessions: settings.TRANSCODE_MAX_SESSIONS,
      videoEncoder,
      videoBitrateMbps: settings.TRANSCODE_VIDEO_BITRATE_MBPS,
    });
    await transcode.start();
    console.log(
      JSON.stringify({
        level: "info",
        event: "transcode_enabled",
        maxSessions: settings.TRANSCODE_MAX_SESSIONS,
        videoEncoder: videoEncoder ?? "none",
      }),
    );
  }
  const addon = createAddon(
    library,
    torrServer,
    settings.PUBLIC_TORRSERVER_URL,
    settings.PUBLIC_ADDON_URL,
    settings.ACCESS_TOKEN,
  );
  const server = createServer(
    createHandler(
      library,
      addon,
      torrServer,
      settings.ACCESS_TOKEN,
      settings.HOME_SPEED_MBPS,
      nativePicker,
      {
        addonUrl: settings.PUBLIC_ADDON_URL,
        torrServerUrl: settings.PUBLIC_TORRSERVER_URL,
      },
      settings.LAN_REDIRECT,
      new Playback(library, torrServer, settings.PLAYER),
      transcode,
      {
        torrentCache: settings.TORRSERVER_CACHE_DIR,
        transcode: settings.TRANSCODE_DIR,
        uploads: settings.UPLOAD_ROOT,
      },
    ),
  );
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(settings.ADDON_PORT, "0.0.0.0", () => {
      server.off("error", reject);
      resolve();
    });
  });
  console.log(
    JSON.stringify({
      level: "info",
      event: "started",
      port: settings.ADDON_PORT,
    }),
  );
  let mdns: MdnsResponder | undefined;
  if (settings.MDNS_ENABLED) {
    mdns = new MdnsResponder({ port: settings.ADDON_PORT });
    mdns.start();
  }
  // Measure the real link speed once at startup; failures keep the
  // configured HOME_SPEED_MBPS fallback and are only logged.
  void runSpeedTest().catch((error: unknown) =>
    console.error(
      JSON.stringify({
        level: "warn",
        event: "speedtest_failed",
        error: error instanceof Error ? error.message : String(error),
      }),
    ),
  );
  return {
    close: async () => {
      mdns?.close();
      await transcode?.close();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    },
  };
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  startHoshiStream().catch((error) => {
    console.error(
      JSON.stringify({
        level: "error",
        event: "startup_failed",
        error: error instanceof Error ? error.message : String(error),
      }),
    );
    process.exitCode = 1;
  });
}
