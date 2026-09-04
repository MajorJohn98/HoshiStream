import { createServer } from "node:http";
import { pathToFileURL } from "node:url";
import { createAddon } from "./addon.ts";
import { config } from "./config.ts";
import { Library } from "./library.ts";
import { NativePicker } from "./native-picker.ts";
import { Playback } from "./playback.ts";
import { createHandler } from "./routes.ts";
import { TorrServerClient } from "./torrserver-client.ts";
import { TranscodeManager, detectVideoEncoder } from "./transcode.ts";
import { MdnsResponder } from "./mdns.ts";
import { PointerClient } from "./pointer.ts";
import { DeviceNames } from "./device-names.ts";
import { Tags } from "./tags.ts";
import { runSpeedTest } from "./speedtest.ts";
import { VolumeRegistry } from "./volumes.ts";
import { DiskCleanup } from "./disk-copy.ts";
import { Archiver } from "./archiver.ts";
import { ArchiveSchedule } from "./archive-schedule.ts";
import { defaultAnalyzer, LibraryAnalysis } from "./library-analysis.ts";

// How long an in-flight response — a stream in progress — may keep the server
// open during shutdown before its socket is destroyed.
const SHUTDOWN_GRACE_MS = 3_000;

export async function startHoshiStream(settings = config) {
  const library = new Library(settings.LIBRARY_PATH);
  const torrServer = new TorrServerClient(settings.TORRSERVER_INTERNAL_URL);
  const nativePicker = new NativePicker(settings.NATIVE_PICKER_SOCKET);
  const volumes = new VolumeRegistry(settings.VOLUMES_PATH);
  const archiveSchedule = new ArchiveSchedule(settings.DISK_SCHEDULE_PATH);
  const archiver = new Archiver(library, torrServer, volumes, {
    schedule: archiveSchedule,
  });
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
  let pointer: PointerClient | undefined;
  if (settings.POINTER_URL && settings.POINTER_PUSH_SECRET) {
    pointer = new PointerClient({
      pointerUrl: settings.POINTER_URL,
      pushSecret: settings.POINTER_PUSH_SECRET,
      token: settings.ACCESS_TOKEN,
      port: settings.ADDON_PORT,
      statePath: settings.POINTER_STATE_PATH,
    });
  } else if (settings.POINTER_URL) {
    console.error(
      JSON.stringify({
        level: "warn",
        event: "pointer_partially_configured",
        message:
          "Set POINTER_PUSH_SECRET alongside POINTER_URL to enable the remote pointer",
      }),
    );
  }
  const server = createServer(
    createHandler({
      library,
      addon,
      torrServer,
      accessToken: settings.ACCESS_TOKEN,
      homeSpeedMbps: settings.HOME_SPEED_MBPS,
      nativePicker,
      publicUrls: {
        addonUrl: settings.PUBLIC_ADDON_URL,
        torrServerUrl: settings.PUBLIC_TORRSERVER_URL,
      },
      lanRedirect: settings.LAN_REDIRECT,
      playback: new Playback(library, torrServer, settings.PLAYER),
      transcode,
      resourceDirs: {
        torrentCache: settings.TORRSERVER_CACHE_DIR,
        transcode: settings.TRANSCODE_DIR,
        uploads: settings.UPLOAD_ROOT,
      },
      pointer,
      deviceNames: new DeviceNames(settings.DEVICE_NAMES_PATH),
      tags: new Tags(settings.TAGS_PATH),
      volumes,
      diskCleanup: new DiskCleanup(settings.DISK_CLEANUP_PATH),
      archiver,
      archiveSchedule,
      analysis: new LibraryAnalysis(
        library,
        defaultAnalyzer(library, torrServer),
      ),
    }),
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
  // Resume any disk-copy work left outstanding by the previous run.
  await archiver.start();
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
      await archiver.close();
      await transcode?.close();
      // server.close() only stops new connections; it resolves once every
      // socket is gone. Idle keep-alive clients — an open management tab is
      // enough — would otherwise hold the process open indefinitely, which
      // orphaned the daemon whenever the supervisor exited.
      server.closeIdleConnections();
      const forceClose = setTimeout(() => {
        server.closeAllConnections();
      }, SHUTDOWN_GRACE_MS);
      forceClose.unref();
      try {
        await new Promise<void>((resolve, reject) =>
          server.close((error) => (error ? reject(error) : resolve())),
        );
      } finally {
        clearTimeout(forceClose);
      }
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
