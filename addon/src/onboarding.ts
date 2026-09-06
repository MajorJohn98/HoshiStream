import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { z } from "zod";

const clientSchema = z.enum(["nuvio", "stremio"]);
const stateSchema = z
  .object({
    version: z.literal(1),
    status: z.enum(["active", "dismissed", "complete"]),
    client: clientSchema,
    clientConfirmed: z.boolean(),
    welcomePending: z.boolean(),
  })
  .strict();
export type OnboardingState = z.infer<typeof stateSchema>;
export const onboardingActionSchema = z.discriminatedUnion("action", [
  z
    .object({ action: z.literal("select-client"), client: clientSchema })
    .strict(),
  z
    .object({ action: z.literal("confirm-client"), client: clientSchema })
    .strict(),
  z.object({ action: z.literal("welcome-shown") }).strict(),
  z.object({ action: z.literal("dismiss") }).strict(),
  z.object({ action: z.literal("resume") }).strict(),
  z.object({ action: z.literal("finish") }).strict(),
]);

export class OnboardingError extends Error {}

export class Onboarding {
  private readonly path: string;
  private readonly firstRun: boolean;
  private state?: OnboardingState;
  private loading?: Promise<OnboardingState>;
  private queue: Promise<void> = Promise.resolve();

  constructor(path: string, firstRun = false) {
    this.path = path;
    this.firstRun = firstRun;
  }

  private load(): Promise<OnboardingState> {
    if (this.state) return Promise.resolve(this.state);
    this.loading ??= (async () => {
      let bytes: Buffer;
      try {
        bytes = await readFile(this.path);
      } catch (error) {
        if (!(
          error instanceof Error &&
          "code" in error &&
          error.code === "ENOENT"
        ))
          throw error;
        const initial: OnboardingState = {
          version: 1,
          status: "active",
          client: "nuvio",
          clientConfirmed: false,
          welcomePending: this.firstRun,
        };
        await this.persist(initial);
        this.state = initial;
        return initial;
      }
      if (bytes.length > 32_000)
        throw new OnboardingError("Setup state is too large.");
      this.state = stateSchema.parse(JSON.parse(bytes.toString("utf8")));
      return this.state;
    })();
    return this.loading;
  }

  private async persist(state: OnboardingState) {
    await mkdir(dirname(this.path), { recursive: true });
    const temporary = `${this.path}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, JSON.stringify(state, null, 2) + "\n", {
        mode: 0o600,
      });
      await rename(temporary, this.path);
    } finally {
      await unlink(temporary).catch((error: unknown) => {
        if (!(
          error instanceof Error &&
          "code" in error &&
          error.code === "ENOENT"
        ))
          console.error(
            JSON.stringify({
              level: "warn",
              event: "onboarding_temp_cleanup_failed",
            }),
          );
      });
    }
  }

  async read() {
    await this.queue;
    return { ...(await this.load()) };
  }

  update(input: z.infer<typeof onboardingActionSchema>, hasMedia: boolean) {
    const result = this.queue.then(async () => {
      const next = { ...(await this.load()) };
      switch (input.action) {
        case "select-client":
          if (next.client !== input.client) {
            next.client = input.client;
            next.clientConfirmed = false;
            next.status = "active";
          }
          break;
        case "confirm-client":
          if (input.client !== next.client)
            throw new OnboardingError(
              "The player selection changed. Review it before confirming.",
            );
          next.clientConfirmed = true;
          break;
        case "welcome-shown":
          next.welcomePending = false;
          break;
        case "dismiss":
          next.status = "dismissed";
          next.welcomePending = false;
          break;
        case "resume":
          next.status = "active";
          next.welcomePending = false;
          break;
        case "finish":
          if (!hasMedia || !next.clientConfirmed)
            throw new OnboardingError(
              "Add a title and confirm it is available in your player before finishing setup.",
            );
          next.status = "complete";
          next.welcomePending = false;
          break;
      }
      await this.persist(next);
      this.state = next;
      return { ...next };
    });
    this.queue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}
