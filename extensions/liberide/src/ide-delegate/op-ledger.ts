/**
 * Durable operation ids (`opId` on a server request). The server re-sends a
 * call under a new JSON-RPC id after a reconnect or when the window moved to
 * another API replica; the opId stays the same, so a mutation runs once and
 * the repeat gets the stored outcome or joins the running call.
 */

export const OP_LEDGER_LIMIT = 500;
export const OP_LEDGER_TTL_MS = 10 * 60_000;

export type OpOutcome = { ok: true; result: unknown } | { ok: false; message: string };

interface Entry {
  outcome: Promise<OpOutcome>;
  settledAt?: number;
}

export class OpLedger {
  private readonly entries = new Map<string, Entry>();

  constructor(
    private readonly limit = OP_LEDGER_LIMIT,
    private readonly ttlMs = OP_LEDGER_TTL_MS,
    private readonly now: () => number = Date.now,
  ) {}

  /**
   * Run `execute` once per opId. `retryable(outcome)` true drops the entry
   * after it settles (e.g. a cancelled run), so a later repeat runs again.
   */
  run(opId: string, execute: () => Promise<OpOutcome>, retryable: (outcome: OpOutcome) => boolean = () => false): { outcome: Promise<OpOutcome>; replayed: boolean } {
    this.prune();
    const existing = this.entries.get(opId);
    if (existing) {
      // Refresh recency (LRU).
      this.entries.delete(opId);
      this.entries.set(opId, existing);
      return { outcome: existing.outcome, replayed: true };
    }
    const entry: Entry = { outcome: execute() };
    this.entries.set(opId, entry);
    void entry.outcome.then((outcome) => {
      if (this.entries.get(opId) !== entry) return;
      if (retryable(outcome)) this.entries.delete(opId);
      else entry.settledAt = this.now();
    });
    while (this.entries.size > this.limit) {
      const oldest = this.entries.keys().next().value as string;
      this.entries.delete(oldest);
    }
    return { outcome: entry.outcome, replayed: false };
  }

  get size(): number {
    return this.entries.size;
  }

  clear(): void {
    this.entries.clear();
  }

  private prune(): void {
    const cutoff = this.now() - this.ttlMs;
    for (const [opId, entry] of this.entries) {
      if (entry.settledAt !== undefined && entry.settledAt <= cutoff) this.entries.delete(opId);
    }
  }
}
