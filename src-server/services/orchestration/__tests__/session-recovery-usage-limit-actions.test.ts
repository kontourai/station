import { join } from 'node:path';
import type { CanonicalRuntimeEvent } from '@kontourai/station-contracts/runtime-events';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { trackTempDirs } from '../../../__test-utils__/temp-dirs.js';
import { EventStore } from '../event-store.js';
import type { RecoveryDispatchAdapter } from '../recovery-dispatch-adapter.js';
import { SessionRecoveryCoordinator } from '../session-recovery-coordinator.js';

vi.mock('../../../telemetry/metrics.js', () => ({
  connectionRecoveryOutcomes: { add: vi.fn() },
  credentialProfileApplication: { add: vi.fn() },
  attachmentReplayRefusals: { add: vi.fn() },
  orchestrationEventsPersisted: { add: vi.fn() },
  orchestrationEventPersistDuration: { record: vi.fn() },
}));

/**
 * #3157: the banner's two person-owned actions on a usage-limit stop, "Resume
 * now" and "Cancel auto-resume", against the real coordinator, ledger and
 * event store. Each stop is armed through the real path: a `turn.started`
 * with a prompt, then the adapter's `runtime.error` carrying
 * `UsageLimitFailureDetails`.
 */
const STOPPED_AT = new Date('2026-09-24T21:00:00.000Z');
const RESET_AT = '2026-09-24T23:00:00.000Z';
const UNTIL_RESET_MS = Date.parse(RESET_AT) - STOPPED_AT.getTime();
const THREAD = 'limited-thread';

describe('#3157 usage-limit banner actions', () => {
  const makeTempDir = trackTempDirs();
  afterEach(() => {
    vi.useRealTimers();
  });

  function setup(autoResume: () => boolean, existing?: EventStore) {
    const store =
      existing ??
      new EventStore(
        join(makeTempDir('usage-limit-actions-'), 'orchestration.sqlite'),
      );
    let dispatched = 0;
    const dispatch = vi.fn<RecoveryDispatchAdapter['dispatch']>(
      async ({ replay }) => {
        replay.signal.throwIfAborted();
        dispatched += 1;
        return {
          kind: 'accepted',
          turnId:
            dispatched === 1 ? 'resumed-turn' : `resumed-turn-${dispatched}`,
        };
      },
    );
    const coordinator = new SessionRecoveryCoordinator({
      eventStore: store,
      adapterForProvider: () =>
        ({
          metadata: {
            recovery: {
              sameSession: true,
              maxAttempts: 1,
              dispatchSettlement: 'provider-response',
            },
          },
        }) as any,
      recoveryDispatchAdapter: { dispatch },
      autoResume,
      now: () => new Date(Date.now()),
    });
    return { store, coordinator, dispatch };
  }

  function observe(
    coordinator: SessionRecoveryCoordinator,
    store: EventStore,
    event: CanonicalRuntimeEvent,
  ) {
    store.appendEvent(event);
    coordinator.observe(event);
  }

  function stopOnUsageLimit(
    coordinator: SessionRecoveryCoordinator,
    store: EventStore,
    details: Record<string, unknown> = {
      usageLimit: true,
      scope: 'account',
      resetAt: RESET_AT,
    },
  ) {
    store.upsertSession({
      provider: 'codex',
      threadId: THREAD,
      status: 'ready',
      createdAt: STOPPED_AT.toISOString(),
      updatedAt: STOPPED_AT.toISOString(),
    });
    observe(coordinator, store, {
      eventId: 'limited-start',
      provider: 'codex',
      threadId: THREAD,
      turnId: 'limited-turn',
      createdAt: STOPPED_AT.toISOString(),
      method: 'turn.started',
      prompt: 'Finish the migration.',
    });
    observe(coordinator, store, {
      eventId: 'limited-error',
      provider: 'codex',
      threadId: THREAD,
      turnId: 'limited-turn',
      createdAt: STOPPED_AT.toISOString(),
      method: 'runtime.error',
      severity: 'error',
      code: details.usageLimit ? 'usageLimitExceeded' : 'rate_limit',
      retriable: false,
      message: details.usageLimit
        ? "You've hit your usage limit."
        : '429 too many requests',
      details,
    });
  }

  test('Resume now before the reset sends the turn once, even with automatic resume off, and the reset timer does not send it again', async () => {
    vi.useFakeTimers({ now: STOPPED_AT });
    const { store, coordinator, dispatch } = setup(() => false);
    stopOnUsageLimit(coordinator, store);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(dispatch).not.toHaveBeenCalled();

    await expect(coordinator.resumeUsageLimitNow(THREAD)).resolves.toEqual({
      kind: 'resumed',
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(dispatch).toHaveBeenCalledOnce();
    expect(dispatch.mock.calls[0]?.[0].replay).toMatchObject({
      threadId: THREAD,
      input: 'Finish the migration.',
    });
    expect(coordinator.latestProjection(THREAD)).toMatchObject({
      outcome: 'resumed',
      usageLimit: true,
    });

    await vi.advanceTimersByTimeAsync(UNTIL_RESET_MS + 60_000);
    expect(dispatch).toHaveBeenCalledOnce();
    await coordinator.dispose();
    store.close();
  });

  test('Resume now after the reset passed with automatic resume off sends the turn the user was left holding', async () => {
    vi.useFakeTimers({ now: STOPPED_AT });
    const { store, coordinator, dispatch } = setup(() => false);
    stopOnUsageLimit(coordinator, store);
    await vi.advanceTimersByTimeAsync(UNTIL_RESET_MS + 60_000);
    expect(coordinator.latestProjection(THREAD)).toMatchObject({
      outcome: 'manual',
      outcomeReason: 'auto-resume-off',
    });
    expect(dispatch).not.toHaveBeenCalled();

    await expect(coordinator.resumeUsageLimitNow(THREAD)).resolves.toEqual({
      kind: 'resumed',
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(dispatch).toHaveBeenCalledOnce();
    expect(coordinator.latestProjection(THREAD)).toMatchObject({
      outcome: 'resumed',
    });
    await coordinator.dispose();
    store.close();
  });

  test('Resume now works on a stop whose reset is unknown, which stays manual', async () => {
    vi.useFakeTimers({ now: STOPPED_AT });
    const { store, coordinator, dispatch } = setup(() => true);
    stopOnUsageLimit(coordinator, store, {
      usageLimit: true,
      scope: 'account',
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(coordinator.latestProjection(THREAD)).toMatchObject({
      outcome: 'manual',
      usageLimit: true,
    });
    expect(coordinator.latestProjection(THREAD)).not.toHaveProperty('dueAt');

    await expect(coordinator.resumeUsageLimitNow(THREAD)).resolves.toEqual({
      kind: 'resumed',
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(dispatch).toHaveBeenCalledOnce();
    await coordinator.dispose();
    store.close();
  });

  test('Resume now twice sends once: the second finds nothing waiting', async () => {
    vi.useFakeTimers({ now: STOPPED_AT });
    const { store, coordinator, dispatch } = setup(() => true);
    stopOnUsageLimit(coordinator, store);
    const [first, second] = await Promise.all([
      coordinator.resumeUsageLimitNow(THREAD),
      coordinator.resumeUsageLimitNow(THREAD),
    ]);
    await vi.advanceTimersByTimeAsync(0);
    expect([first.kind, second.kind].sort()).toEqual([
      'not-waiting',
      'resumed',
    ]);
    expect(dispatch).toHaveBeenCalledOnce();
    await coordinator.dispose();
    store.close();
  });

  test('Resume now with a request still open retires the stop with that reason and sends nothing', async () => {
    vi.useFakeTimers({ now: STOPPED_AT });
    const { store, coordinator, dispatch } = setup(() => true);
    stopOnUsageLimit(coordinator, store);
    observe(coordinator, store, {
      eventId: 'open-request',
      provider: 'codex',
      threadId: THREAD,
      turnId: 'limited-turn',
      createdAt: STOPPED_AT.toISOString(),
      method: 'request.opened',
      requestId: 'request-1',
      requestType: 'approval',
      title: 'Run the migration?',
    });
    await expect(coordinator.resumeUsageLimitNow(THREAD)).resolves.toEqual({
      kind: 'retired',
      reason: 'request-pending',
    });
    expect(dispatch).not.toHaveBeenCalled();
    expect(coordinator.latestProjection(THREAD)).toMatchObject({
      outcome: 'canceled',
      outcomeReason: 'request-pending',
    });
    await vi.advanceTimersByTimeAsync(UNTIL_RESET_MS + 60_000);
    expect(dispatch).not.toHaveBeenCalled();
    await coordinator.dispose();
    store.close();
  });

  test('Cancel auto-resume retires the waiting stop with a reason, and nothing is sent at the reset', async () => {
    vi.useFakeTimers({ now: STOPPED_AT });
    const { store, coordinator, dispatch } = setup(() => true);
    stopOnUsageLimit(coordinator, store);
    await vi.advanceTimersByTimeAsync(60_000);

    await expect(coordinator.cancelUsageLimitWaiting(THREAD)).resolves.toEqual({
      kind: 'canceled',
    });
    expect(coordinator.latestProjection(THREAD)).toMatchObject({
      outcome: 'canceled',
      outcomeReason: 'user-canceled',
      usageLimit: true,
      dueAt: RESET_AT,
    });
    await vi.advanceTimersByTimeAsync(UNTIL_RESET_MS + 60_000);
    expect(dispatch).not.toHaveBeenCalled();
    await coordinator.dispose();
    store.close();
  });

  test('a canceled stop offers no further action: Cancel and Resume now both find nothing waiting', async () => {
    vi.useFakeTimers({ now: STOPPED_AT });
    const { store, coordinator, dispatch } = setup(() => true);
    stopOnUsageLimit(coordinator, store);
    await coordinator.cancelUsageLimitWaiting(THREAD);

    await expect(coordinator.cancelUsageLimitWaiting(THREAD)).resolves.toEqual({
      kind: 'not-waiting',
    });
    await expect(coordinator.resumeUsageLimitNow(THREAD)).resolves.toEqual({
      kind: 'not-waiting',
    });
    await vi.advanceTimersByTimeAsync(UNTIL_RESET_MS + 60_000);
    expect(dispatch).not.toHaveBeenCalled();
    await coordinator.dispose();
    store.close();
  });

  test('a stop already resumed has nothing left to cancel', async () => {
    vi.useFakeTimers({ now: STOPPED_AT });
    const { store, coordinator, dispatch } = setup(() => true);
    stopOnUsageLimit(coordinator, store);
    await vi.advanceTimersByTimeAsync(UNTIL_RESET_MS);
    expect(dispatch).toHaveBeenCalledOnce();
    await expect(coordinator.cancelUsageLimitWaiting(THREAD)).resolves.toEqual({
      kind: 'not-waiting',
    });
    await expect(coordinator.resumeUsageLimitNow(THREAD)).resolves.toEqual({
      kind: 'not-waiting',
    });
    expect(dispatch).toHaveBeenCalledOnce();
    await coordinator.dispose();
    store.close();
  });

  test('the actions reach only usage-limit stops: an ordinary timed retry is not theirs to resume or cancel', async () => {
    vi.useFakeTimers({ now: STOPPED_AT });
    const { store, coordinator, dispatch } = setup(() => true);
    stopOnUsageLimit(coordinator, store, {
      scope: 'provider',
      retryAfterMs: 60_000,
    });
    await expect(coordinator.resumeUsageLimitNow(THREAD)).resolves.toEqual({
      kind: 'not-waiting',
    });
    await expect(coordinator.cancelUsageLimitWaiting(THREAD)).resolves.toEqual({
      kind: 'not-waiting',
    });
    expect(dispatch).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(dispatch).toHaveBeenCalledOnce();
    await coordinator.dispose();
    store.close();
  });

  test('an early Resume now refused by the same limit arms the replay for the reset instead of ending the wait', async () => {
    vi.useFakeTimers({ now: STOPPED_AT });
    const { store, coordinator, dispatch } = setup(() => true);
    stopOnUsageLimit(coordinator, store);
    await vi.advanceTimersByTimeAsync(60_000);
    await expect(coordinator.resumeUsageLimitNow(THREAD)).resolves.toEqual({
      kind: 'resumed',
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(dispatch).toHaveBeenCalledOnce();

    // The replayed turn starts with the claim's correlation, then the provider
    // refuses it with the same limit and the same reset.
    const replay = dispatch.mock.calls[0]?.[0].replay;
    observe(coordinator, store, {
      eventId: 'replay-start',
      provider: 'codex',
      threadId: THREAD,
      turnId: 'resumed-turn',
      createdAt: new Date(Date.now()).toISOString(),
      method: 'turn.started',
      prompt: 'Finish the migration.',
      metadata: { recoveryCorrelationId: replay?.recoveryCorrelationId },
    });
    observe(coordinator, store, {
      eventId: 'replay-error',
      provider: 'codex',
      threadId: THREAD,
      turnId: 'resumed-turn',
      createdAt: new Date(Date.now()).toISOString(),
      method: 'runtime.error',
      severity: 'error',
      code: 'usageLimitExceeded',
      retriable: false,
      message: "You've hit your usage limit.",
      details: { usageLimit: true, scope: 'account', resetAt: RESET_AT },
    });
    await vi.advanceTimersByTimeAsync(0);

    // The user still sees a waiting stop for the reset, not a spent one.
    expect(coordinator.latestProjection(THREAD)).toMatchObject({
      decision: 'wait-until-reset',
      outcome: 'armed',
      dueAt: RESET_AT,
      usageLimit: true,
    });
    expect(dispatch).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(UNTIL_RESET_MS);
    expect(dispatch).toHaveBeenCalledTimes(2);
    await coordinator.dispose();
    store.close();
  });

  test('a provider that always names a later reset re-arms at most three times in a row, then the intent ends failed', async () => {
    vi.useFakeTimers({ now: STOPPED_AT });
    const { store, coordinator, dispatch } = setup(() => true);
    stopOnUsageLimit(coordinator, store);
    const refuse = async (turnId: string, call: number) => {
      const replay = dispatch.mock.calls[call - 1]?.[0].replay;
      observe(coordinator, store, {
        eventId: `${turnId}-start`,
        provider: 'codex',
        threadId: THREAD,
        turnId,
        createdAt: new Date(Date.now()).toISOString(),
        method: 'turn.started',
        prompt: 'Finish the migration.',
        metadata: { recoveryCorrelationId: replay?.recoveryCorrelationId },
      });
      observe(coordinator, store, {
        eventId: `${turnId}-error`,
        provider: 'codex',
        threadId: THREAD,
        turnId,
        createdAt: new Date(Date.now()).toISOString(),
        method: 'runtime.error',
        severity: 'error',
        code: 'usageLimitExceeded',
        retriable: false,
        message: "You've hit your usage limit.",
        details: { usageLimit: true, scope: 'account', resetAt: RESET_AT },
      });
      await vi.advanceTimersByTimeAsync(0);
    };
    // Resume now, refused: re-armed (1), (2), (3); the fourth refusal ends it.
    const turns = [
      'resumed-turn',
      'resumed-turn-2',
      'resumed-turn-3',
      'resumed-turn-4',
    ];
    for (const [index, turnId] of turns.entries()) {
      await coordinator.resumeUsageLimitNow(THREAD);
      await vi.advanceTimersByTimeAsync(0);
      expect(dispatch).toHaveBeenCalledTimes(index + 1);
      await refuse(turnId, index + 1);
      expect(coordinator.latestProjection(THREAD)).toMatchObject({
        outcome: index < 3 ? 'armed' : 'failed',
      });
    }
    await vi.advanceTimersByTimeAsync(UNTIL_RESET_MS);
    expect(dispatch).toHaveBeenCalledTimes(4);
    await coordinator.dispose();
    store.close();
  });

  test.each([
    ['already past (a stale provider time)', -3_600_000],
    ['under the minimum wait', 30_000],
  ])(
    'a replay refused again with a reset %s ends failed after one dispatch, never looping',
    async (_label, offsetMs) => {
      vi.useFakeTimers({ now: STOPPED_AT });
      const { store, coordinator, dispatch } = setup(() => true);
      stopOnUsageLimit(coordinator, store);
      await vi.advanceTimersByTimeAsync(60_000);
      await coordinator.resumeUsageLimitNow(THREAD);
      await vi.advanceTimersByTimeAsync(0);
      const replay = dispatch.mock.calls[0]?.[0].replay;
      observe(coordinator, store, {
        eventId: 'replay-start',
        provider: 'codex',
        threadId: THREAD,
        turnId: 'resumed-turn',
        createdAt: new Date(Date.now()).toISOString(),
        method: 'turn.started',
        prompt: 'Finish the migration.',
        metadata: { recoveryCorrelationId: replay?.recoveryCorrelationId },
      });
      observe(coordinator, store, {
        eventId: 'replay-error',
        provider: 'codex',
        threadId: THREAD,
        turnId: 'resumed-turn',
        createdAt: new Date(Date.now()).toISOString(),
        method: 'runtime.error',
        severity: 'error',
        code: 'usageLimitExceeded',
        retriable: false,
        message: "You've hit your usage limit.",
        details: {
          usageLimit: true,
          scope: 'account',
          resetAt: new Date(Date.now() + offsetMs).toISOString(),
        },
      });
      await vi.advanceTimersByTimeAsync(0);
      expect(coordinator.latestProjection(THREAD)).toMatchObject({
        outcome: 'failed',
      });
      await vi.advanceTimersByTimeAsync(120_000);
      expect(dispatch).toHaveBeenCalledOnce();
      await coordinator.dispose();
      store.close();
    },
  );

  test('a resumed turn that fails for another reason still ends the intent, with nothing armed', async () => {
    vi.useFakeTimers({ now: STOPPED_AT });
    const { store, coordinator, dispatch } = setup(() => true);
    stopOnUsageLimit(coordinator, store);
    await coordinator.resumeUsageLimitNow(THREAD);
    await vi.advanceTimersByTimeAsync(0);
    const replay = dispatch.mock.calls[0]?.[0].replay;
    observe(coordinator, store, {
      eventId: 'replay-start',
      provider: 'codex',
      threadId: THREAD,
      turnId: 'resumed-turn',
      createdAt: new Date(Date.now()).toISOString(),
      method: 'turn.started',
      prompt: 'Finish the migration.',
      metadata: { recoveryCorrelationId: replay?.recoveryCorrelationId },
    });
    observe(coordinator, store, {
      eventId: 'replay-error',
      provider: 'codex',
      threadId: THREAD,
      turnId: 'resumed-turn',
      createdAt: new Date(Date.now()).toISOString(),
      method: 'runtime.error',
      severity: 'error',
      code: 'engine-turn-failed',
      retriable: false,
      message: 'The engine crashed.',
    });
    await vi.advanceTimersByTimeAsync(UNTIL_RESET_MS + 60_000);
    expect(coordinator.latestProjection(THREAD)).toMatchObject({
      outcome: 'failed',
    });
    expect(dispatch).toHaveBeenCalledOnce();
    await coordinator.dispose();
    store.close();
  });

  test('a stop with no known reset survives a graceful restart, still offering Resume now', async () => {
    vi.useFakeTimers({ now: STOPPED_AT });
    const dbPath = join(makeTempDir('usage-limit-restart-'), 'o.sqlite');
    const first = new EventStore(dbPath);
    const before = setup(() => true, first);
    stopOnUsageLimit(before.coordinator, first, {
      usageLimit: true,
      scope: 'account',
    });
    expect(before.coordinator.latestProjection(THREAD)).toMatchObject({
      outcome: 'manual',
      usageLimit: true,
    });
    await before.coordinator.dispose();
    first.close();

    const reopened = new EventStore(dbPath);
    const after = setup(() => true, reopened);
    after.coordinator.reconcile();
    await vi.advanceTimersByTimeAsync(0);
    expect(after.coordinator.latestProjection(THREAD)).toMatchObject({
      outcome: 'manual',
      usageLimit: true,
    });
    expect(after.dispatch).not.toHaveBeenCalled();
    await expect(
      after.coordinator.resumeUsageLimitNow(THREAD),
    ).resolves.toEqual({ kind: 'resumed' });
    await vi.advanceTimersByTimeAsync(0);
    expect(after.dispatch).toHaveBeenCalledOnce();
    await after.coordinator.dispose();
    reopened.close();
  });

  test('Resume now after a newer turn started (persisted, never observed) retires the stop as superseded and sends nothing', async () => {
    vi.useFakeTimers({ now: STOPPED_AT });
    const { store, coordinator, dispatch } = setup(() => true);
    stopOnUsageLimit(coordinator, store);
    store.appendEvent({
      eventId: 'newer-start',
      provider: 'codex',
      threadId: THREAD,
      turnId: 'newer-turn',
      createdAt: new Date(STOPPED_AT.getTime() + 1_000).toISOString(),
      method: 'turn.started',
      prompt: 'Something else.',
    });
    await expect(coordinator.resumeUsageLimitNow(THREAD)).resolves.toEqual({
      kind: 'retired',
      reason: 'superseded',
    });
    expect(dispatch).not.toHaveBeenCalled();
    expect(coordinator.latestProjection(THREAD)).toMatchObject({
      outcome: 'canceled',
      outcomeReason: 'superseded',
    });
    await coordinator.dispose();
    store.close();
  });

  describe('with a newer ordinary retry armed beside the usage-limit stop', () => {
    // Two failures of one turn: the usage limit, then an ordinary provider
    // 429 armed a moment later, so the ordinary intent is the newest one.
    async function stoppedBesideOrdinaryRetry() {
      const harness = setup(() => true);
      stopOnUsageLimit(harness.coordinator, harness.store);
      await vi.advanceTimersByTimeAsync(1_000);
      observe(harness.coordinator, harness.store, {
        eventId: 'ordinary-error',
        provider: 'codex',
        threadId: THREAD,
        turnId: 'limited-turn',
        createdAt: new Date(Date.now()).toISOString(),
        method: 'runtime.error',
        severity: 'error',
        code: 'rate_limit',
        retriable: false,
        message: '429 too many requests',
        details: { scope: 'provider', retryAfterMs: 3_600_000 },
      });
      const ledger = harness.store.createRecoveryLedger();
      expect(
        ledger.find(`${THREAD}:limited-turn:rate-limit:provider`),
      ).toMatchObject({ outcome: 'armed' });
      return { ...harness, ledger };
    }

    test('Resume now acts on the usage-limit stop, not the newest intent', async () => {
      vi.useFakeTimers({ now: STOPPED_AT });
      const { store, coordinator, dispatch, ledger } =
        await stoppedBesideOrdinaryRetry();
      await expect(coordinator.resumeUsageLimitNow(THREAD)).resolves.toEqual({
        kind: 'resumed',
      });
      await vi.advanceTimersByTimeAsync(0);
      expect(dispatch).toHaveBeenCalledOnce();
      expect(
        ledger.find(`${THREAD}:limited-turn:rate-limit:account`),
      ).toMatchObject({ usageLimit: true, outcome: 'resumed' });
      await coordinator.dispose();
      store.close();
    });

    test('Cancel auto-resume retires the usage-limit stop and leaves the ordinary retry armed', async () => {
      vi.useFakeTimers({ now: STOPPED_AT });
      const { store, coordinator, dispatch, ledger } =
        await stoppedBesideOrdinaryRetry();
      await expect(
        coordinator.cancelUsageLimitWaiting(THREAD),
      ).resolves.toEqual({ kind: 'canceled' });
      expect(
        ledger.find(`${THREAD}:limited-turn:rate-limit:account`),
      ).toMatchObject({ outcome: 'canceled', outcomeReason: 'user-canceled' });
      expect(
        ledger.find(`${THREAD}:limited-turn:rate-limit:provider`),
      ).toMatchObject({ outcome: 'armed' });
      expect(dispatch).not.toHaveBeenCalled();
      await coordinator.dispose();
      store.close();
    });
  });

  test('Resume now on a turn that can no longer be sent says it failed, not that it resumed', async () => {
    vi.useFakeTimers({ now: STOPPED_AT });
    const { store, coordinator, dispatch } = setup(() => true);
    store.upsertSession({
      provider: 'codex',
      threadId: THREAD,
      status: 'ready',
      createdAt: STOPPED_AT.toISOString(),
      updatedAt: STOPPED_AT.toISOString(),
    });
    // An attachment whose bytes were reclaimed: the turn cannot be replayed.
    observe(coordinator, store, {
      eventId: 'limited-start',
      provider: 'codex',
      threadId: THREAD,
      turnId: 'limited-turn',
      createdAt: STOPPED_AT.toISOString(),
      method: 'turn.started',
      prompt: 'Describe this screenshot.',
      attachments: [{ name: 'shot.png', mimeType: 'image/png' }],
    } as never);
    observe(coordinator, store, {
      eventId: 'limited-error',
      provider: 'codex',
      threadId: THREAD,
      turnId: 'limited-turn',
      createdAt: STOPPED_AT.toISOString(),
      method: 'runtime.error',
      severity: 'error',
      code: 'usageLimitExceeded',
      retriable: false,
      message: "You've hit your usage limit.",
      details: { usageLimit: true, scope: 'account', resetAt: RESET_AT },
    });
    await expect(coordinator.resumeUsageLimitNow(THREAD)).resolves.toEqual({
      kind: 'failed',
    });
    expect(dispatch).not.toHaveBeenCalled();
    expect(coordinator.latestProjection(THREAD)).toMatchObject({
      outcome: 'failed',
    });
    await coordinator.dispose();
    store.close();
  });
});
