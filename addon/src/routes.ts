import type { IncomingMessage, ServerResponse } from "node:http";
import type { Archiver } from "./archiver.js";
import type { ArchiveSchedule } from "./archive-schedule.js";
import type { DeviceNames } from "./device-names.js";
import type { DiskCleanup } from "./disk-copy.js";
import type { Library } from "./library.js";
import type { LibraryAnalysis } from "./library-analysis.js";
import type { NativePicker } from "./native-picker.js";
import { Playback } from "./playback.js";
import type { PointerClient } from "./pointer.js";
import type { ResourceDirs } from "./resources.js";
import { bearerToken, validToken } from "./security.js";
import type { AddonInterface } from "./server-types.js";
import { setConfiguredSpeed } from "./speedtest.js";
import type { PublicUrls } from "./streams.js";
import type { TorrServerClient } from "./torrserver-client.js";
import type { TranscodeManager } from "./transcode.js";
import type { VolumeRegistry } from "./volumes.js";
import {
  reply,
  type HandlerContext,
  type RouteHandler,
  type RouteRequest,
} from "./routes/context.js";
import { classifyError } from "./routes/errors.js";
import {
  handleDiskCopy,
  handleDiskJobs,
  handleDiskSchedule,
  handleVolumes,
} from "./routes/disk-api.js";
import {
  handleInspect,
  handleLibraryCollection,
  handleLibraryItem,
  handleMediaFiles,
  handleRelink,
  handleStremioRefresh,
} from "./routes/library-api.js";
import {
  handleDiskMedia,
  handleHls,
  handleLocalMedia,
} from "./routes/media.js";
import { handleProtocol, handlePublic } from "./routes/protocol.js";
import {
  handleAnalysis,
  handleClients,
  handlePlaybackSessions,
  handlePlayer,
  handlePointer,
  handleResources,
  handleSpeedTest,
  handleStatus,
  handleTranscodeSessions,
} from "./routes/system-api.js";

export { manageAssetPath, noStoreProtocolResource } from "./routes/protocol.js";
export { technicalProbeRequested } from "./routes/library-api.js";

export interface HandlerOptions {
  library: Library;
  addon: AddonInterface;
  torrServer: TorrServerClient;
  accessToken: string;
  homeSpeedMbps: number;
  nativePicker: NativePicker;
  publicUrls: PublicUrls;
  lanRedirect?: "auto" | "off";
  playback?: Playback;
  transcode?: TranscodeManager;
  resourceDirs?: ResourceDirs;
  pointer?: PointerClient;
  deviceNames?: DeviceNames;
  volumes?: VolumeRegistry;
  diskCleanup?: DiskCleanup;
  archiver?: Archiver;
  archiveSchedule?: ArchiveSchedule;
  analysis?: LibraryAnalysis;
}

// Unauthenticated or self-authenticating (token in the path) routes, tried in
// order. Paths are disjoint, so order only affects which regex runs first.
const OPEN_ROUTES: RouteHandler[] = [
  handlePublic,
  handleProtocol,
  handleHls,
  handleLocalMedia,
  handleDiskMedia,
];

// Everything under /api/* requires a bearer token (checked once in the
// dispatcher before any of these run).
const API_ROUTES: RouteHandler[] = [
  handleVolumes,
  handleDiskCopy,
  handleDiskJobs,
  handleAnalysis,
  handleDiskSchedule,
  handleLibraryCollection,
  handleStremioRefresh,
  handlePlayer,
  handleClients,
  handlePlaybackSessions,
  handlePointer,
  handleStatus,
  handleResources,
  handleSpeedTest,
  handleTranscodeSessions,
  handleMediaFiles,
  handleRelink,
  handleInspect,
  handleLibraryItem,
];

async function dispatch(
  routes: RouteHandler[],
  context: HandlerContext,
  route: RouteRequest,
): Promise<boolean> {
  for (const handler of routes) {
    if (await handler(context, route)) return true;
  }
  return false;
}

export function createHandler(options: HandlerOptions) {
  setConfiguredSpeed(options.homeSpeedMbps);
  const context: HandlerContext = {
    ...options,
    lanRedirect: options.lanRedirect ?? "auto",
    playback:
      options.playback ?? new Playback(options.library, options.torrServer),
  };
  return async (request: IncomingMessage, response: ServerResponse) => {
    try {
      const route: RouteRequest = {
        request,
        response,
        url: new URL(request.url ?? "/", "http://localhost"),
        method: request.method ?? "GET",
      };
      if (await dispatch(OPEN_ROUTES, context, route)) return;
      if (route.url.pathname.startsWith("/api/")) {
        if (
          !validToken(
            bearerToken(request.headers.authorization),
            context.accessToken,
          )
        ) {
          return reply(response, 401, { error: "Unauthorized" });
        }
        if (await dispatch(API_ROUTES, context, route)) return;
      }
      reply(response, 404, { error: "Not found" });
    } catch (error) {
      const { status, message } = classifyError(error);
      console.error(
        JSON.stringify({
          level: "error",
          event: "request_failed",
          method: request.method,
          error: error instanceof Error ? error.message : String(error),
        }),
      );
      reply(response, status, { error: message });
    }
  };
}
