export type AnalysisHolder = "source-check" | "stream-test";

type Ticket = {
  holder: AnalysisHolder;
  start: (release: () => void) => void;
  settled: boolean;
};

/**
 * Serializes background media analysis. Source checks and stream tests both
 * pull torrent data through TorrServer; running them together would make a
 * stream test measure a shared swarm and line, so they take turns in request
 * order.
 */
export class AnalysisSlot {
  #holder?: AnalysisHolder;
  readonly #queue: Ticket[] = [];

  holder(): AnalysisHolder | undefined {
    return this.#holder;
  }

  /**
   * Queues `start`, which runs synchronously when the slot is free. It must
   * eventually call `release` (idempotent). The returned function withdraws a
   * request that has not been granted yet; after the grant it does nothing.
   */
  request(
    holder: AnalysisHolder,
    start: (release: () => void) => void,
  ): () => void {
    const ticket: Ticket = { holder, start, settled: false };
    this.#queue.push(ticket);
    this.#next();
    return () => {
      if (ticket.settled) return;
      ticket.settled = true;
      const at = this.#queue.indexOf(ticket);
      if (at >= 0) this.#queue.splice(at, 1);
    };
  }

  #next() {
    while (this.#holder === undefined) {
      const ticket = this.#queue.shift();
      if (!ticket) return;
      if (ticket.settled) continue;
      ticket.settled = true;
      this.#holder = ticket.holder;
      let released = false;
      const release = () => {
        if (released) return;
        released = true;
        this.#holder = undefined;
        this.#next();
      };
      try {
        ticket.start(release);
      } catch {
        console.error(
          JSON.stringify({
            level: "error",
            event: "analysis_slot_start_failed",
            holder: ticket.holder,
          }),
        );
        release();
      }
    }
  }
}
