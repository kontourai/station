import { describe, expect, it, vi } from 'vitest';
import type {
  ProviderAdapterShape,
  ProviderSession,
} from '../../../providers/adapter-shape.js';
import {
  AdapterRetirement,
  type AdapterRetirementDeps,
} from '../adapter-retirement.js';

/**
 * Unit pins for the slice-12 extraction (epic #4024) — the contracts the
 * service suite proved it CANNOT discriminate. The service band covers this
 * cluster well for PRESENCE (does a retirement stop the adapter, does
 * shutdown aggregate failures) and not at all for the things that decide
 * behavior at the edges: the `?? 5_000` default, the `Math.max(1, …)` floor,
 * the second-retire session merge, the stale-completion identity check, the
 * caller-map copy, the unhandled-rejection swallow, the timer cleanup, and
 * the one diagnostic a bounded-cleanup incident leaves behind.
 *
 * Every fixture drives real timers deliberately: the deadline arithmetic is
 * the subject, so faking it away would pin nothing.
 */

function makeDeps(overrides: Partial<AdapterRetirementDeps> = {}) {
  const deps: AdapterRetirementDeps = {
    configuredStopTimeoutMs: () => 50,
    finalizeStoppedAdapterSessions: vi.fn(),
    logger: { warn: vi.fn() },
    ...overrides,
  };
  return deps;
}

function makeAdapter(
  overrides: Partial<ProviderAdapterShape> = {},
): ProviderAdapterShape {
  return {
    provider: 'claude',
    stopAll: vi.fn(async () => {}),
    stopSession: vi.fn(async () => {}),
    ...overrides,
  } as unknown as ProviderAdapterShape;
}

function session(threadId: string): ProviderSession {
  return { threadId, provider: 'claude' } as unknown as ProviderSession;
}

describe('AdapterRetirement (unit pins)', () => {
  it('falls back to a 5s stop timeout when the option is absent', () => {
    // Every service fixture that cares configures adapterStopTimeoutMs, and
    // the one that does not settles fast either way — so the default arm has
    // no service-level observer.
    const retirement = new AdapterRetirement(
      makeDeps({ configuredStopTimeoutMs: () => undefined }),
    );
    expect(retirement.adapterStopTimeoutMs()).toBe(5_000);
  });

  it('floors a zero or negative configured timeout at 1ms', () => {
    // A 0 here is a setTimeout(…, 0) that fires before any real work: the
    // floor is what stops a misconfiguration from failing every cleanup
    // instantly.
    expect(
      new AdapterRetirement(
        makeDeps({ configuredStopTimeoutMs: () => 0 }),
      ).adapterStopTimeoutMs(),
    ).toBe(1);
    expect(
      new AdapterRetirement(
        makeDeps({ configuredStopTimeoutMs: () => -10 }),
      ).adapterStopTimeoutMs(),
    ).toBe(1);
  });

  it('merges sessions from a SECOND retire of an already-retiring adapter', async () => {
    // The early return for an in-flight adapter sits BELOW the merge on
    // purpose. Hoisting it drops the second batch's sessions silently, and
    // no service fixture retires one adapter twice with sessions.
    const finalize = vi.fn();
    const deps = makeDeps({ finalizeStoppedAdapterSessions: finalize });
    const retirement = new AdapterRetirement(deps);
    let release: (() => void) | undefined;
    const adapter = makeAdapter({
      stopAll: vi.fn(
        () =>
          new Promise<void>((resolve) => {
            release = resolve;
          }),
      ) as never,
    });

    retirement.retire(adapter, new Map([['thread-a', session('thread-a')]]));
    retirement.retire(adapter, new Map([['thread-b', session('thread-b')]]));
    // `stopAll` runs a microtask after retire(), so the release handle does
    // not exist yet at this point in the synchronous test body.
    await new Promise((resolve) => setTimeout(resolve, 0));
    release?.();
    await retirement.settleRetirements();

    expect(finalize).toHaveBeenCalledOnce();
    const delivered = finalize.mock.calls[0]?.[1] as Map<string, unknown>;
    expect([...delivered.keys()].sort()).toEqual(['thread-a', 'thread-b']);
  });

  it('snapshots the caller’s session map instead of aliasing it', async () => {
    // The caller keeps mutating its own map after handing it over; the
    // retirement must finalize what it was given.
    const finalize = vi.fn();
    const retirement = new AdapterRetirement(
      makeDeps({ finalizeStoppedAdapterSessions: finalize }),
    );
    const callerMap = new Map([['thread-a', session('thread-a')]]);
    retirement.retire(makeAdapter(), callerMap);
    callerMap.set('thread-late', session('thread-late'));
    await retirement.settleRetirements();

    const delivered = finalize.mock.calls[0]?.[1] as Map<string, unknown>;
    expect([...delivered.keys()]).toEqual(['thread-a']);
  });

  it('reports the label AND the elapsed budget when a cleanup overruns', async () => {
    // `exceeded` appears in zero assertions across the whole service suite,
    // and this message is the only diagnostic a bounded-cleanup incident
    // leaves behind.
    const retirement = new AdapterRetirement(
      makeDeps({ configuredStopTimeoutMs: () => 5 }),
    );
    await expect(
      retirement.runOperationWithinDeadline(
        new Promise<void>(() => {}),
        'stuck cleanup',
      ),
    ).rejects.toThrow('stuck cleanup exceeded 5ms.');
  });

  it('clears the deadline timer when the operation wins the race', async () => {
    vi.useFakeTimers();
    try {
      const retirement = new AdapterRetirement(
        makeDeps({ configuredStopTimeoutMs: () => 10_000 }),
      );
      await retirement.runOperationWithinDeadline(
        Promise.resolve(),
        'quick cleanup',
      );
      // A leaked timer keeps the process alive and every assertion still
      // passes — only the timer count sees it.
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('turns a SYNCHRONOUS throw from a cleanup into a rejection', async () => {
    // The contract is real and worth pinning; the MECHANISM is not the
    // `Promise.resolve().then(cleanup)` wrapper it looks like. Probed
    // during the slice-12 ledger: `runCleanupWithinDeadline` is `async`, so
    // a directly-called `cleanup()` that throws synchronously ALSO becomes
    // a rejection. Replacing the wrapper is therefore an inert injection —
    // do not read a green run here as proof the wrapper is load-bearing.
    const retirement = new AdapterRetirement(makeDeps());
    await expect(
      retirement.runCleanupWithinDeadline(() => {
        throw new Error('sync boom');
      }, 'sync cleanup'),
    ).rejects.toThrow('sync boom');
  });

  it('CHAINS the compensating re-retire behind a retirement still in flight', async () => {
    // The catch branch has no service fixture at all, and the chaining half
    // is the branch that matters: `retire()` early-returns for an adapter
    // already in the map, so a re-retire issued WHILE one is in flight is
    // swallowed unless it waits. This fixture keeps the first retirement
    // open across the cleanup call — an earlier version awaited
    // `settleRetirements()` first, which emptied the map and silently
    // exercised the `else` branch instead, passing even with the chain
    // deleted (caught in review).
    const deps = makeDeps();
    const retirement = new AdapterRetirement(deps);
    let releaseFirstStop: (() => void) | undefined;
    let stopAllCalls = 0;
    const adapter = makeAdapter({
      stopAll: vi.fn(() => {
        stopAllCalls += 1;
        if (stopAllCalls > 1) return Promise.resolve();
        return new Promise<void>((resolve) => {
          releaseFirstStop = resolve;
        });
      }) as never,
      stopSession: vi.fn(async () => {
        throw new Error('stop failed');
      }) as never,
    });

    retirement.retire(adapter, new Map([['thread-a', session('thread-a')]]));
    await new Promise((resolve) => setTimeout(resolve, 0));
    // Still in flight: this is the state the chaining branch exists for.
    expect(retirement.retiringAdapters().has(adapter)).toBe(true);
    expect(stopAllCalls).toBe(1);

    await retirement.cleanupObsoleteStartedSession(adapter, 'thread-a');
    expect(deps.logger.warn).toHaveBeenCalledWith(
      'Obsolete provider session cleanup failed',
      expect.objectContaining({ threadId: 'thread-a' }),
    );
    // Nothing yet — the compensating retire is waiting on the first.
    expect(stopAllCalls).toBe(1);

    releaseFirstStop?.();
    await retirement.settleRetirements();
    await new Promise((resolve) => setTimeout(resolve, 10));
    await retirement.settleRetirements();

    // The chain fired: without it, `retire()`'s early return swallows the
    // compensating stop and the engine process is orphaned.
    expect(stopAllCalls).toBe(2);
  });

  it('drops its bookkeeping once a retirement settles, so shutdown sees nothing', async () => {
    // The stale-completion identity check (`get(adapter) === operation`) is
    // what makes this safe under overlapping retirements; the visible
    // consequence is that a settled adapter leaves no shutdown task.
    const retirement = new AdapterRetirement(makeDeps());
    const adapter = makeAdapter();
    retirement.retire(adapter, new Map([['thread-a', session('thread-a')]]));
    expect(retirement.retiringAdapters().has(adapter)).toBe(true);
    await retirement.settleRetirements();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(retirement.retiringAdapters().size).toBe(0);
    expect(retirement.shutdownRetirementTasks()).toEqual([]);
  });

  it('aggregates failures from settleRetirements rather than reporting the first', async () => {
    const retirement = new AdapterRetirement(
      makeDeps({ configuredStopTimeoutMs: () => 5 }),
    );
    const stuck = () =>
      makeAdapter({
        stopAll: vi.fn(() => new Promise<void>(() => {})) as never,
      });
    retirement.retire(stuck());
    retirement.retire(stuck());
    await expect(retirement.settleRetirements()).rejects.toThrow(
      AggregateError,
    );
  });
});
