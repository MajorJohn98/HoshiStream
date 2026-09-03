import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { z } from "zod";

// Global download window for the disk-copy archiver: when set, transfers only
// run inside the window (supports overnight wrap, e.g. 23:00–06:00). Checks
// happen between files and retries, so a file already copying finishes even
// if the window closes underneath it.

export const TIME_PATTERN = /^([01]\d|2[0-3]):([0-5]\d)$/;

export function parseTime(value: string): number {
  const match = TIME_PATTERN.exec(value);
  if (!match) throw new SyntaxError("Time must be HH:MM");
  return Number(match[1]) * 60 + Number(match[2]);
}

export function formatTime(minute: number): string {
  const hours = Math.floor(minute / 60) % 24;
  const minutes = minute % 60;
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}`;
}

const windowSchema = z.object({
  startMinute: z.number().int().min(0).max(1439),
  endMinute: z.number().int().min(0).max(1439),
});
const scheduleSchema = z.object({ window: windowSchema.optional() });

export type ArchiveWindow = z.infer<typeof windowSchema>;

export function withinWindow(
  window: ArchiveWindow | undefined,
  date = new Date(),
): boolean {
  if (!window) return true;
  const minute = date.getHours() * 60 + date.getMinutes();
  const { startMinute, endMinute } = window;
  if (startMinute === endMinute) return true;
  return startMinute < endMinute
    ? minute >= startMinute && minute < endMinute
    : minute >= startMinute || minute < endMinute;
}

export function describeWindow(window: ArchiveWindow): string {
  return `${formatTime(window.startMinute)}–${formatTime(window.endMinute)}`;
}

export class ArchiveSchedule {
  #queue: Promise<void> = Promise.resolve();
  #window: ArchiveWindow | undefined;
  #loaded = false;

  constructor(private readonly path: string) {}

  async window(): Promise<ArchiveWindow | undefined> {
    if (!this.#loaded) {
      try {
        this.#window = scheduleSchema.parse(
          JSON.parse(await readFile(this.path, "utf8")),
        ).window;
      } catch {
        this.#window = undefined;
      }
      this.#loaded = true;
    }
    return this.#window;
  }

  async activeNow(date = new Date()): Promise<boolean> {
    return withinWindow(await this.window(), date);
  }

  set(window: ArchiveWindow | undefined): Promise<void> {
    const operation = this.#queue.then(async () => {
      this.#window = window ? windowSchema.parse(window) : undefined;
      this.#loaded = true;
      await mkdir(dirname(this.path), { recursive: true });
      const temporary = `${this.path}.tmp`;
      await writeFile(
        temporary,
        `${JSON.stringify({ window: this.#window }, null, 2)}\n`,
        { mode: 0o600 },
      );
      await rename(temporary, this.path);
    });
    this.#queue = operation.then(
      () => undefined,
      () => undefined,
    );
    return operation;
  }
}
