import type { IncomingMessage, ServerResponse } from "node:http";
import type { Archiver } from "./archiver.ts";
import type { ArchiveSchedule } from "./archive-schedule.ts";
import type { DeviceNames } from "./device-names.ts";
import type { DiskCleanup } from "./disk-copy.ts";
import type { Library } from "./library.ts";
import type { LibraryAnalysis } from "./library-analysis.ts";
import type { ImportService } from "./imports/service.ts";
import type { NativePicker } from "./native-picker.ts";
import { Playback } from "./playback.ts";
import type { PointerClient } from "./pointer.ts";
import type { ResourceDirs } from "./resources.ts";
import { bearerToken, validToken } from "./security.ts";
import type { AddonInterface } from "./server-types.ts";
import { setConfiguredSpeed } from "./speedtest.ts";
import type { PublicUrls } from "./streams.ts";
import type { TorrServerClient } from "./torrserver-client.ts";
import type { TranscodeManager } from "./transcode.ts";
import type { VolumeRegistry } from "./volumes.ts";
import {
  reply,
  type HandlerContext,
  type RouteHandler,
  type RouteRequest,
} from "./routes/context.ts";
import { classifyError } from "./routes/errors.ts";
import {
  handleDiskCopy,
  handleDiskJobs,
  handleDiskSchedule,
  handleVolumes,
} from "./routes/disk-api.ts";
import {
  handleInspect,
  handleLibraryCollection,
  handlePlaybackPosition,
  handleLibraryItem,
  handleMediaFiles,
  handleRelink,
  handleStremioRefresh,
} from "./routes/library-api.ts";
import { handleImports } from "./routes/imports-api.ts";
import {
  handleDiskMedia,
  handleHls,
  handleLocalMedia,
} from "./routes/media.ts";
import { handleProtocol, handlePublic } from "./routes/protocol.ts";
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
} from "./routes/system-api.ts";
import { handleTags } from "./routes/tags-api.ts";
import type { Tags } from "./tags.ts";
import { handleSourceCheck } from "./routes/source-check-api.ts";
import type { SourceChecks } from "./source-checks.ts";
import type { Onboarding } from "./onboarding.ts";
import { handleOnboarding } from "./routes/onboarding-api.ts";

export { manageAssetPath, noStoreProtocolResource } from "./routes/protocol.ts";
export { technicalProbeRequested } from "./routes/library-api.ts";

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
  tags?: Tags;
  imports?: ImportService;
  sourceChecks?: SourceChecks;
  onboarding?: Onboarding;
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
  handleOnboarding,
  handleSourceCheck,
  handleImports,
  handleVolumes,
  handleDiskCopy,
  handleDiskJobs,
  handleAnalysis,
  handleDiskSchedule,
  handleLibraryCollection,
  handlePlaybackPosition,
  handleTags,
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
      const { status, message, code } = classifyError(error);
      console.error(
        JSON.stringify({
          level: "error",
          event: "request_failed",
          method: request.method,
          code: code ?? (status < 500 ? "invalid_request" : "internal_error"),
        }),
      );
      reply(response, status, { error: message, ...(code ? { code } : {}) });
    }
  };
}
