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

  function setup(autoResume: () => boolean) {
    const store = new EventStore(
      join(makeTempDir('usage-limit-actions-'), 'orchestration.sqlite'),
    );
    const dispatch = vi.fn<RecoveryDispatchAdapter['dispatch']>(
      async ({ replay }) => {
        replay.signal.throwIfAborted();
        return { kind: 'accepted', turnId: 'resumed-turn' };
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
});
