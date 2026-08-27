import { BoundedAttemptBudget } from './bounded-attempt-budget.js';

export type PairingFailureSurface = 'pairing-request' | 'credential-exchange';

export interface PairingFailureState {
  failures: number;
  lockedUntil: number;
}

interface FailureEntry extends PairingFailureState {
  expiresAt: number;
  inFlight: number;
}

export interface PairingFailureAdmission {
  readonly surface: PairingFailureSurface;
  readonly source: string;
  readonly entry?: FailureEntry;
  readonly overflow: boolean;
  finalized: boolean;
}

export type PairingFailureAdmissionResult =
  | { readonly kind: 'admitted'; readonly admission: PairingFailureAdmission }
  | {
      readonly kind: 'rate-limited';
      readonly retryAfterSeconds: number;
      readonly state?: PairingFailureState;
    };

/**
 * Bounds failed public pairing proofs without treating a pending exchange poll
 * as a failed credential attempt. Admission is synchronous and precedes body
 * parsing, so a peer cannot race many asynchronous parses past one lock check.
 * State is process-local; the public route also applies coarse request budgets
 * before admission, and durable audit evidence makes a restart visible.
 */
export class PairingFailureLimiter {
  readonly #entries = new Map<
    PairingFailureSurface,
    Map<string, FailureEntry>
  >();
  readonly #now: () => number;
  readonly #failureThreshold: number;
  readonly #baseLockoutMs: number;
  readonly #maxLockoutMs: number;
  readonly #retentionMs: number;
  readonly #maxTrackedSources: number;
  readonly #maxInFlightPerSource: number;
  readonly #maxOverflowAttempts: number;
  readonly #overflowWindowMs: number;
  readonly #overflowBudget: BoundedAttemptBudget;

  constructor(
    options: {
      now?: () => number;
      failureThreshold?: number;
      baseLockoutMs?: number;
      maxLockoutMs?: number;
      retentionMs?: number;
      maxTrackedSources?: number;
      maxInFlightPerSource?: number;
      maxOverflowAttempts?: number;
      overflowWindowMs?: number;
    } = {},
  ) {
    this.#now = options.now ?? Date.now;
    this.#failureThreshold = Math.max(1, options.failureThreshold ?? 3);
    this.#baseLockoutMs = Math.max(1, options.baseLockoutMs ?? 10_000);
    this.#maxLockoutMs = Math.max(
      this.#baseLockoutMs,
      options.maxLockoutMs ?? 5 * 60_000,
    );
    this.#retentionMs = Math.max(
      this.#maxLockoutMs,
      options.retentionMs ?? 15 * 60_000,
    );
    this.#maxTrackedSources = Math.max(1, options.maxTrackedSources ?? 1_024);
    this.#maxInFlightPerSource = Math.max(1, options.maxInFlightPerSource ?? 1);
    this.#maxOverflowAttempts = Math.max(1, options.maxOverflowAttempts ?? 10);
    this.#overflowWindowMs = Math.max(1, options.overflowWindowMs ?? 60_000);
    this.#overflowBudget = new BoundedAttemptBudget({
      overflowLimit: this.#maxOverflowAttempts,
      overflowWindowMs: this.#overflowWindowMs,
    });
  }

  /**
   * Atomically reserves one authentication attempt before an asynchronous
   * parser or verifier runs. Capacity exhaustion is a refusal, never an LRU
   * eviction that would turn an active lock into an allow.
   */
  admit(
    surface: PairingFailureSurface,
    source: string,
  ): PairingFailureAdmissionResult {
    const now = this.#now();
    const entries = this.#entriesFor(surface);
    this.#prune(entries, now);
    let entry = entries.get(source);
    if (entry && entry.lockedUntil > now) {
      return {
        kind: 'rate-limited',
        retryAfterSeconds: this.#retryAfterSeconds(entry.lockedUntil, now),
        state: this.#state(entry),
      };
    }
    if (!entry) {
      if (entries.size >= this.#maxTrackedSources) {
        const overflow = this.#overflowBudget.reserveOverflow(surface, now);
        if (overflow.kind === 'rate-limited') {
          return {
            kind: 'rate-limited',
            retryAfterSeconds: overflow.retryAfterSeconds ?? 1,
          };
        }
        return {
          kind: 'admitted',
          admission: { surface, source, overflow: true, finalized: false },
        };
      }
      entry = {
        failures: 0,
        lockedUntil: now,
        expiresAt: now + this.#retentionMs,
        inFlight: 0,
      };
      entries.set(source, entry);
    }
    if (!entry) throw new Error('Pairing failure admission could not reserve');
    if (entry.inFlight >= this.#maxInFlightPerSource) {
      return {
        kind: 'rate-limited',
        retryAfterSeconds: 1,
        state: this.#state(entry),
      };
    }
    entry.inFlight += 1;
    entry.expiresAt = now + this.#retentionMs;
    return {
      kind: 'admitted',
      admission: { surface, source, entry, overflow: false, finalized: false },
    };
  }

  /** Finalizes a previously admitted operation exactly once. */
  finalize(
    admission: PairingFailureAdmission,
    outcome: 'failure' | 'success' | 'pending',
  ): PairingFailureState | undefined {
    if (admission.finalized) {
      throw new Error('Pairing failure admission finalized more than once');
    }
    admission.finalized = true;
    if (admission.overflow) {
      return outcome === 'failure'
        ? { failures: 1, lockedUntil: this.#now() }
        : undefined;
    }
    const entries = this.#entriesFor(admission.surface);
    const entry = admission.entry;
    if (!entry) throw new Error('Pairing failure admission has no entry');
    entry.inFlight = Math.max(0, entry.inFlight - 1);
    const now = this.#now();
    if (outcome === 'success') {
      entries.delete(admission.source);
      return undefined;
    }
    if (outcome === 'failure') {
      entry.failures += 1;
      const lockExponent = Math.max(0, entry.failures - this.#failureThreshold);
      const lockoutMs = Math.min(
        this.#maxLockoutMs,
        this.#baseLockoutMs * 2 ** lockExponent,
      );
      entry.lockedUntil =
        entry.failures >= this.#failureThreshold ? now + lockoutMs : now;
      entry.expiresAt = now + this.#retentionMs;
      return this.#state(entry);
    }
    if (entry.failures === 0 && entry.inFlight === 0) {
      entries.delete(admission.source);
      return undefined;
    }
    entry.expiresAt = now + this.#retentionMs;
    return this.#state(entry);
  }

  retryAfterSeconds(
    surface: PairingFailureSurface,
    source: string,
  ): number | undefined {
    const now = this.#now();
    const entries = this.#entriesFor(surface);
    const entry = entries.get(source);
    if (!entry) return undefined;
    if (entry.expiresAt <= now) {
      entries.delete(source);
      return undefined;
    }
    return entry.lockedUntil > now
      ? this.#retryAfterSeconds(entry.lockedUntil, now)
      : undefined;
  }

  /** Compatibility helper for direct callers; route handlers use leases. */
  recordFailure(
    surface: PairingFailureSurface,
    source: string,
  ): PairingFailureState | undefined {
    const result = this.admit(surface, source);
    if (result.kind !== 'admitted') return result.state;
    return this.finalize(result.admission, 'failure');
  }

  clear(surface: PairingFailureSurface, source: string): void {
    this.#entriesFor(surface).delete(source);
  }

  #entriesFor(surface: PairingFailureSurface): Map<string, FailureEntry> {
    let entries = this.#entries.get(surface);
    if (!entries) {
      entries = new Map();
      this.#entries.set(surface, entries);
    }
    return entries;
  }

  #state(entry: FailureEntry): PairingFailureState {
    return { failures: entry.failures, lockedUntil: entry.lockedUntil };
  }

  #retryAfterSeconds(lockedUntil: number, now: number): number {
    return Math.max(1, Math.ceil((lockedUntil - now) / 1_000));
  }

  #prune(entries: Map<string, FailureEntry>, now: number): void {
    for (const [source, entry] of entries) {
      if (entry.expiresAt <= now && entry.inFlight === 0)
        entries.delete(source);
    }
  }
}
