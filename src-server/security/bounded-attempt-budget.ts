export interface AttemptBudgetDecision {
  readonly kind: 'admitted' | 'rate-limited';
  readonly retryAfterSeconds?: number;
  readonly overflow: boolean;
}

interface AttemptWindow {
  count: number;
  resetAt: number;
}

/**
 * Fixed-window attempt accounting with bounded per-key state. New keys that
 * arrive after a surface reaches capacity consume a small surface aggregate
 * allowance instead of evicting an unexpired key and restoring its budget.
 */
export class BoundedAttemptBudget {
  readonly #entries = new Map<string, Map<string, AttemptWindow>>();
  readonly #overflows = new Map<string, AttemptWindow>();
  readonly #maxTrackedEntries: number;
  readonly #overflowLimit: number;
  readonly #overflowWindowMs: number;

  constructor(
    options: {
      maxTrackedEntries?: number;
      overflowLimit?: number;
      overflowWindowMs?: number;
    } = {},
  ) {
    this.#maxTrackedEntries = Math.max(1, options.maxTrackedEntries ?? 1_024);
    this.#overflowLimit = Math.max(1, options.overflowLimit ?? 10);
    this.#overflowWindowMs = Math.max(1, options.overflowWindowMs ?? 60_000);
  }

  reserve(
    surface: string,
    key: string,
    limit: number,
    windowMs: number,
    now = Date.now(),
  ): AttemptBudgetDecision {
    const entries = this.#entriesFor(surface);
    this.#prune(entries, now);
    const current = entries.get(key);
    if (current) return this.#consume(current, limit, now, false);
    if (entries.size >= this.#maxTrackedEntries)
      return this.reserveOverflow(surface, now);
    const entry = { count: 1, resetAt: now + windowMs };
    entries.set(key, entry);
    return { kind: 'admitted', overflow: false };
  }

  reserveOverflow(surface: string, now = Date.now()): AttemptBudgetDecision {
    const current = this.#overflows.get(surface);
    if (!current || current.resetAt <= now) {
      this.#overflows.set(surface, {
        count: 1,
        resetAt: now + this.#overflowWindowMs,
      });
      return { kind: 'admitted', overflow: true };
    }
    return this.#consume(current, this.#overflowLimit, now, true);
  }

  #entriesFor(surface: string): Map<string, AttemptWindow> {
    let entries = this.#entries.get(surface);
    if (!entries) {
      entries = new Map();
      this.#entries.set(surface, entries);
    }
    return entries;
  }

  #consume(
    entry: AttemptWindow,
    limit: number,
    now: number,
    overflow: boolean,
  ): AttemptBudgetDecision {
    if (entry.count >= limit) {
      return {
        kind: 'rate-limited',
        retryAfterSeconds: this.#retryAfterSeconds(entry.resetAt, now),
        overflow,
      };
    }
    entry.count += 1;
    return { kind: 'admitted', overflow };
  }

  #prune(entries: Map<string, AttemptWindow>, now: number): void {
    for (const [key, entry] of entries) {
      if (entry.resetAt <= now) entries.delete(key);
    }
  }

  #retryAfterSeconds(resetAt: number, now: number): number {
    return Math.max(1, Math.ceil((resetAt - now) / 1_000));
  }
}
