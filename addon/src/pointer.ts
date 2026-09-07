import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { z } from "zod";
import { lanIPv4 } from "./mdns.ts";
import {
  pointerSettingsSchema,
  pointerSetupSchema,
  pointerUrlSchema,
  SUGGESTED_POINTER_OPERATOR,
  SUGGESTED_POINTER_URL,
} from "./pointer-config.ts";

export { pointerSetupSchema, pointerUrlSchema } from "./pointer-config.ts";

export type PointerLifecycleState =
  | "disabled"
  | "unconfigured"
  | "recovery-required"
  | "unregistered"
  | "registered"
  | "stale"
  | "expired"
  | "unreachable"
  | "authentication-failed"
  | "not-found"
  | "storage-error";

export class PointerError extends Error {
  readonly code: string;
  readonly state: PointerLifecycleState;
  readonly statusCode: number;

  constructor(
    code: string,
    state: PointerLifecycleState,
    message: string,
    statusCode = 409,
  ) {
    super(message);
    this.name = "PointerError";
    this.code = code;
    this.state = state;
    this.statusCode = statusCode;
  }
}

const failures = {
  "request-incomplete": {
    state: "unreachable",
    message:
      "The last pointer request was not confirmed. Manually check or update the pointer before using it.",
  },
  network: {
    state: "unreachable",
    message:
      "The pointer service could not be reached. Check your connection and endpoint, then retry manually.",
  },
  authentication: {
    state: "authentication-failed",
    message:
      "Pointer authentication failed (401/403). Restore this installation's original push secret from a private backup; do not replace it with another installation's credential.",
  },
  "not-found": {
    state: "not-found",
    message:
      "The service returned 404: the record may be missing or expired, or the push secret may not match. This does not confirm an unregistered pointer. Restore the original credential if needed, then retry manually.",
  },
  "rate-limited": {
    state: "unreachable",
    message:
      "The pointer service is rate limiting requests (429). Wait before trying again manually.",
  },
  "service-error": {
    state: "unreachable",
    message:
      "The pointer service returned an error. Check the endpoint or ask its operator, then retry manually.",
  },
  "invalid-response": {
    state: "unreachable",
    message:
      "The pointer service returned an invalid or incompatible response. Check the endpoint and server version before retrying.",
  },
  redirect: {
    state: "unreachable",
    message:
      "The pointer service redirected the request. Redirects are not followed; configure its direct HTTPS origin.",
  },
  "remote-mismatch": {
    state: "stale",
    message:
      "The remote record no longer matches the last local push. Manually update the pointer before relying on it.",
  },
  "remote-without-local-push": {
    state: "recovery-required",
    message:
      "A remote record exists, but no matching successful local push with expiry is saved. Manually update the pointer using this installation's original credentials before relying on it.",
  },
} as const;
type FailureCode = keyof typeof failures;
const failureSchema = z.enum([
  "request-incomplete",
  "network",
  "authentication",
  "not-found",
  "rate-limited",
  "service-error",
  "invalid-response",
  "redirect",
  "remote-mismatch",
  "remote-without-local-push",
]);
const timestamp = z.iso.datetime({ offset: true });
const hashSchema = z.string().regex(/^[a-f0-9]{64}$/);
const baseUrlSchema = z
  .string()
  .max(2048)
  .refine((value) => {
    if (!/^https?:\/\/[^/?#@\\\s]+$/.test(value)) return false;
    try {
      const url = new URL(value);
      return !url.username && !url.password;
    } catch {
      return false;
    }
  });
const stateSchema = z
  .strictObject({
    version: z.literal(2),
    pointerUrl: pointerUrlSchema,
    tokenHash: hashSchema,
    pushSecretHash: hashSchema,
    baseUrl: baseUrlSchema.optional(),
    pushedAt: timestamp.optional(),
    expiresAt: timestamp.optional(),
    observation: failureSchema.optional(),
    claimAttempted: z.boolean().optional(),
  })
  .refine(
    (value) =>
      Boolean(value.baseUrl) === Boolean(value.pushedAt) &&
      Boolean(value.baseUrl) === Boolean(value.expiresAt),
  );
const legacyStateSchema = z.strictObject({
  baseUrl: baseUrlSchema,
  pushedAt: timestamp,
});
type StoredState = z.infer<typeof stateSchema>;
type LegacyState = z.infer<typeof legacyStateSchema>;
type Settings = z.infer<typeof pointerSettingsSchema>;
const pushResponseSchema = z
  .object({
    ok: z.literal(true),
    updatedAt: timestamp,
    expiresAt: timestamp,
  })
  .refine((value) => Date.parse(value.expiresAt) > Date.parse(value.updatedAt));
const remoteStatusSchema = z
  .object({
    ok: z.literal(true),
    baseUrl: baseUrlSchema,
    updatedAt: timestamp,
    expiresAt: timestamp,
  })
  .refine((value) => Date.parse(value.expiresAt) > Date.parse(value.updatedAt));
const deleteResponseSchema = z.object({ ok: z.literal(true) });

export interface PointerStatus {
  configured: boolean;
  enabled: boolean;
  pointerUrl: string;
  suggestedUrl: string;
  suggestedOperator: string;
  manifestUrl?: string;
  currentBaseUrl?: string;
  lastPushedBaseUrl?: string;
  lastPushedAt?: string;
  expiresAt?: string;
  stale: boolean;
  state: PointerLifecycleState;
  message: string;
  usable: boolean;
}

export interface RemotePointerStatus {
  reachable: boolean;
  registered: boolean;
  baseUrl?: string;
  updatedAt?: string;
  expiresAt?: string;
  state: PointerLifecycleState;
  message: string;
  usable: boolean;
}

export interface PointerClientOptions {
  pointerUrl?: string;
  pushSecret?: string;
  token: string;
  port: number;
  statePath: string;
  settingsPath?: string;
  fetchImpl?: typeof fetch;
  lanIp?: () => string | undefined;
}

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function storageError(): PointerError {
  return new PointerError(
    "storage-error",
    "storage-error",
    "Pointer settings or state could not be read or saved. Check private state permissions or restore a valid backup, then restart. No pointer success is assumed.",
    503,
  );
}

async function readJson(path: string): Promise<unknown> {
  let contents: string;
  try {
    contents = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw storageError();
  }
  try {
    return JSON.parse(contents) as unknown;
  } catch {
    throw storageError();
  }
}

async function writePrivateJson(path: string, value: unknown): Promise<void> {
  const staged = `${path}.${randomUUID()}.pending`;
  try {
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    await writeFile(staged, `${JSON.stringify(value, null, 2)}\n`, {
      mode: 0o600,
      flag: "wx",
    });
    await rename(staged, path);
  } catch {
    throw storageError();
  } finally {
    await rm(staged, { force: true }).catch(() => {
      console.error(
        JSON.stringify({
          level: "warn",
          event: "pointer_temporary_cleanup_failed",
        }),
      );
    });
  }
}

// Everything, including health checks, is explicit. A persisted in-flight marker
// invalidates old success before a request, including across interrupted writes.
export class PointerClient {
  readonly #pushSecret: string | undefined;
  readonly #token: string;
  readonly #port: number;
  readonly #statePath: string;
  readonly #settingsPath: string;
  readonly #fetch: typeof fetch;
  readonly #lanIp: () => string | undefined;
  readonly #initialUrl: string;
  #settings: Settings = { enabled: false, pointerUrl: "" };
  #state: StoredState | undefined;
  #legacyState: LegacyState | undefined;
  #loaded = false;
  #explicitSettings = false;
  #storageFailed = false;
  #queue: Promise<unknown> = Promise.resolve();

  constructor(options: PointerClientOptions) {
    this.#initialUrl = options.pointerUrl ?? "";
    this.#pushSecret = options.pushSecret;
    this.#token = options.token;
    this.#port = options.port;
    this.#statePath = options.statePath;
    this.#settingsPath =
      options.settingsPath ??
      join(dirname(options.statePath), "pointer-settings.json");
    this.#fetch = options.fetchImpl ?? fetch;
    this.#lanIp = options.lanIp ?? lanIPv4;
  }

  #serial<T>(action: () => Promise<T>): Promise<T> {
    const result = this.#queue.then(action);
    this.#queue = result.catch(() => {});
    return result;
  }

  get manifestUrl(): string | undefined {
    const parsed = pointerUrlSchema.safeParse(
      this.#loaded ? this.#settings.pointerUrl : this.#initialUrl,
    );
    return parsed.success
      ? `${parsed.data}/addon/${encodeURIComponent(this.#token)}/manifest.json`
      : undefined;
  }

  currentBaseUrl(): string | undefined {
    const ip = this.#lanIp();
    return ip ? `http://${ip}:${this.#port}` : undefined;
  }

  async #load(): Promise<void> {
    if (this.#storageFailed) throw storageError();
    if (this.#loaded) return;
    const savedSettings = await readJson(this.#settingsPath);
    const settings = pointerSettingsSchema.safeParse(
      savedSettings === undefined
        ? {
            enabled: Boolean(this.#initialUrl),
            pointerUrl: this.#initialUrl,
          }
        : savedSettings,
    );
    if (!settings.success) throw storageError();
    const savedState = await readJson(this.#statePath);
    let state: StoredState | undefined;
    let legacy: LegacyState | undefined;
    if (savedState !== undefined) {
      const parsed = stateSchema.safeParse(savedState);
      if (parsed.success) state = parsed.data;
      else {
        const previous = legacyStateSchema.safeParse(savedState);
        if (!previous.success) throw storageError();
        legacy = previous.data;
      }
    }
    this.#settings = settings.data;
    this.#explicitSettings = savedSettings !== undefined;
    this.#state = state;
    this.#legacyState = legacy;
    this.#loaded = true;
  }

  #identityMatches(): boolean {
    return (
      this.#state?.pointerUrl === this.#settings.pointerUrl &&
      this.#state.tokenHash === hash(this.#token) &&
      this.#state.pushSecretHash === hash(this.#pushSecret ?? "")
    );
  }

  #snapshot(): PointerStatus {
    const { enabled, pointerUrl } = this.#settings;
    const currentBaseUrl = this.currentBaseUrl();
    const credentialsValid =
      Boolean(this.#pushSecret && this.#pushSecret.length >= 20) &&
      this.#token.length >= 20 &&
      !/[\r\n]/.test(this.#pushSecret ?? "");
    const configured = enabled && Boolean(pointerUrl) && credentialsValid;
    const matched = this.#identityMatches();
    const record = matched ? this.#state : undefined;
    let state: PointerLifecycleState;
    let message: string;
    if (!enabled) {
      state =
        pointerUrl || this.#explicitSettings ? "disabled" : "unconfigured";
      message =
        state === "disabled"
          ? "Pointer participation is disabled. No service requests are made; disabling does not delete an existing remote record."
          : "Choose a pointer service and explicitly enable it, or keep using your direct LAN URL.";
    } else if (!pointerUrl) {
      state = "unconfigured";
      message = "Choose a pointer service before manually updating it.";
    } else if (!credentialsValid) {
      state = "recovery-required";
      message =
        "The installation's private pointer credential is missing or invalid. Restore its original push secret from a private backup; endpoint setup is saved without generating or replacing credentials.";
    } else if (this.#state && !matched) {
      state = "recovery-required";
      message =
        "Saved pointer state belongs to a different endpoint or installation credential. Restore its original endpoint, access token and push secret before managing that record; no success is assumed.";
    } else if (this.#legacyState) {
      state = "recovery-required";
      message =
        "Legacy pointer state has no verified endpoint, credential identity or expiry. Manually update or remove it using the original endpoint and credentials before relying on the pointer.";
    } else if (record?.observation) {
      ({ state, message } = failures[record.observation]);
    } else if (!record?.baseUrl) {
      state = "unregistered";
      message =
        "No successful manual push is saved for this installation and endpoint. Update the pointer to register it; remote registration has not been checked.";
    } else if (Date.parse(record.expiresAt!) <= Date.now()) {
      state = "expired";
      message = "The saved pointer has expired. Manually update it to renew.";
    } else if (!currentBaseUrl || record.baseUrl !== currentBaseUrl) {
      state = "stale";
      message =
        "The saved pointer does not match the current LAN address. Connect to your LAN and manually update it.";
    } else {
      state = "registered";
      message =
        "The last confirmed manual push matches this LAN address and has not expired. The service is not checked automatically.";
    }
    return {
      configured,
      enabled,
      pointerUrl,
      suggestedUrl: SUGGESTED_POINTER_URL,
      suggestedOperator: SUGGESTED_POINTER_OPERATOR,
      manifestUrl: pointerUrl ? this.manifestUrl : undefined,
      currentBaseUrl,
      lastPushedBaseUrl: record?.baseUrl,
      lastPushedAt: record?.pushedAt,
      expiresAt: record?.expiresAt,
      stale: state !== "registered",
      state,
      message,
      usable: state === "registered",
    };
  }

  status(): Promise<PointerStatus> {
    return this.#serial(async () => {
      await this.#load();
      return this.#snapshot();
    });
  }

  configure(input: z.input<typeof pointerSetupSchema>): Promise<PointerStatus> {
    return this.#serial(async () => {
      await this.#load();
      const parsed = pointerSetupSchema.safeParse(input);
      if (!parsed.success)
        throw new PointerError(
          "invalid-settings",
          "unconfigured",
          "Enter a valid HTTPS service origin without credentials, path, query, or fragment; enabled setup requires an endpoint.",
          400,
        );
      const settings = {
        enabled: parsed.data.enabled,
        pointerUrl: parsed.data.pointerUrl ?? this.#settings.pointerUrl,
      };
      const claimedEndpoint =
        (this.#state?.baseUrl || this.#state?.claimAttempted
          ? this.#state.pointerUrl
          : undefined) ??
        (this.#legacyState ? this.#settings.pointerUrl : undefined);
      if (claimedEndpoint && settings.pointerUrl !== claimedEndpoint)
        throw new PointerError(
          "endpoint-change-requires-removal",
          "recovery-required",
          "Remove the previous remote pointer using its original endpoint and credentials before changing endpoints. Disable without changing the URL to pause participation.",
        );
      // A read-only check of a mistyped service cannot create a claim. Let the
      // user correct that URL without requiring a successful delete there.
      if (
        !claimedEndpoint &&
        settings.pointerUrl !== this.#settings.pointerUrl
      ) {
        try {
          await rm(this.#statePath, { force: true });
        } catch {
          throw storageError();
        }
        this.#state = undefined;
      }
      await writePrivateJson(this.#settingsPath, settings);
      this.#settings = settings;
      this.#explicitSettings = true;
      return this.#snapshot();
    });
  }

  #requireConfigured(): void {
    const status = this.#snapshot();
    if (!status.configured)
      throw new PointerError(status.state, status.state, status.message);
    if (this.#state && !this.#identityMatches())
      throw new PointerError(
        "identity-mismatch",
        "recovery-required",
        status.message,
      );
  }

  async #save(state: StoredState): Promise<void> {
    try {
      await writePrivateJson(this.#statePath, state);
    } catch {
      this.#storageFailed = true;
      throw storageError();
    }
    this.#state = state;
    this.#legacyState = undefined;
  }

  #scopedState(): StoredState {
    return (
      this.#state ?? {
        version: 2,
        pointerUrl: this.#settings.pointerUrl,
        tokenHash: hash(this.#token),
        pushSecretHash: hash(this.#pushSecret!),
        ...(this.#legacyState ? { claimAttempted: true } : {}),
      }
    );
  }

  async #observe(code: FailureCode): Promise<void> {
    await this.#save({ ...this.#scopedState(), observation: code });
  }

  async #request(
    suffix: string,
    init: RequestInit,
  ): Promise<
    { response: Response } | { failure: FailureCode; reachable: boolean }
  > {
    await this.#save({
      ...this.#scopedState(),
      ...(init.method === "POST" ? { claimAttempted: true } : {}),
      observation: "request-incomplete",
    });
    let response: Response;
    try {
      response = await this.#fetch(this.#settings.pointerUrl + suffix, {
        ...init,
        redirect: "error",
        signal: AbortSignal.timeout(10_000),
      });
    } catch {
      await this.#observe("network");
      return { failure: "network", reachable: false };
    }
    let failure: FailureCode | undefined;
    if (
      response.redirected ||
      (response.status >= 300 && response.status < 400)
    )
      failure = "redirect";
    else if (response.status === 401 || response.status === 403)
      failure = "authentication";
    else if (response.status === 404) failure = "not-found";
    else if (response.status === 429) failure = "rate-limited";
    else if (!response.ok) failure = "service-error";
    if (failure) {
      await response.body?.cancel().catch(() => {});
      await this.#observe(failure);
      return { failure, reachable: true };
    }
    return { response };
  }

  #requestError(code: FailureCode): PointerError {
    const { state, message } = failures[code];
    return new PointerError(
      code,
      state,
      message,
      code === "authentication" || code === "not-found" ? 409 : 502,
    );
  }

  push(manifest: unknown): Promise<PointerStatus> {
    return this.#serial(async () => {
      await this.#load();
      this.#requireConfigured();
      const baseUrl = this.currentBaseUrl();
      if (!baseUrl)
        throw new PointerError(
          "no-lan-address",
          "stale",
          "No LAN IPv4 address detected. Connect to your trusted LAN before updating the pointer.",
        );
      const result = await this.#request("/api/pointer", {
        method: "POST",
        headers: {
          authorization: `Bearer ${this.#pushSecret}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ baseUrl, token: this.#token, manifest }),
      });
      if ("failure" in result) throw this.#requestError(result.failure);
      const parsed = pushResponseSchema.safeParse(
        await result.response.json().catch(() => undefined),
      );
      if (!parsed.success) {
        await this.#observe("invalid-response");
        throw this.#requestError("invalid-response");
      }
      await this.#save({
        version: 2,
        pointerUrl: this.#settings.pointerUrl,
        tokenHash: hash(this.#token),
        pushSecretHash: hash(this.#pushSecret!),
        baseUrl,
        pushedAt: parsed.data.updatedAt,
        expiresAt: parsed.data.expiresAt,
      });
      return this.#snapshot();
    });
  }

  remove(): Promise<void> {
    return this.#serial(async () => {
      await this.#load();
      this.#requireConfigured();
      const result = await this.#request("/api/pointer", {
        method: "DELETE",
        headers: {
          authorization: `Bearer ${this.#pushSecret}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ token: this.#token }),
      });
      if ("failure" in result) throw this.#requestError(result.failure);
      const parsed = deleteResponseSchema.safeParse(
        await result.response.json().catch(() => undefined),
      );
      if (!parsed.success) {
        await this.#observe("invalid-response");
        throw this.#requestError("invalid-response");
      }
      try {
        await rm(this.#statePath, { force: true });
      } catch {
        this.#storageFailed = true;
        throw storageError();
      }
      this.#state = undefined;
      this.#legacyState = undefined;
    });
  }

  remoteStatus(): Promise<RemotePointerStatus> {
    return this.#serial(async () => {
      await this.#load();
      const before = this.#snapshot();
      if (!before.configured || (this.#state && !this.#identityMatches()))
        return {
          reachable: false,
          registered: false,
          state: before.state,
          message: before.message,
          usable: false,
        };
      const result = await this.#request("/api/pointer/status", {
        method: "GET",
        headers: {
          authorization: `Bearer ${this.#pushSecret}`,
          "x-addon-token": this.#token,
        },
      });
      if ("failure" in result)
        return {
          reachable: result.reachable,
          registered: false,
          ...failures[result.failure],
          usable: false,
        };
      const parsed = remoteStatusSchema.safeParse(
        await result.response.json().catch(() => undefined),
      );
      if (!parsed.success) {
        await this.#observe("invalid-response");
        return {
          reachable: true,
          registered: false,
          ...failures["invalid-response"],
          usable: false,
        };
      }
      const remote = parsed.data;
      // A remote read cannot substitute for a local push. It may invalidate
      // existing evidence, but never create or extend that evidence.
      const local = this.#scopedState();
      const cleared = { ...local };
      delete cleared.observation;
      await this.#save({
        ...cleared,
        ...(local.expiresAt
          ? {
              expiresAt: new Date(
                Math.min(
                  Date.parse(local.expiresAt),
                  Date.parse(remote.expiresAt),
                ),
              ).toISOString(),
            }
          : {}),
        ...(local.baseUrl && local.baseUrl !== remote.baseUrl
          ? { observation: "remote-mismatch" as const }
          : {}),
        ...(!local.baseUrl
          ? { observation: "remote-without-local-push" as const }
          : {}),
      });
      const status = this.#snapshot();
      const expired = Date.parse(remote.expiresAt) <= Date.now();
      const stale = remote.baseUrl !== this.currentBaseUrl();
      return {
        reachable: true,
        registered: true,
        baseUrl: remote.baseUrl,
        updatedAt: remote.updatedAt,
        expiresAt: remote.expiresAt,
        state: expired ? "expired" : stale ? "stale" : status.state,
        message: expired
          ? "The remote pointer has expired. Manually update it to renew."
          : stale
            ? "The remote pointer does not match this LAN address. Manually update it."
            : status.message,
        usable: !expired && !stale && status.usable,
      };
    });
  }
}
