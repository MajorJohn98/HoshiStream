import { Worker } from "node:worker_threads";
import type { z } from "zod";
import { ImportError } from "./errors.ts";

export async function boundedTorrentWorker<T>(
  data: unknown,
  schema: z.ZodType<T>,
  options: {
    memoryMb: number;
    failure: () => ImportError;
    signal?: AbortSignal;
  },
): Promise<T> {
  if (options.signal?.aborted)
    throw new ImportError(
      "import_cancelled",
      "The import request was cancelled.",
      408,
    );
  const env = { ...process.env };
  delete env.WATCH_REPORT_DEPENDENCIES;
  const extension = import.meta.url.endsWith(".ts") ? ".ts" : ".js";
  const worker = new Worker(
    new URL(`./torrent-worker${extension}`, import.meta.url),
    {
      workerData: data,
      env,
      execArgv: [],
      resourceLimits: {
        maxOldGenerationSizeMb: options.memoryMb,
        stackSizeMb: 2,
      },
    },
  );
  let timer: ReturnType<typeof setTimeout> | undefined;
  let abort: (() => void) | undefined;
  try {
    return await new Promise<T>((resolve, reject) => {
      timer = setTimeout(() => reject(options.failure()), 3_000);
      abort = () =>
        reject(
          new ImportError(
            "import_cancelled",
            "The import request was cancelled.",
            408,
          ),
        );
      options.signal?.addEventListener("abort", abort, { once: true });
      worker.once("message", (message: unknown) => {
        const parsed = schema.safeParse(message);
        if (parsed.success) resolve(parsed.data);
        else reject(options.failure());
      });
      worker.once("error", () => reject(options.failure()));
      worker.once("exit", () => reject(options.failure()));
    });
  } finally {
    clearTimeout(timer);
    if (abort) options.signal?.removeEventListener("abort", abort);
    await worker.terminate();
  }
}
