import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { z } from "zod";
import { lanIPv4 } from "./mdns.js";

// Manual "phone-home" for the Vercel pointer server (ADR 0012): the pointer
// record is only updated when the user explicitly triggers a push (menu-bar
// item or management API). The last pushed base URL is persisted so staleness
// survives restarts.

const stateSchema = z.object({
  baseUrl: z.string(),
  pushedAt: z.string(),
});

type PointerState = z.infer<typeof stateSchema>;

export interface PointerStatus {
  configured: boolean;
  manifestUrl?: string;
  currentBaseUrl?: string;
  lastPushedBaseUrl?: string;
  lastPushedAt?: string;
  stale?: boolean;
}

export interface PointerClientOptions {
  pointerUrl: string;
  pushSecret: string;
  token: string;
  port: number;
  statePath: string;
  fetchImpl?: typeof fetch;
  lanIp?: () => string | undefined;
}

export class PointerClient {
  readonly #pointerUrl: string;
  readonly #pushSecret: string;
  readonly #token: string;
  readonly #port: number;
  readonly #statePath: string;
  readonly #fetch: typeof fetch;
  readonly #lanIp: () => string | undefined;
  #state: PointerState | undefined;
  #stateLoaded = false;

  constructor(options: PointerClientOptions) {
    this.#pointerUrl = options.pointerUrl.replace(/\/+$/, "");
    this.#pushSecret = options.pushSecret;
    this.#token = options.token;
    this.#port = options.port;
    this.#statePath = options.statePath;
    this.#fetch = options.fetchImpl ?? fetch;
    this.#lanIp = options.lanIp ?? lanIPv4;
  }

  get manifestUrl(): string {
    return `${this.#pointerUrl}/addon/${encodeURIComponent(this.#token)}/manifest.json`;
  }

  currentBaseUrl(): string | undefined {
    const ip = this.#lanIp();
    return ip ? `http://${ip}:${this.#port}` : undefined;
  }

  async #loadState(): Promise<PointerState | undefined> {
    if (this.#stateLoaded) return this.#state;
    this.#stateLoaded = true;
    try {
      this.#state = stateSchema.parse(
        JSON.parse(await readFile(this.#statePath, "utf8")),
      );
    } catch {
      this.#state = undefined;
    }
    return this.#state;
  }

  async #saveState(state: PointerState): Promise<void> {
    this.#state = state;
    this.#stateLoaded = true;
    await mkdir(dirname(this.#statePath), { recursive: true });
    await writeFile(this.#statePath, `${JSON.stringify(state, null, 2)}\n`, {
      mode: 0o600,
    });
  }

  async status(): Promise<PointerStatus> {
    const state = await this.#loadState();
    const currentBaseUrl = this.currentBaseUrl();
    return {
      configured: true,
      manifestUrl: this.manifestUrl,
      currentBaseUrl,
      lastPushedBaseUrl: state?.baseUrl,
      lastPushedAt: state?.pushedAt,
      stale: !state || state.baseUrl !== currentBaseUrl,
    };
  }

  async push(manifest: unknown): Promise<PointerStatus> {
    const baseUrl = this.currentBaseUrl();
    if (!baseUrl) {
      throw new Error("No LAN IPv4 address detected; cannot push pointer");
    }
    const response = await this.#fetch(`${this.#pointerUrl}/api/pointer`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${this.#pushSecret}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ baseUrl, token: this.#token, manifest }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) {
      throw new Error(`Pointer push failed with status ${response.status}`);
    }
    await this.#saveState({ baseUrl, pushedAt: new Date().toISOString() });
    // The base URL is a private LAN address; the token and secret never
    // appear in logs.
    console.log(
      JSON.stringify({ level: "info", event: "pointer_pushed", baseUrl }),
    );
    return this.status();
  }
}
