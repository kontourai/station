import type {
  ProviderAdapterShape,
  ProviderSession,
} from '../../providers/adapter-shape.js';

/** Narrow structural logger: the module warns, never debugs. */
export type AdapterRetirementLogger = {
  warn(message: string, meta?: Record<string, unknown>): void;
};

export interface AdapterRetirementDeps {
  /**
   * Called, not captured: reads the LIVE `options.adapterStopTimeoutMs` at
   * each deadline, so an option swap after construction is honoured
   * (CooperativeStop's `configuredBudgetMs` precedent).
   */
  configuredStopTimeoutMs: () => number | undefined;
  /**
   * C1-stay, beside the ingest loop. It CANNOT move: it is one of the six
   * `forgetThreadState` call sites the T10(3) source invariant counts in
   * the service file, so moving it would silently drop a docblock row. A
   * named dep, never a move — this module never sees `forgetThreadState`,
   * the read model, or any per-thread map (T13).
   */
  finalizeStoppedAdapterSessions: (
    adapter: ProviderAdapterShape,
    sessions: Map<string, ProviderSession>,
    reason: string,
  ) => void;
  logger: AdapterRetirementLogger;
}

/**
 * Adapter retirement and the bounded-await helpers (epic archive#4024).
 *
 * Scope is deliberately NARROWER than the decomposition map's "C1 — adapter
 * lifecycle": adapter currency, stream consumption, readiness and the
 * provider inventory all stay on the service, so this is named for what it
 * owns rather than for the cluster it came from. Two halves were considered
 * and rejected in the plan pass, both recorded in the map: the inventory
 * half is closed BY INSPECTION (it owns nothing — eight members that are
 * mostly one-line `adapterRegistry` delegations, four of them public with
 * external callers, so a module would buy indirection and no seam), and the
 * stream-consumption half stays because C2's `finally` writes two of its
 * fields and re-enters `consumeCurrentAdapterEvents` through a
 * `queueMicrotask` — an ordering nothing at any level can observe.
 *
 * `runCleanupWithinDeadline`/`runOperationWithinDeadline` live here as
 * public methods, and two of their callers are not retirements at all
 * (`ConnectionSmoke`, and the accepted-turn-then-aborted branch of
 * `dispatchWithReceipt`). That is disclosed rather than disguised: this is
 * the file's one bounded-await utility, and giving it a second home would
 * duplicate the timer/rejection handling that `finally` block gets right.
 *
 * Emits no metrics — deliberately, so nothing here needs the T12-compliant
 * specifier and a later reader does not "fix" its absence.
 */
export class AdapterRetirement {
  /**
   * `Promise<void>` per retiring adapter: the raw operation, which is what
   * shutdown drains and re-wraps in its own deadline.
   */
  private readonly adapterRetirementByAdapter = new Map<
    ProviderAdapterShape,
    Promise<void>
  >();
  /** Sessions captured at retirement time, finalized once the adapter stops. */
  private readonly retiredSessionsByAdapter = new Map<
    ProviderAdapterShape,
    Map<string, ProviderSession>
  >();

  constructor(private readonly deps: AdapterRetirementDeps) {}

  /** Retire an adapter, absorbing sessions from a repeat call for the same one. */
  retire(
    adapter: ProviderAdapterShape,
    sessions: Map<string, ProviderSession> = new Map(),
  ): void {
    const trackedSessions = this.retiredSessionsByAdapter.get(adapter);
    if (trackedSessions) {
      for (const [threadId, session] of sessions) {
        trackedSessions.set(threadId, session);
      }
    } else {
      this.retiredSessionsByAdapter.set(adapter, new Map(sessions));
    }
    if (this.adapterRetirementByAdapter.has(adapter)) return;
    const operation = Promise.resolve().then(() =>
      this.stopAndFinalizeRetiredAdapter(adapter),
    );
    this.adapterRetirementByAdapter.set(adapter, operation);
    void operation.then(
      () => {
        if (this.adapterRetirementByAdapter.get(adapter) === operation) {
          this.adapterRetirementByAdapter.delete(adapter);
          this.retiredSessionsByAdapter.delete(adapter);
        }
      },
      () => undefined,
    );
    void this.runOperationWithinDeadline(
      operation,
      `${adapter.provider} adapter retirement`,
    ).catch((error) => {
      this.deps.logger.warn('Replaced provider adapter cleanup failed', {
        provider: adapter.provider,
        error: error instanceof Error ? error.message : String(error),
      });
    });
  }

  /** Await every in-flight retirement, aggregating failures. */
  async settleRetirements(): Promise<void> {
    const pending = [...this.adapterRetirementByAdapter.entries()];
    const results = await Promise.allSettled(
      pending.map(([adapter, operation]) =>
        this.runOperationWithinDeadline(
          operation,
          `${adapter.provider} adapter retirement confirmation`,
        ),
      ),
    );
    const failures = results.flatMap((result) =>
      result.status === 'rejected' ? [result.reason] : [],
    );
    if (failures.length > 0) {
      throw new AggregateError(
        failures,
        'Provider adapter retirement was not confirmed.',
      );
    }
  }

  /**
   * The adapters currently retiring, snapshotted.
   *
   * Read by `shutdown` at the SAME synchronous tick as
   * {@link shutdownRetirementTasks}, with no await between them, so the
   * split of what used to be one expression is order-safe. Inserting an
   * await between the two calls changes which adapters get double-stopped —
   * pinned by a source invariant.
   */
  retiringAdapters(): Set<ProviderAdapterShape> {
    return new Set(this.adapterRetirementByAdapter.keys());
  }

  /** Shutdown's half of the drain: one bounded task per retiring adapter. */
  shutdownRetirementTasks(): Array<Promise<void>> {
    return [...this.adapterRetirementByAdapter].map(([adapter, operation]) =>
      this.runOperationWithinDeadline(
        operation.catch(() => this.stopAndFinalizeRetiredAdapter(adapter)),
        `${adapter.provider} adapter retirement during shutdown`,
      ).then(() => {
        this.adapterRetirementByAdapter.delete(adapter);
        this.retiredSessionsByAdapter.delete(adapter);
      }),
    );
  }

  /** Stop a session the launch race made obsolete; retire on failure. */
  async cleanupObsoleteStartedSession(
    adapter: ProviderAdapterShape,
    threadId: string,
  ): Promise<void> {
    try {
      await this.runCleanupWithinDeadline(
        () => adapter.stopSession(threadId),
        `${adapter.provider} obsolete session cleanup`,
      );
    } catch (error) {
      this.deps.logger.warn('Obsolete provider session cleanup failed', {
        provider: adapter.provider,
        threadId,
        error: error instanceof Error ? error.message : String(error),
      });
      const currentRetirement = this.adapterRetirementByAdapter.get(adapter);
      if (currentRetirement) {
        void currentRetirement.finally(() => this.retire(adapter));
      } else {
        this.retire(adapter);
      }
    }
  }

  async runCleanupWithinDeadline(
    cleanup: () => Promise<void>,
    label: string,
    deadlineAt?: number,
  ): Promise<void> {
    return this.runOperationWithinDeadline(
      Promise.resolve().then(cleanup),
      label,
      deadlineAt,
    );
  }

  async runOperationWithinDeadline(
    operation: Promise<void>,
    label: string,
    deadlineAt?: number,
  ): Promise<void> {
    const timeoutMs = Math.max(
      1,
      deadlineAt === undefined
        ? this.adapterStopTimeoutMs()
        : deadlineAt - Date.now(),
    );
    let timer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        operation,
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error(`${label} exceeded ${timeoutMs}ms.`)),
            timeoutMs,
          );
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
      // Belt-and-braces, and UNOBSERVABLE as written: `Promise.race` above
      // already attaches a handler to the loser, so a late rejection from
      // `operation` is never unhandled with or without this line (probed
      // during slice 12's injection ledger). Kept because it is the moved
      // body verbatim and it would matter if `operation` ever stopped being
      // raced — but do not write a test for it: nothing can red.
      void operation.catch(() => undefined);
    }
  }

  adapterStopTimeoutMs(): number {
    return Math.max(1, this.deps.configuredStopTimeoutMs() ?? 5_000);
  }

  private async stopAndFinalizeRetiredAdapter(
    adapter: ProviderAdapterShape,
  ): Promise<void> {
    await adapter.stopAll();
    const sessions = this.retiredSessionsByAdapter.get(adapter);
    if (!sessions) return;
    this.deps.finalizeStoppedAdapterSessions(
      adapter,
      sessions,
      'adapter_replaced',
    );
  }
}
