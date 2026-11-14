import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { COOPERATIVE_STOP_BUDGET_MS } from '@kontourai/station-contracts/orchestration';
import type { CanonicalRuntimeEvent } from '@kontourai/station-contracts/runtime-events';
import {
  acquireStationHomeRuntimeLease,
  captureStationHomeRuntimeProof,
} from '@kontourai/station-shared/station-home-lifecycle';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { trackTempDirs } from '../../../__test-utils__/temp-dirs.js';
import type { ProviderAdapterShape } from '../../../providers/adapter-shape.js';
import { RuntimePublicationParticipant } from '../../../runtime/bootstrap/runtime-publication-participant.js';
import { HomeWriterOwner } from '../../ssh/home-writer-owner.js';
import {
  CooperativeStop,
  type CooperativeStopDeps,
} from '../cooperative-stop.js';
import { withReportRoundsPublication } from '../report-rounds-publication.js';

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
  it('refuses currency lost before the deferred adapter call without forced teardown and releases its stop slot', async () => {
    const deps = makeDeps();
    const stop = new CooperativeStop(deps);
    const adapter = makeAdapter(
      vi.fn(async () => ({ outcome: 'cancelled' as const, turnId: 'turn-a' })),
    );
    let current = true;
    const assertCurrent = () => {
      if (!current) throw Error('controlled authority loss');
    };
    const pending = stop.interruptUserTurnCooperatively(
      adapter,
      'unit-thread',
      'turn-a',
      'user',
      assertCurrent,
    );
    current = false;
    await expect(pending).rejects.toThrow('controlled authority loss');
    await vi.advanceTimersByTimeAsync(COOPERATIVE_STOP_BUDGET_MS + 1);
    expect(adapter.interruptTurn).not.toHaveBeenCalled();
    expect(adapter.stopSession).not.toHaveBeenCalled();
    expect(deps.publishEvent).not.toHaveBeenCalled();
    current = true;
    await expect(
      stop.interruptUserTurnCooperatively(
        adapter,
        'unit-thread',
        'turn-a',
        'user',
        assertCurrent,
      ),
    ).resolves.toMatchObject({ outcome: 'cooperative', turnId: 'turn-a' });
    expect(adapter.interruptTurn).toHaveBeenCalledOnce();
  });

  it('does not apply a deferred stop after its request authority is revoked', async () => {
    const deps = makeDeps();
    const stop = new CooperativeStop(deps);
    const interrupt = vi.fn(async () => ({
      outcome: 'cancelled' as const,
      turnId: 'turn-a',
    }));
    const adapter = makeAdapter(interrupt);
    let current = true;
    stop.recordPendingTurnInterrupt('unit-thread', {
      expiresAt: Date.now() + COOPERATIVE_STOP_BUDGET_MS * 2,
      turnId: 'turn-a',
      startedTurnIds: new Set(),
      assertCurrent: () => {
        if (!current) throw Error('controlled revoked deferred request');
      },
    });
    current = false;
    const event = deps.listSessionProjectionEvents('unit-thread')[0];
    stop.applyPendingTurnInterrupt(adapter, event);
    await vi.advanceTimersByTimeAsync(COOPERATIVE_STOP_BUDGET_MS + 1);
    expect(interrupt).not.toHaveBeenCalled();
    expect(adapter.stopSession).not.toHaveBeenCalled();
    expect(deps.publishEvent).not.toHaveBeenCalled();
    expect(deps.logger.warn).toHaveBeenCalledWith(
      'Deferred user stop could not be applied',
      expect.any(Object),
    );
  });

  it.each([
    'same-target',
    'replacement-turn',
    'replacement-invocation',
  ] as const)(
    'owned stop coalescing preserves the exact target (%s)',
    async (control) => {
      const deps = makeDeps();
      let start = {
        ...deps.listSessionProjectionEvents('unit-thread')[0],
        invocationId: 'inv-a',
      };
      deps.listSessionProjectionEvents = () => [start];
      let release!: () => void;
      const reply = new Promise<void>((resolve) => {
        release = resolve;
      });
      const interrupt = vi.fn(async () => {
        await reply;
        return { outcome: 'cancelled' as const, turnId: 'turn-a' };
      });
      const adapter = makeAdapter(interrupt);
      const stop = new CooperativeStop(deps);
      const cancel = (turnId: string) =>
        stop.interruptUserTurnCooperatively(
          adapter,
          'unit-thread',
          turnId,
          'user',
          () => {},
          async (invoke) => invoke((work) => work()),
        );
      const first = cancel('turn-a');
      await vi.advanceTimersByTimeAsync(0);
      expect(interrupt).toHaveBeenCalledOnce();
      if (control !== 'same-target')
        start = {
          ...start,
          eventId: 'replacement-start',
          turnId: control === 'replacement-turn' ? 'turn-b' : 'turn-a',
          invocationId: 'inv-b',
        };
      let secondSettled = false;
      const second = cancel(
        control === 'replacement-turn' ? 'turn-b' : 'turn-a',
      ).then(
        (value) => {
          secondSettled = true;
          return { kind: 'returned' as const, value };
        },
        (error: unknown) => {
          secondSettled = true;
          return { kind: 'refused' as const, error };
        },
      );
      try {
        await vi.advanceTimersByTimeAsync(0);
        expect(secondSettled).toBe(control !== 'same-target');
        if (control !== 'same-target')
          expect((await second).kind).toBe('refused');
        expect(interrupt).toHaveBeenCalledOnce();
        expect(adapter.stopSession).not.toHaveBeenCalled();
      } finally {
        release();
        const [original, joined] = await Promise.all([first, second]);
        expect(original).toMatchObject({
          outcome: 'cooperative',
          turnId: 'turn-a',
        });
        if (control === 'same-target')
          expect(joined).toMatchObject({
            kind: 'returned',
            value: { outcome: 'cooperative', turnId: 'turn-a' },
          });
      }
    },
  );

  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it.each(['pending', 'termination-unconfirmed'] as const)(
    'holds the DEFAULT budget open and forces only after it elapses (%s)',
    async (response) => {
      const deps = makeDeps();
      const stop = new CooperativeStop(deps);
      const adapter = makeAdapter(
        vi.fn(() =>
          response === 'pending'
            ? new Promise(() => {})
            : Promise.resolve({
                outcome: 'termination-unconfirmed',
                turnId: 'turn-a',
              }),
        ) as never,
      );
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
    },
  );

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

const temporary = trackTempDirs();

it.each([
  { phase: 'entry', state: 'initial-missing' },
  { phase: 'entry', state: 'initial-replacement' },
  { phase: 'entry', state: 'replacement' },
  { phase: 'entry', state: 'ended' },
  { phase: 'entry', state: 'completed' },
  { phase: 'entry', state: 'unconfirmed' },
  { phase: 'entry', state: 'unconfirmed-policy-refused' },
  { phase: 'entry', state: 'ended-successor' },
  { phase: 'entry', state: 'missing-terminal' },
  { phase: 'interrupt', state: 'missing-terminal' },
  { phase: 'forced', state: 'missing-terminal' },
  { phase: 'interrupt', state: 'replacement' },
  { phase: 'interrupt', state: 'ended' },
  { phase: 'interrupt', state: 'completed' },
  { phase: 'interrupt', state: 'unconfirmed' },
  { phase: 'interrupt', state: 'unconfirmed-policy-refused' },
  { phase: 'interrupt', state: 'ended-successor' },
  { phase: 'interrupt', state: 'stale-terminal' },
  { phase: 'interrupt', state: 'foreign-terminal' },
  { phase: 'interrupt', state: 'revoked-ended' },
  { phase: 'forced', state: 'replacement' },
  { phase: 'forced', state: 'ended' },
  { phase: 'forced', state: 'completed' },
  { phase: 'forced', state: 'unconfirmed' },
  { phase: 'forced', state: 'unconfirmed-policy-refused' },
  { phase: 'forced', state: 'ended-successor' },
  { phase: 'forced', state: 'stale-terminal' },
  { phase: 'forced', state: 'foreign-terminal' },
  { phase: 'forced', state: 'revoked-ended' },
] as const)(
  'rechecks owned $phase admission when the target is $state',
  async ({ phase, state }) => {
    const home = join(temporary('owned-stop-target-'), 'home');
    mkdirSync(home, { mode: 0o700 });
    const homeLease = acquireStationHomeRuntimeLease(home);
    mkdirSync(join(home, 'security'), { mode: 0o700 });
    const participant = new RuntimePublicationParticipant(
      captureStationHomeRuntimeProof(home, homeLease),
    );
    const writer = await HomeWriterOwner.forHome(home);
    const controller = new AbortController();
    let changedTarget = false;
    let authorityCurrent = true;
    let sessionCurrent = true;
    let snapshotRead!: () => void,
      adapterEntered!: () => void,
      changedRead!: () => void;
    const snapshot = new Promise<void>((resolve) => {
      snapshotRead = resolve;
    });
    const entered = new Promise<void>((resolve) => {
      adapterEntered = resolve;
    });
    const changed = new Promise<void>((resolve) => {
      changedRead = resolve;
    });
    let releaseReply!: () => void;
    const reply = new Promise<void>((resolve) => {
      releaseReply = resolve;
    });
    const deps = makeDeps({
      configuredBudgetMs: () => (phase === 'forced' ? 100 : 1000),
      preserveTerminationUncertainty: () =>
        state !== 'unconfirmed-policy-refused',
      listSessionProjectionEvents: () => {
        const start: CanonicalRuntimeEvent = {
          provider: 'claude',
          threadId: 'unit-thread',
          eventId: 'started-turn-a',
          createdAt: '2026-08-01T00:00:01.000Z',
          method: 'turn.started',
          turnId: 'turn-a',
          prompt: 'controlled',
          ...(state !== 'stale-terminal' ? { invocationId: 'inv-a' } : {}),
        };
        if (!changedTarget) {
          snapshotRead();
          if (state === 'initial-missing') return [];
          if (state === 'initial-replacement')
            return [
              {
                ...start,
                turnId: 'turn-b',
                invocationId: 'inv-b',
                eventId: 'started-turn-b',
              },
            ];
          return [start];
        }
        changedRead();
        const successor: CanonicalRuntimeEvent = {
          provider: 'claude',
          threadId: 'unit-thread',
          eventId: 'started-turn-b',
          createdAt: '2026-08-01T00:00:03.000Z',
          method: 'turn.started',
          turnId: 'turn-b',
          invocationId: 'inv-b',
          prompt: 'controlled successor',
        };
        const terminal: CanonicalRuntimeEvent = {
          provider: 'claude',
          threadId: 'unit-thread',
          eventId: 'ended-turn-a',
          createdAt: '2026-08-01T00:00:02.000Z',
          method: 'turn.aborted',
          turnId: 'turn-a',
          reason: 'controlled target ended',
          ...(state !== 'stale-terminal'
            ? {
                invocationId:
                  state === 'foreign-terminal' ? 'inv-foreign' : 'inv-a',
              }
            : {}),
        };
        if (state === 'completed')
          return [
            start,
            {
              provider: 'claude',
              threadId: 'unit-thread',
              eventId: 'completed-turn-a',
              createdAt: '2026-08-01T00:00:02.000Z',
              method: 'turn.completed',
              turnId: 'turn-a',
              invocationId: 'inv-a',
              finishReason: 'stop',
            },
          ];
        if (state === 'unconfirmed' || state === 'unconfirmed-policy-refused')
          return [
            start,
            {
              ...terminal,
              metadata: {
                physicalTermination: 'unconfirmed',
                accounting: 'unknown-held',
              },
            },
          ];
        if (state === 'replacement') return [start, successor];
        if (state === 'missing-terminal')
          return [
            start,
            {
              provider: 'claude',
              threadId: 'unit-thread',
              eventId: 'exited-session-a',
              createdAt: '2026-08-01T00:00:02.000Z',
              method: 'session.exited',
              sessionId: 'unit-thread',
              reason: 'controlled exit',
            },
          ];
        if (state === 'stale-terminal')
          return [
            { ...start, eventId: 'older-start-a' },
            { ...terminal, eventId: 'older-terminal-a' },
            start,
            successor,
          ];
        if (state === 'foreign-terminal' || state === 'ended-successor')
          return [start, terminal, successor];
        return [start, terminal];
      },
    });
    const interrupt = vi.fn(async () => {
      adapterEntered();
      await reply;
      return { outcome: 'cancelled' as const, turnId: 'turn-a' };
    });
    const adapter = makeAdapter(interrupt);
    const stop = new CooperativeStop(deps);
    const assertAuthorityCurrent = () => {
      writer.assertSynchronous();
      if (!authorityCurrent) throw Error('controlled authority lost');
    };
    let entryAdmitted = false;
    const changeTarget = () => {
      changedTarget = true;
      authorityCurrent = state !== 'revoked-ended';
      sessionCurrent =
        state === 'replacement' ||
        state === 'stale-terminal' ||
        state === 'foreign-terminal';
    };
    const pending = withReportRoundsPublication(
      { participant, home, signal: controller.signal },
      (publication) =>
        stop.interruptUserTurnCooperatively(
          adapter,
          'unit-thread',
          'turn-a',
          'user',
          () => {
            assertAuthorityCurrent();
            if (!sessionCurrent) throw Error('controlled target Session ended');
          },
          async (invoke) => {
            const result = await publication.invokeCurrent(
              { owner: writer, current: () => undefined },
              invoke,
            );
            if (phase === 'entry' && !entryAdmitted) {
              entryAdmitted = true;
              changeTarget();
            }
            return result;
          },
          assertAuthorityCurrent,
        ),
    );
    const outcome = pending.then(
      (value) => ({ kind: 'returned' as const, value }),
      (error: unknown) => ({ kind: 'refused' as const, error }),
    );
    const settledEarly = outcome.then((result) => {
      throw new Error('stop settled before the controlled checkpoint', {
        cause: result.kind === 'refused' ? result.error : undefined,
      });
    });
    void settledEarly.catch(() => undefined);
    try {
      if (phase !== 'entry') {
        await Promise.race([snapshot, settledEarly]);
        if (phase === 'forced') await Promise.race([entered, settledEarly]);
        changeTarget();
        await Promise.race([changed, settledEarly]);
      }
      releaseReply();
      const result = await outcome;
      if (
        state === 'ended' ||
        state === 'ended-successor' ||
        state === 'completed' ||
        state === 'unconfirmed'
      ) {
        expect(result.kind).toBe('returned');
        if (result.kind === 'returned') {
          expect(result.value).toMatchObject({
            outcome:
              state === 'completed'
                ? 'turn-completed'
                : state === 'unconfirmed'
                  ? 'termination-unconfirmed'
                  : 'no-active-turn',
            threadId: 'unit-thread',
          });
          if (state === 'completed' || state === 'unconfirmed')
            expect(result.value).toMatchObject({ turnId: 'turn-a' });
        }
      } else {
        expect(result.kind).toBe('refused');
        if (
          result.kind === 'refused' &&
          state !== 'missing-terminal' &&
          state !== 'initial-missing' &&
          state !== 'initial-replacement' &&
          state !== 'unconfirmed-policy-refused'
        )
          expect(String(result.error)).toContain(
            state === 'revoked-ended'
              ? 'controlled authority lost'
              : phase === 'forced'
                ? 'Stop target changed before forced admission'
                : 'Interrupt target changed before admission',
          );
      }
      expect(interrupt).toHaveBeenCalledTimes(phase === 'forced' ? 1 : 0);
      expect(adapter.stopSession).not.toHaveBeenCalled();
      expect(deps.publishEvent).not.toHaveBeenCalled();
      writer.runSynchronous(() => undefined);
    } finally {
      controller.abort();
      releaseReply();
      await outcome;
      participant.stop();
      await participant.drain(1000);
      await writer.settlePendingCleanup();
      homeLease.release();
    }
  },
  30_000,
);
