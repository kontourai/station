/**
 * ReceiptBus — TEST-ONLY typed milestone receipt bus (station#1101).
 *
 * Production code publishes typed milestone receipts via `receiptBus.publish()`
 * — cheap, fire-and-forget, safe to call unconditionally (a `Set.size`
 * check and nothing else when nobody is subscribed; publish never throws).
 * Only test code may *subscribe*. Both the naming and the enforcement make
 * that direction-of-flow hard to get backwards:
 *
 *   1. Naming — every subscribe-shaped export carries a `ForTest` suffix
 *      (`subscribeForTest`, `waitForReceipt`, `resetForTest`), so a
 *      production call site importing one reads as wrong at the call site.
 *   2. Runtime guard — `subscribeForTest()`/`resetForTest()` throw
 *      immediately unless invoked under a test runner (`process.env.VITEST`
 *      or `NODE_ENV === 'test'`). A production process that somehow
 *      reached a subscribe call fails fast instead of silently wiring up
 *      test-only listeners.
 *   3. Static guard — `receipt-bus.production-usage.test.ts` greps every
 *      tracked production source file for the subscribe-surface names and
 *      fails the suite if any file outside `__tests__/`/`*.test.ts`
 *      references them. It runs as an ordinary vitest test (part of
 *      `npm test`/`npm run verify:static`'s unit-test gate already), so it
 *      needs no new script wiring and cannot be silently skipped the way an
 *      opt-in lint rule could.
 *
 * This replaces sleep/poll-based test synchronization (`setTimeout` waits,
 * `vi.waitFor`/hand-rolled polling loops) for orchestration milestones that
 * have no other deterministic signal: session recovery, a turn's completion
 * event landing in the read model, and (once station#1093 Part B lands the
 * route-level KeyedCoalescingWorker construction) per-key coalescing
 * drains. See station#595/#1017/#1045 for the load-dependent flakes this
 * targets.
 */

/** Every milestone production code may report. Add new kinds here, not ad hoc call sites. */
export type OrchestrationTestReceipt =
  | {
      kind: 'session.recovery.completed';
      /** Number of persisted sessions the recovery pass attempted (recovered or closed). */
      attemptedCount: number;
      /** threadIds recovery attempted, in the order they were processed. */
      threadIds: string[];
    }
  | {
      /**
       * Fires from `OrchestrationService#projectAndPublishEvent` for a
       * `turn.completed`/`turn.aborted` event. Precisely what this
       * certifies: the event has been appended to the event store, folded
       * into the in-memory read model, and dispatched (synchronously) to
       * every `EventBus` listener registered at publish time.
       *
       * What it does NOT certify: that every downstream consequence of the
       * turn ending has finished. Several `EventBus`/adapter listeners do
       * async, fire-and-forget follow-up work off other events today (e.g.
       * `station-runtime.ts`'s `void ...releaseClaimForSession(...)`
       * pattern) — this receipt does not await any of that, and a future
       * listener wired to `turn.completed`/`turn.aborted` the same way
       * would not be covered either. Do not rename this back to something
       * quiescence-shaped without actually awaiting those listeners' work;
       * a true "everything triggered by this turn ending has settled"
       * receipt is a real future need but is NOT what this kind provides —
       * add a new kind (e.g. `turn.quiesced`) for that when a caller
       * actually needs it, rather than stretching this one's contract.
       */
      kind: 'turn.event.projected';
      threadId: string;
      turnId?: string;
      reason: 'completed' | 'aborted';
    }
  | {
      /**
       * station#1745: fires once per `OrchestrationService.initialize()`,
       * after `recoverSessions()` settles — the moment `sessionAdapters`
       * starts meaning "the threads this process holds" rather than "the
       * threads recovery has reached so far".
       *
       * It replaces `session.orphan-reconciliation.completed`, which was
       * deleted with the boot-time pass it reported on. A test asserting the
       * unanswerable arms of `projectRequestAnswerability` MUST await this:
       * before it the projection deliberately fails open, so an assertion
       * made earlier is measuring the fail-open window and not the predicate.
       */
      kind: 'session.attachment.settled';
    }
  | {
      kind: 'coalescing.drained';
      /** Worker/queue identifier — distinguishes multiple coalescing workers in one process. */
      worker: string;
      key?: string;
    };

type ReceiptListener = (receipt: OrchestrationTestReceipt) => void;

function isTestEnvironment(): boolean {
  return process.env.VITEST !== undefined || process.env.NODE_ENV === 'test';
}

function assertTestEnvironment(fnName: string): void {
  if (!isTestEnvironment()) {
    throw new Error(
      `receiptBus.${fnName}() is test-only and must never be reached from ` +
        "production code (NODE_ENV !== 'test' and VITEST is unset). If a " +
        'production code path needs to react to a milestone, use ' +
        '`receiptBus.publish()` plus its own contract — never subscribe.',
    );
  }
}

class ReceiptBus {
  private readonly listeners = new Set<ReceiptListener>();

  /**
   * Production-safe publish. The caller always pays for constructing the
   * receipt object literal passed in (negligible at the once-per-turn/
   * once-per-recovery-pass call rates every current publish site uses);
   * `publish()` itself does nothing further when nobody has subscribed
   * beyond a `Set.size` check — no iteration, no I/O, no timers. Never
   * throws — a milestone receipt must never be able to fail the operation
   * it reports on, so a misbehaving test listener's own exception is
   * swallowed here rather than propagated into the publisher.
   */
  publish(receipt: OrchestrationTestReceipt): void {
    if (this.listeners.size === 0) return;
    for (const listener of this.listeners) {
      try {
        listener(receipt);
      } catch {
        // Swallowed deliberately — see the doc comment above. A listener's
        // own assertion throwing must never reach production call sites.
      }
    }
  }

  /**
   * TEST ONLY. Subscribe to every published receipt; returns an
   * unsubscribe function. Throws outside a test runner — see the module
   * doc comment for the full guard rationale.
   */
  subscribeForTest(listener: ReceiptListener): () => void {
    assertTestEnvironment('subscribeForTest');
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /**
   * TEST ONLY. Drop every subscriber. Call from `afterEach`/`beforeEach` so
   * one test's dangling `subscribeForTest`/`waitForReceipt` listener can
   * never observe or hang on a later test's publishes.
   */
  resetForTest(): void {
    assertTestEnvironment('resetForTest');
    this.listeners.clear();
  }

  /** TEST ONLY. Current subscriber count — for asserting `resetForTest`/unsubscribe hygiene. */
  get subscriberCountForTest(): number {
    assertTestEnvironment('subscriberCountForTest');
    return this.listeners.size;
  }
}

/** Process-wide singleton — production code and tests share the same bus instance. */
export const receiptBus = new ReceiptBus();

/**
 * TEST ONLY. Await the next published receipt matching `predicate`, or
 * reject after `timeoutMs`. This is the sleep/poll replacement: instead of
 * `await new Promise((r) => setTimeout(r, N))` or a hand-rolled polling
 * loop, tests await the exact milestone production code already publishes.
 *
 * Deliberately does not miss a receipt published between subscribe and the
 * caller's `await` resolving further down the microtask queue: the
 * listener is registered synchronously before this function returns its
 * promise, so any publish after the call to `waitForReceipt()` — including
 * one on the very next microtask — is observed.
 */
export function waitForReceipt<
  T extends OrchestrationTestReceipt = OrchestrationTestReceipt,
>(
  predicate: (receipt: OrchestrationTestReceipt) => boolean,
  timeoutMs = 2000,
): Promise<T> {
  assertTestEnvironment('waitForReceipt');
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      unsubscribe();
      reject(
        new Error(
          `waitForReceipt() timed out after ${timeoutMs}ms waiting for a matching receipt.`,
        ),
      );
    }, timeoutMs);
    const unsubscribe = receiptBus.subscribeForTest((receipt) => {
      if (!predicate(receipt)) return;
      clearTimeout(timer);
      unsubscribe();
      resolve(receipt as T);
    });
  });
}
