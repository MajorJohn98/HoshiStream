import type { Library } from "./library.ts";
import { resolveStreamSource } from "./inspection.ts";
import { inspectLocalEntry } from "./local-media.ts";
import {
  handOffToSystem,
  Player,
  PlayerError,
  resolvePlayerBinary,
  type PlayerChoice,
  type PlayerStatus,
} from "./player.ts";
import type { TorrServerClient } from "./torrserver-client.ts";
import type { LibraryEntry } from "./types.ts";

// Writing every position update would rewrite the library JSON several times a
// second, so persist at most this often.
const POSITION_WRITE_INTERVAL_MS = 15_000;

export type PlaybackMode = "mpv" | "system";

export class Playback {
  private player?: Player;
  private mode?: PlaybackMode;
  private lastWrite = 0;
  private readonly library: Library;
  private readonly torrServer: TorrServerClient;
  private readonly choice: PlayerChoice;

  constructor(
    library: Library,
    torrServer: TorrServerClient,
    choice: PlayerChoice = "auto",
  ) {
    this.library = library;
    this.torrServer = torrServer;
    this.choice = choice;
  }

  async play(
    entryId: string,
    requestedFileId?: number,
  ): Promise<{
    mode: PlaybackMode;
    title: string;
    resumedAt?: number;
    queued?: number;
  }> {
    const entry = await this.library.get(entryId);
    if (!entry) throw new PlayerError("Unknown library entry");

    // With no explicit file, resume whichever episode was last played rather
    // than restarting the series from the beginning.
    const fileId = requestedFileId ?? entry.playback?.fileId;
    const { target, title, queue, playingFileId } = await this.resolveTarget(
      entry,
      fileId,
    );

    // A stored position only applies to the file it was recorded against.
    const stored = entry.playback;
    const resumedAt =
      stored && (stored.fileId === undefined || stored.fileId === playingFileId)
        ? stored.positionSeconds
        : undefined;

    const player = await this.ensurePlayer();
    if (!player) {
      await handOffToSystem(target, queue, this.choice);
      this.mode = "system";
      return { mode: "system", title, queued: queue.length };
    }
    await player.play(target, { entryId, fileId: playingFileId, title }, queue);
    if (resumedAt && resumedAt > 10)
      await player
        .command("seek", resumedAt, "absolute")
        .catch(() => undefined);
    this.mode = "mpv";
    return { mode: "mpv", title, resumedAt, queued: queue.length };
  }

  // Local files are handed to the player as a path so playback never touches
  // HTTP, Node, or the range-request machinery at all. Returns the file to play
  // plus the episodes after it, so a series continues without a trip back to
  // the library.
  private async resolveTarget(
    entry: LibraryEntry,
    fileId?: number,
  ): Promise<{
    target: string;
    title: string;
    queue: string[];
    playingFileId?: number;
  }> {
    if (entry.localFilePath || entry.localFolderPath) {
      const inspection = await inspectLocalEntry(entry);
      const ordered = (inspection?.selectedFiles ?? []).flatMap((selected) => {
        const file = inspection?.files.find((f) => f.id === selected.id);
        return file ? [file] : [];
      });
      const found = ordered.findIndex((file) => file.id === fileId);
      const index = found === -1 ? 0 : found;
      const playing = ordered[index];
      if (!playing) throw new PlayerError("No playable local file");
      return {
        target: playing.localPath,
        title: playing.path,
        playingFileId: playing.id,
        queue:
          entry.type === "series"
            ? ordered.slice(index + 1).map((file) => file.localPath)
            : [],
      };
    }
    const source = await resolveStreamSource(
      entry,
      this.torrServer,
      this.library,
    );
    const found = source.selectedFiles.findIndex((file) => file.id === fileId);
    const index = found === -1 ? 0 : found;
    const playing = source.selectedFiles[index];
    if (!playing) throw new PlayerError("No playable file in the torrent");
    return {
      target: this.torrServer.streamUrl(source.hash, playing),
      title: playing.path,
      playingFileId: playing.id,
      queue:
        entry.type === "series"
          ? source.selectedFiles
              .slice(index + 1)
              .map((file) => this.torrServer.streamUrl(source.hash, file))
          : [],
    };
  }

  private async ensurePlayer(): Promise<Player | undefined> {
    if (this.player) return this.player;
    const binary = await resolvePlayerBinary(undefined, this.choice);
    if (!binary) return undefined;
    this.player = new Player(binary, (entryId, positionSeconds, fileId) =>
      this.rememberPosition(entryId, positionSeconds, fileId),
    );
    return this.player;
  }

  private rememberPosition(
    entryId: string,
    positionSeconds: number,
    fileId?: number,
  ): void {
    const now = Date.now();
    if (now - this.lastWrite < POSITION_WRITE_INTERVAL_MS) return;
    this.lastWrite = now;
    void this.library
      .setPlayback(entryId, {
        positionSeconds,
        ...(fileId === undefined ? {} : { fileId }),
        updatedAt: new Date().toISOString(),
      })
      .catch(() => undefined);
  }

  async control(
    action: "pause" | "resume" | "stop" | "seek",
    value?: number,
  ): Promise<void> {
    if (!this.player?.running) throw new PlayerError("Player is not running");
    if (action === "stop") return this.player.stop();
    if (action === "pause") {
      await this.player.command("set_property", "pause", true);
      return;
    }
    if (action === "resume") {
      await this.player.command("set_property", "pause", false);
      return;
    }
    if (typeof value !== "number")
      throw new PlayerError("Seek requires a position");
    await this.player.command("seek", value, "absolute");
  }

  async status(): Promise<PlayerStatus & { mode?: PlaybackMode }> {
    if (!this.player) return { running: false, mode: this.mode };
    return { ...(await this.player.status()), mode: this.mode };
  }

  // Reports what the next play will actually use, so the UI can say so.
  async available(): Promise<boolean> {
    return Boolean(await resolvePlayerBinary(undefined, this.choice));
  }

  get preference(): PlayerChoice {
    return this.choice;
  }

  stop(): void {
    this.player?.stop();
  }
}
