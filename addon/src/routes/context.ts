import type { IncomingMessage, ServerResponse } from "node:http";
import { recordClient } from "../clients.ts";
import type { Archiver } from "../archiver.ts";
import type { ArchiveSchedule } from "../archive-schedule.ts";
import type { DeviceNames } from "../device-names.ts";
import type { DiskCleanup } from "../disk-copy.ts";
import type { Library } from "../library.ts";
import type { LibraryAnalysis } from "../library-analysis.ts";
import type { NativePicker } from "../native-picker.ts";
import type { Playback } from "../playback.ts";
import type { PlaybackTelemetry } from "../playback-telemetry.ts";
import type { PointerClient } from "../pointer.ts";
import type { ResourceDirs } from "../resources.ts";
import type { ImportService } from "../imports/service.ts";
import type { AddonInterface } from "../server-types.ts";
import type { PublicUrls } from "../streams.ts";
import type { SubtitleService } from "../subtitle-service.ts";
import type { Tags } from "../tags.ts";
import type { TorrServerClient } from "../torrserver-client.ts";
import type { TranscodeManager } from "../transcode.ts";
import type { VolumeRegistry } from "../volumes.ts";
import type { SourceChecks } from "../source-checks.ts";
import type { Onboarding } from "../onboarding.ts";

// Everything a route module may need. Optional members are features the
// supervisor can leave unconfigured; routes answer 409 when they are missing.
export interface HandlerContext {
  library: Library;
  addon: AddonInterface;
  torrServer: TorrServerClient;
  accessToken: string;
  nativePicker: NativePicker;
  publicUrls: PublicUrls;
  lanRedirect: "auto" | "off";
  playback: Playback;
  subtitles: SubtitleService;
  telemetry?: PlaybackTelemetry;
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

export interface RouteRequest {
  request: IncomingMessage;
  response: ServerResponse;
  url: URL;
  method: string;
}

// A route returns true once it has written a response, so the dispatcher can
// stop; false means "not mine" and the next route gets a look.
export type RouteHandler = (
  context: HandlerContext,
  route: RouteRequest,
) => Promise<boolean>;

export const JSON_HEADERS = {
  "access-control-allow-origin": "*",
  "content-type": "application/json; charset=utf-8",
};

export function reply(
  response: ServerResponse,
  status: number,
  value: unknown,
): true {
  response.writeHead(status, JSON_HEADERS);
  response.end(status === 204 ? undefined : JSON.stringify(value));
  return true;
}

export function noStoreReply(
  response: ServerResponse,
  status: number,
  value: unknown,
): true {
  response.writeHead(status, {
    ...JSON_HEADERS,
    "cache-control": "no-store, max-age=0",
  });
  response.end(status === 204 ? undefined : JSON.stringify(value));
  return true;
}

export function html(response: ServerResponse, value: string): true {
  response.writeHead(200, {
    "content-security-policy":
      // media-src covers direct play from TorrServer's origin; blob: and
      // worker-src blob: cover hls.js's MediaSource playback of repaired
      // streams in the in-browser player.
      "default-src 'self'; img-src 'self' https: data:; script-src 'self'; style-src 'self'; media-src 'self' http: https: blob:; worker-src 'self' blob:",
    "content-type": "text/html; charset=utf-8",
    "referrer-policy": "no-referrer",
    "x-content-type-options": "nosniff",
  });
  response.end(value);
  return true;
}

export async function body(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 1_000_000) throw new SyntaxError("Request body exceeds 1 MB");
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

export function jsonObjectBody(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new SyntaxError("Invalid request");
  return { ...(value as Record<string, unknown>) };
}

export function observeClient(
  request: IncomingMessage,
  resource: Parameters<typeof recordClient>[2],
): void {
  const tunnelIp = request.headers["cf-connecting-ip"];
  const ip =
    (typeof tunnelIp === "string" ? tunnelIp : undefined) ??
    request.socket.remoteAddress ??
    undefined;
  const userAgent = request.headers["user-agent"];
  recordClient(ip, userAgent, resource);
}

export function isReadMethod(method: string): boolean {
  return method === "GET" || method === "HEAD";
}

export function logInfo(event: string, fields: Record<string, unknown>): void {
  console.log(JSON.stringify({ level: "info", event, ...fields }));
}
