import { createServer } from "node:http";
import { pathToFileURL } from "node:url";
import { createAddon } from "./addon.ts";
import { config } from "./config.ts";
import { ImportService } from "./imports/service.ts";
import { Library } from "./library.ts";
import { NativePicker } from "./native-picker.ts";
import { Playback } from "./playback.ts";
import { PlaybackProbes } from "./playback-probes.ts";
import {
  PlaybackTelemetry,
  setStreamTargetBitrate,
} from "./playback-telemetry.ts";
import { createHandler } from "./routes.ts";
import { TorrServerClient } from "./torrserver-client.ts";
import { TranscodeManager, detectVideoEncoder } from "./transcode.ts";
import { MdnsResponder } from "./mdns.ts";
import { PointerClient } from "./pointer.ts";
import { PointerDriftMonitor } from "./pointer-drift.ts";
import { DeviceNames } from "./device-names.ts";
import { Tags } from "./tags.ts";
import { IdentityStore } from "./identity.ts";
import { SubtitleService } from "./subtitle-service.ts";
import { ThumbnailService } from "./thumbnail-service.ts";
import { ArtworkCache } from "./artwork-cache.ts";
import { CinemetaClient } from "./cinemeta.ts";
import { MetadataEnrichment } from "./metadata-enrichment.ts";
import { MetadataSettingsStore } from "./metadata-settings.ts";
import { releaseInfo } from "./release.ts";
import { runSpeedTest, stopSpeedTest } from "./speedtest.ts";
import { VolumeRegistry } from "./volumes.ts";
import { DiskCleanup } from "./disk-copy.ts";
import { Archiver } from "./archiver.ts";
import { ArchiveSchedule } from "./archive-schedule.ts";
import { defaultAnalyzer, LibraryAnalysis } from "./library-analysis.ts";
import { SourceChecks } from "./source-checks.ts";
import { Onboarding } from "./onboarding.ts";
import { WatchProgress, WatchStates } from "./watch-state.ts";
import { installConsoleTap, LogRing } from "./diagnostics.ts";

// How long an in-flight response — a stream in progress — may keep the server
// open during shutdown before its socket is destroyed.
const SHUTDOWN_GRACE_MS = 3_000;

export async function startHoshiStream(settings = config) {
  // Keep the last console lines in memory for the diagnostics bundle.
  const logs = new LogRing();
  const restoreConsole = installConsoleTap(logs);
  const library = new Library(settings.LIBRARY_PATH);
  let onboarding: Onboarding | undefined;
  try {
    onboarding = new Onboarding(
      settings.ONBOARDING_PATH,
      settings.ONBOARDING_FIRST_RUN,
    );
    await onboarding.read();
  } catch {
    onboarding = undefined;
    console.error(
      JSON.stringify({
        level: "error",
        event: "onboarding_unavailable",
        message:
          "Setup state could not be loaded. The library remains available.",
      }),
    );
  }
  const torrServer = new TorrServerClient(settings.TORRSERVER_INTERNAL_URL);
  const nativePicker = new NativePicker(settings.NATIVE_PICKER_SOCKET);
  const tags = new Tags(settings.TAGS_PATH);
  const sourceChecks = new SourceChecks(library, torrServer);
  await sourceChecks.initialize();
  const imports = new ImportService({
    library,
    tags,
    torrServer,
    uploadRoot: settings.UPLOAD_ROOT,
  });
  await imports.initialize();
  const volumes = new VolumeRegistry(settings.VOLUMES_PATH);
  const archiveSchedule = new ArchiveSchedule(settings.DISK_SCHEDULE_PATH);
  const thumbnails = new ThumbnailService(library, torrServer, {
    dir: settings.THUMBNAILS_DIR,
    ffmpegPath: settings.FFMPEG_PATH,
    volumes,
  });
  // Opt-in Cinemeta enrichment (ADR 0026). Constructed always so the toggle
  // can be flipped from the UI; nothing leaves the machine until it is on.
  const artwork = new ArtworkCache({
    dir: settings.ARTWORK_DIR,
    userAgent: `HoshiStream/${releaseInfo.version}`,
  });
  const metadata = new MetadataEnrichment({
    library,
    tags,
    settings: new MetadataSettingsStore(settings.METADATA_SETTINGS_PATH),
    client: new CinemetaClient({
      baseUrl: settings.CINEMETA_URL,
      userAgent: `HoshiStream/${releaseInfo.version}`,
    }),
    artwork,
  });
  const archiver = new Archiver(library, torrServer, volumes, {
    schedule: archiveSchedule,
    // A copy just landed: grab its episode frame (Phase 13).
    onEntryArchived: (entryId) => {
      thumbnails.generate(entryId);
    },
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
  const subtitles = new SubtitleService(library, torrServer);
  const addon = createAddon(
    library,
    torrServer,
    settings.PUBLIC_TORRSERVER_URL,
    settings.PUBLIC_ADDON_URL,
    settings.ACCESS_TOKEN,
    subtitles,
  );
  const playback = new Playback(library, torrServer, settings.PLAYER);
  const watch = new WatchStates(library, torrServer);
  // A watch event moves the rolling disk-copy window (Phase 8). The just-
  // played file anchors it; a cleared mark re-plans from the latest state.
  watch.subscribe((entryId, fileId, state) => {
    void archiver
      .applyPolicy(entryId, state === "cleared" ? undefined : fileId)
      .catch(() => undefined);
  });
  const watchProgress = new WatchProgress(watch);
  const telemetry = new PlaybackTelemetry(torrServer, {
    entries: () => library.list(),
    progress: watchProgress,
    // First play of a file measures its bitrate; the fact is kept per file.
    probes: new PlaybackProbes(library, sourceChecks, {
      onBitrate: setStreamTargetBitrate,
    }),
  });
  const analysis = new LibraryAnalysis(library, defaultAnalyzer(sourceChecks));
  const pointer = new PointerClient({
    pointerUrl: settings.POINTER_URL,
    pushSecret: settings.POINTER_PUSH_SECRET,
    token: settings.ACCESS_TOKEN,
    port: settings.ADDON_PORT,
    statePath: settings.POINTER_STATE_PATH,
    settingsPath: settings.POINTER_SETTINGS_PATH,
  });
  const pointerDrift = new PointerDriftMonitor(pointer);
  const server = createServer(
    createHandler({
      library,
      onboarding,
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
      playback,
      subtitles,
      watch,
      watchProgress,
      telemetry,
      transcode,
      resourceDirs: {
        torrentCache: settings.TORRSERVER_CACHE_DIR,
        transcode: settings.TRANSCODE_DIR,
        uploads: settings.UPLOAD_ROOT,
      },
      pointer,
      deviceNames: new DeviceNames(settings.DEVICE_NAMES_PATH),
      tags,
      identity: new IdentityStore(settings.IDENTITY_PATH),
      thumbnails,
      metadata,
      artwork,
      imports,
      sourceChecks,
      volumes,
      diskCleanup: new DiskCleanup(settings.DISK_CLEANUP_PATH),
      archiver,
      archiveSchedule,
      analysis,
      diagnostics: { logs, pushSecret: settings.POINTER_PUSH_SECRET },
    }),
  );
  let mdns: MdnsResponder | undefined;
  let closing = false;
  let closePromise: Promise<void> | undefined;
  const close = (): Promise<void> => {
    closePromise ??= (async () => {
      closing = true;
      mdns?.close();
      pointerDrift.stop();
      playback.stop();
      telemetry.stop();
      const analysisStopped = analysis.cancel();
      server.closeIdleConnections();
      const forceClose = setTimeout(() => {
        server.closeAllConnections();
      }, SHUTDOWN_GRACE_MS);
      forceClose.unref();
      try {
        const httpClosed = server.listening
          ? new Promise<void>((resolve, reject) =>
              server.close((error) => (error ? reject(error) : resolve())),
            )
          : Promise.resolve();
        const results = await Promise.allSettled([
          httpClosed,
          stopSpeedTest(),
          imports.close(),
          sourceChecks.close(),
          analysisStopped,
          archiver.close(),
          transcode?.close(),
        ]);
        const errors = results.flatMap((result) =>
          result.status === "rejected" ? [result.reason] : [],
        );
        if (errors.length)
          throw new AggregateError(errors, "Add-on cleanup failed");
      } finally {
        clearTimeout(forceClose);
        restoreConsole();
      }
    })();
    return closePromise;
  };
  try {
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
    if (settings.MDNS_ENABLED) {
      mdns = new MdnsResponder({ port: settings.ADDON_PORT });
      mdns.start();
    }
    await archiver.start();
    telemetry.start();
    pointerDrift.start();
    void runSpeedTest().catch((error: unknown) => {
      if (!closing)
        console.error(
          JSON.stringify({
            level: "warn",
            event: "speedtest_failed",
            error: error instanceof Error ? error.message : String(error),
          }),
        );
    });
    return { close };
  } catch (error) {
    try {
      await close();
    } catch {
      console.error(
        JSON.stringify({ level: "error", event: "startup_cleanup_failed" }),
      );
    }
    throw error;
  }
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
