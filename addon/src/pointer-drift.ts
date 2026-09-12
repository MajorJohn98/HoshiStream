import { lanIPv4 } from "./mdns.ts";
import type { DriftTrigger, PointerClient } from "./pointer.ts";

export interface PointerDriftMonitorOptions {
  lanIp?: () => string | undefined;
  // How often the local LAN address is re-read. This is an interface
  // enumeration, not a network request; the service is contacted only when
  // the address actually changes.
  ipCheckIntervalMs?: number;
  timeoutMs?: number;
}

// Runs one remote read at start-up and one per LAN address change so a stale
// remote record is visible on the dashboard and in the menu bar. It never
// retries in a loop and never pushes: fixing the record stays a click away.
export class PointerDriftMonitor {
  readonly #pointer: PointerClient;
  readonly #lanIp: () => string | undefined;
  readonly #intervalMs: number;
  readonly #timeoutMs: number;
  #timer: NodeJS.Timeout | undefined;
  #lastIp: string | undefined;
  #checked = false;
  #pending: Promise<void> = Promise.resolve();

  constructor(
    pointer: PointerClient,
    options: PointerDriftMonitorOptions = {},
  ) {
    this.#pointer = pointer;
    this.#lanIp = options.lanIp ?? lanIPv4;
    this.#intervalMs = options.ipCheckIntervalMs ?? 30_000;
    this.#timeoutMs = options.timeoutMs ?? 5_000;
  }

  start(): void {
    if (this.#timer) return;
    this.#lastIp = this.#lanIp();
    // Without a LAN address the pointer cannot be compared to anything and
    // the service is probably unreachable too; the first address to appear
    // triggers the start check instead.
    if (this.#lastIp) this.#schedule("start");
    this.#timer = setInterval(() => {
      const current = this.#lanIp();
      if (!current || current === this.#lastIp) return;
      this.#lastIp = current;
      this.#schedule(this.#checked ? "lan-change" : "start");
    }, this.#intervalMs);
    this.#timer.unref();
  }

  stop(): void {
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = undefined;
  }

  // Resolves once every scheduled check has settled; for tests and shutdown.
  settled(): Promise<void> {
    return this.#pending;
  }

  #schedule(trigger: DriftTrigger): void {
    this.#checked = true;
    this.#pending = this.#pending.then(() => this.#check(trigger));
  }

  async #check(trigger: DriftTrigger): Promise<void> {
    try {
      const observation = await this.#pointer.observeDrift(trigger, {
        timeoutMs: this.#timeoutMs,
      });
      if (!observation) return;
      console.log(
        JSON.stringify({
          level: observation.outcome === "match" ? "info" : "warn",
          event: "pointer_drift_observed",
          trigger,
          outcome: observation.outcome,
        }),
      );
    } catch {
      console.error(
        JSON.stringify({
          level: "warn",
          event: "pointer_drift_check_failed",
          trigger,
        }),
      );
    }
  }
}
