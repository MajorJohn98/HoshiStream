import type { Library } from "./library.js";
import type { SelectedFile } from "./media-file-selection.js";
import { markStreamActivity } from "./activity.js";
import { resolveStreamSource } from "./inspection.js";
import type { TorrServerClient } from "./torrserver-client.js";

const episodeId = /^(hoshi:[^:]+):(\d+):(\d+)$/;

export function streamBehaviorHints(entryId: string, file: SelectedFile) {
  return {
    filename: file.path,
    videoSize: file.length,
    bingeGroup: `hoshistream-${entryId}`,
  };
}

export interface PublicUrls {
  addonUrl: string;
  torrServerUrl: string;
}

export function resolvePublicUrls(
  hostHeader: string | undefined,
  fallback: PublicUrls,
): PublicUrls {
  if (!hostHeader) return fallback;
  let requested: URL;
  try {
    requested = new URL(`http://${hostHeader}`);
  } catch {
    return fallback;
  }
  if (
    !requested.hostname ||
    ["addon", "torrserver"].includes(requested.hostname)
  ) {
    return fallback;
  }
  const torrServer = new URL(fallback.torrServerUrl);
  torrServer.hostname = requested.hostname;
  return { addonUrl: requested.origin, torrServerUrl: torrServer.origin };
}

export function rewritePublicUrl(
  internalUrl: string,
  publicBaseUrl: string,
): string {
  const internal = new URL(internalUrl);
  const publicBase = new URL(publicBaseUrl);
  internal.protocol = publicBase.protocol;
  internal.host = publicBase.host;
  return internal.toString();
}

function requestedFile(
  files: SelectedFile[],
  type: string,
  id: string,
): { entryId: string; file?: SelectedFile } {
  if (type !== "series") return { entryId: id, file: files[0] };
  const match = episodeId.exec(id);
  if (!match) return { entryId: id };
  const [, entryId, season, episode] = match;
  return {
    entryId,
    file: files.find(
      (file) =>
        file.season === Number(season) && file.episode === Number(episode),
    ),
  };
}

export async function getStreams(
  library: Library,
  torrServer: TorrServerClient,
  publicTorrServerUrl: string,
  publicAddonUrl: string,
  accessToken: string,
  type: string,
  id: string,
) {
  const requested = requestedFile([], type, id);
  const entry = await library.get(requested.entryId);
  if (!entry || entry.type !== type) return { streams: [] };

  if (entry.localFilePath || entry.localFolderPath) {
    const source = await resolveStreamSource(entry, torrServer, library);
    const file = requestedFile(source.selectedFiles, type, id).file;
    if (!file) return { streams: [] };
    markStreamActivity();
    return {
      streams: [
        {
          name: "HoshiStream",
          description: `Local • ${formatSize(file.length)}`,
          url: `${publicAddonUrl}/local/${encodeURIComponent(accessToken)}/${encodeURIComponent(entry.id)}/${file.id}`,
          behaviorHints: streamBehaviorHints(entry.id, file),
        },
      ],
    };
  }

  const source = await resolveStreamSource(entry, torrServer, library);
  const file = requestedFile(source.selectedFiles, type, id).file;
  if (!file) return { streams: [] };
  markStreamActivity();

  const url = rewritePublicUrl(
    torrServer.streamUrl(source.hash, file),
    publicTorrServerUrl,
  );
  console.log(
    JSON.stringify({
      level: "info",
      event: "stream_generated",
      entryId: entry.id,
      fileId: file.id,
      filename: file.path,
    }),
  );
  return {
    streams: [
      {
        name: "HoshiStream",
        description: `Torrent • ${formatSize(file.length)}`,
        url,
        behaviorHints: streamBehaviorHints(entry.id, file),
      },
    ],
  };
}

function formatSize(bytes: number): string {
  return bytes >= 1_000_000_000
    ? `${(bytes / 1_000_000_000).toFixed(1)} GB`
    : `${Math.round(bytes / 1_000_000)} MB`;
}
