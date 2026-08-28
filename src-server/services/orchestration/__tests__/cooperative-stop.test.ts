import { COOPERATIVE_STOP_BUDGET_MS } from '@kontourai/station-contracts/orchestration';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProviderAdapterShape } from '../../../providers/adapter-shape.js';
import {
  CooperativeStop,
  type CooperativeStopDeps,
} from '../cooperative-stop.js';

/**
 * Unit pins for the C4 extraction (epic archive#4024, archive#4204) — the three
 * contracts the service suite proved it CANNOT see (each ran green under
 * injection at the service level):
 *
 * 1. The `?? COOPERATIVE_STOP_BUDGET_MS` default arm: every service fixture
 *    configures the option, and a NaN budget fires the timer EARLY, so a
 *    positive "forced eventually happened" assertion cannot discriminate.
 *    Only a not-before/after pair can.
 * 2. The acknowledged path's `upsertLoadedSession({status:'ready'})`: at
 *    the service level the start row is already 'ready', masking the write.
 * 3. Single-dispatch across successive turn starts (the pre-dispatch clear
 *    is redundant behind coalescing — this pins the JOINT property).
 */

function makeDeps(overrides: Partial<CooperativeStopDeps> = {}) {
  const deps: CooperativeStopDeps = {
    configuredBudgetMs: () => undefined,
    // An open turn: the interruptible fold must resolve 'turn-a' or every
    // path early-returns no-active-turn.
    listSessionProjectionEvents: () => [
      {
        provider: 'claude',
        threadId: 'unit-thread',
        eventId: 'unit-turn-started',
        createdAt: '2026-08-01T00:00:01.000Z',
        method: 'turn.started',
        turnId: 'turn-a',
        prompt: 'unit',
      },
    ],
    sessionAdapterFor: () => undefined,
    publishEvent: vi.fn(),
    assertAdapterCurrentAfterCommand: () => {},
    loadedOrPersistedSession: () => ({
      provider: 'claude',
      threadId: 'unit-thread',
      status: 'running',
      createdAt: '2026-08-01T00:00:00.000Z',
      updatedAt: '2026-08-01T00:00:00.000Z',
    }),
    // archive#3493 residual 3: the durable-row reader the status
    // preservation consults; `undefined` models a store-less installation.
    persistedSession: () => undefined,
    upsertLoadedSession: vi.fn(),
    upsertSession: vi.fn(),
    forgetThreadState: vi.fn(),
    logger: { warn: vi.fn() },
    ...overrides,
  };
  return deps;
}

function makeAdapter(
  interruptTurn: ProviderAdapterShape['interruptTurn'],
): ProviderAdapterShape {
  return {
    provider: 'claude',
    interruptTurn,
    stopSession: vi.fn(async () => {}),
  } as unknown as ProviderAdapterShape;
}

describe('CooperativeStop (unit pins)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('holds the DEFAULT budget open and forces only after it elapses', async () => {
    const deps = makeDeps();
    const stop = new CooperativeStop(deps);
    const adapter = makeAdapter(vi.fn(() => new Promise(() => {})) as never);
    const outcome = stop.interruptUserTurnCooperatively(
      adapter,
      'unit-thread',
      'turn-a',
    );
    // Not before: a NaN/undefined budget (the dropped-default injection)
    // fires the timer immediately — this is the discriminating half.
    await vi.advanceTimersByTimeAsync(COOPERATIVE_STOP_BUDGET_MS - 100);
    expect(adapter.stopSession).not.toHaveBeenCalled();
    expect(deps.publishEvent).not.toHaveBeenCalledWith(
      expect.objectContaining({ method: 'session.stop-settled' }),
    );
    // After: the default elapses and the forced teardown runs.
    await vi.advanceTimersByTimeAsync(200);
    await outcome;
    expect(deps.publishEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        method: 'session.stop-settled',
        outcome: 'forced',
      }),
    );
    expect(adapter.stopSession).toHaveBeenCalledOnce();
  });

  it('marks the warm session resumable in memory on an acknowledged stop, and does not forget it', async () => {
    const deps = makeDeps({ configuredBudgetMs: () => 50 });
    const stop = new CooperativeStop(deps);
    const adapter = makeAdapter(
      vi.fn(async () => ({
        outcome: 'cancelled' as const,
        turnId: 'turn-a',
      })) as never,
    );
    await stop.interruptUserTurnCooperatively(adapter, 'unit-thread', 'turn-a');
    expect(deps.upsertLoadedSession).toHaveBeenCalledWith(
      'unit-thread',
      expect.objectContaining({ status: 'ready' }),
    );
    expect(deps.upsertSession).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'ready' }),
    );
    expect(deps.forgetThreadState).not.toHaveBeenCalled();
  });

  it('dispatches a recorded pending cancel at most once across successive turn starts', async () => {
    const deps = makeDeps({ configuredBudgetMs: () => 25 });
    const stop = new CooperativeStop(deps);
    const interruptTurn = vi.fn(() => new Promise(() => {}));
    const adapter = makeAdapter(interruptTurn as never);
    stop.recordPendingTurnInterrupt('unit-thread', {
      expiresAt: Date.now() + 60_000,
      startedTurnIds: new Set<string>(),
    });
    for (const turnId of ['turn-a', 'turn-b']) {
      stop.applyPendingTurnInterrupt(adapter, {
        provider: 'claude',
        threadId: 'unit-thread',
        eventId: `evt-${turnId}`,
        createdAt: new Date().toISOString(),
        method: 'turn.started',
        turnId,
        prompt: turnId,
      });
    }
    await vi.advanceTimersByTimeAsync(0);
    expect(interruptTurn).toHaveBeenCalledTimes(1);
  });
});
