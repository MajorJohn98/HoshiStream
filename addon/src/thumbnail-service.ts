// Episode thumbnails (Phase 13): one JPEG frame per episode, grabbed with
// the vendored ffmpeg from files that already live on disk — a local folder
// or a completed disk copy. Never from a live torrent: a grab over /play
// would pull pieces the viewer did not ask for. Frames live under
// THUMBNAILS_DIR/<base64url(entryId)>/<season>/<episode>.jpg and are served
// by handleThumbnail with a long cache lifetime.
import { execFile } from "node:child_process";
import { mkdir, readdir, rename, rm, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { destinationPath, sourceKey } from "./disk-copy.ts";
import { resolveStreamSource } from "./inspection.ts";
import type { Library } from "./library.ts";
import { inspectLocalEntry } from "./local-media.ts";
import type { SelectedFile } from "./media-file-selection.ts";
import { containsPath } from "./path-safety.ts";
import type { TorrServerClient } from "./torrserver-client.ts";
import type { LibraryEntry } from "./types.ts";
import type { VolumeRegistry } from "./volumes.ts";

const execFileAsync = promisify(execFile);
const FRAME_TIMEOUT_MS = 60_000;
const PROBE_TIMEOUT_MS = 15_000;
const SEEK_FRACTION = 0.2;
const FALLBACK_SEEK_SECONDS = 60;
export const THUMBNAIL_WIDTH = 480;

export interface ThumbnailServiceOptions {
  dir: string;
  ffmpegPath?: string;
  ffprobePath?: string;
  volumes?: VolumeRegistry;
  // Injectable process runner for tests.
  run?: (
    command: string,
    args: string[],
    options: { timeout: number },
  ) => Promise<unknown>;
}

export interface ThumbnailStatus {
  running: boolean;
  generated: number;
  failed: number;
  lastError?: string;
  finishedAt?: string;
}

export interface EpisodeOnDisk {
  file: SelectedFile;
  season: number;
  episode: number;
  localPath: string;
}

export interface EpisodeSlot {
  season: number;
  episode: number;
}

function folderFor(entryId: string): string {
  return Buffer.from(entryId, "utf8").toString("base64url");
}

export class ThumbnailService {
  private readonly dir: string;
  private readonly ffmpegPath: string;
  private readonly ffprobePath: string;
  private readonly volumes?: VolumeRegistry;
  private readonly run: NonNullable<ThumbnailServiceOptions["run"]>;
  private readonly status = new Map<string, ThumbnailStatus>();
  private queue: Promise<void> = Promise.resolve();
  private readonly library: Library;
  private readonly torrServer: TorrServerClient;

  constructor(
    library: Library,
    torrServer: TorrServerClient,
    options: ThumbnailServiceOptions,
  ) {
    this.library = library;
    this.torrServer = torrServer;
    this.dir = resolve(options.dir);
    this.ffmpegPath = options.ffmpegPath ?? "ffmpeg";
    this.ffprobePath =
      options.ffprobePath ?? process.env.FFPROBE_PATH ?? "ffprobe";
    this.volumes = options.volumes;
    this.run =
      options.run ??
      ((command, args, runOptions) =>
        execFileAsync(command, args, {
          ...runOptions,
          maxBuffer: 1024 * 1024,
        }));
  }

  /** Absolute path of a frame; season/episode must already be integers. */
  pathFor(entryId: string, season: number, episode: number): string {
    const path = resolve(
      this.dir,
      folderFor(entryId),
      String(season),
      `${episode}.jpg`,
    );
    if (!containsPath(this.dir, path)) throw new Error("Thumbnail path escape");
    return path;
  }

  async has(
    entryId: string,
    season: number,
    episode: number,
  ): Promise<boolean> {
    return (await this.statFrame(entryId, season, episode)) !== undefined;
  }

  async statFrame(
    entryId: string,
    season: number,
    episode: number,
  ): Promise<{ path: string; size: number; mtimeMs: number } | undefined> {
    const path = this.pathFor(entryId, season, episode);
    try {
      const info = await stat(path);
      return info.isFile()
        ? { path, size: info.size, mtimeMs: info.mtimeMs }
        : undefined;
    } catch {
      return undefined;
    }
  }

  /** Every (season, episode) that has a frame on disk for the entry. */
  async available(entryId: string): Promise<EpisodeSlot[]> {
    const root = join(this.dir, folderFor(entryId));
    const slots: EpisodeSlot[] = [];
    let seasons: string[];
    try {
      seasons = await readdir(root);
    } catch {
      return slots;
    }
    for (const season of seasons) {
      if (!/^\d+$/.test(season)) continue;
      let files: string[];
      try {
        files = await readdir(join(root, season));
      } catch {
        continue;
      }
      for (const file of files) {
        const match = /^(\d+)\.jpg$/.exec(file);
        if (match)
          slots.push({ season: Number(season), episode: Number(match[1]) });
      }
    }
    return slots.sort((a, b) => a.season - b.season || a.episode - b.episode);
  }

  statusFor(entryId: string): ThumbnailStatus {
    return (
      this.status.get(entryId) ?? { running: false, generated: 0, failed: 0 }
    );
  }

  /**
   * Episodes whose media is on disk right now: every selected file of a
   * local-folder series, or the completed disk copies of a torrent series
   * whose volume is online. Files without a season/episode never qualify.
   */
  async episodesOnDisk(entry: LibraryEntry): Promise<EpisodeOnDisk[]> {
    if (entry.type !== "series") return [];
    const result: EpisodeOnDisk[] = [];
    if (entry.localFolderPath || entry.localFilePath) {
      const local = await inspectLocalEntry(entry);
      const { selectedFiles } = await resolveStreamSource(
        entry,
        this.torrServer,
        this.library,
      );
      for (const file of selectedFiles) {
        const localPath = local?.files.find((f) => f.id === file.id)?.localPath;
        if (
          localPath &&
          file.season !== undefined &&
          file.episode !== undefined
        )
          result.push({
            file,
            season: file.season,
            episode: file.episode,
            localPath,
          });
      }
      return result;
    }
    const diskCopy = entry.diskCopy;
    const cache = entry.inspectionCache;
    if (!diskCopy || diskCopy.desired !== "keep" || !cache || !this.volumes)
      return [];
    const resolution = await this.volumes.resolve(diskCopy.volumeId);
    if (resolution.state !== "online") return [];
    for (const file of cache.selectedFiles) {
      if (file.season === undefined || file.episode === undefined) continue;
      const key = sourceKey(cache.hash, file);
      const copy = diskCopy.files.find(
        (candidate) => candidate.sourceKey === key,
      );
      if (!copy?.included || copy.state !== "complete") continue;
      try {
        result.push({
          file,
          season: file.season,
          episode: file.episode,
          localPath: destinationPath(
            resolution.root,
            diskCopy.relativeDir,
            copy.relativePath,
          ),
        });
      } catch {
        // An unsafe manifest path is the disk library's problem, not ours.
      }
    }
    return result;
  }

  /**
   * Queue a generation run for the entry. Resolves when the run is
   * scheduled, not when it finishes; poll statusFor(). Returns false when a
   * run for the entry is already in progress.
   */
  generate(entryId: string, options: { force?: boolean } = {}): boolean {
    if (this.status.get(entryId)?.running) return false;
    this.status.set(entryId, { running: true, generated: 0, failed: 0 });
    this.queue = this.queue
      .then(() => this.runEntry(entryId, options.force ?? false))
      .catch(() => undefined);
    return true;
  }

  /** Wait for every queued run; tests and shutdown. */
  async idle(): Promise<void> {
    await this.queue;
  }

  async remove(entryId: string): Promise<void> {
    await rm(join(this.dir, folderFor(entryId)), {
      recursive: true,
      force: true,
    });
  }

  private async runEntry(entryId: string, force: boolean): Promise<void> {
    const status: ThumbnailStatus = { running: true, generated: 0, failed: 0 };
    this.status.set(entryId, status);
    try {
      const entry = await this.library.get(entryId);
      if (!entry) return;
      for (const episode of await this.episodesOnDisk(entry)) {
        if (
          !force &&
          (await this.has(entryId, episode.season, episode.episode))
        )
          continue;
        try {
          await this.grab(entryId, episode);
          status.generated += 1;
        } catch (error) {
          status.failed += 1;
          status.lastError =
            error instanceof Error ? error.message : String(error);
        }
      }
    } catch (error) {
      status.lastError = error instanceof Error ? error.message : String(error);
    } finally {
      status.running = false;
      status.finishedAt = new Date().toISOString();
      console.log(
        JSON.stringify({
          level: status.failed ? "warn" : "info",
          event: "thumbnails_generated",
          entryId,
          generated: status.generated,
          failed: status.failed,
        }),
      );
    }
  }

  private async durationOf(localPath: string): Promise<number | undefined> {
    try {
      const result = (await this.run(
        this.ffprobePath,
        [
          "-v",
          "error",
          "-show_entries",
          "format=duration",
          "-of",
          "default=noprint_wrappers=1:nokey=1",
          localPath,
        ],
        { timeout: PROBE_TIMEOUT_MS },
      )) as { stdout?: string | Buffer } | undefined;
      const seconds = Number(String(result?.stdout ?? "").trim());
      return Number.isFinite(seconds) && seconds > 0 ? seconds : undefined;
    } catch {
      return undefined;
    }
  }

  private async grab(entryId: string, episode: EpisodeOnDisk): Promise<void> {
    const target = this.pathFor(entryId, episode.season, episode.episode);
    await mkdir(dirname(target), { recursive: true });
    const duration = await this.durationOf(episode.localPath);
    const seek = duration
      ? Math.floor(duration * SEEK_FRACTION)
      : FALLBACK_SEEK_SECONDS;
    const partial = `${target}.partial`;
    await rm(partial, { force: true });
    try {
      await this.run(
        this.ffmpegPath,
        [
          "-hide_banner",
          "-loglevel",
          "error",
          "-nostdin",
          "-y",
          "-ss",
          String(seek),
          "-i",
          episode.localPath,
          "-frames:v",
          "1",
          "-vf",
          `scale=${THUMBNAIL_WIDTH}:-2`,
          "-q:v",
          "4",
          "-f",
          "image2",
          partial,
        ],
        { timeout: FRAME_TIMEOUT_MS },
      );
      const info = await stat(partial);
      if (!info.size) throw new Error("ffmpeg wrote an empty frame");
      await rename(partial, target);
    } finally {
      await rm(partial, { force: true });
    }
  }
}
