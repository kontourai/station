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
 * #3157: what a usage-limit stop does between the stop and the provider's
 * reset — whether Station resumes it, and why it does not. Each test arms
 * through the real path: a `turn.started` with a prompt, then the adapter's
 * `runtime.error` carrying `UsageLimitFailureDetails`.
 */
const STOPPED_AT = new Date('2026-09-24T21:00:00.000Z');
const RESET_AT = '2026-09-24T23:00:00.000Z';
const UNTIL_RESET_MS = Date.parse(RESET_AT) - STOPPED_AT.getTime();
const THREAD = 'limited-thread';

describe('#3157 usage-limit resume', () => {
  const makeTempDir = trackTempDirs();
  afterEach(() => {
    vi.useRealTimers();
  });

  function openStore(path?: string) {
    const dbPath =
      path ?? join(makeTempDir('usage-limit-resume-'), 'orchestration.sqlite');
    return { store: new EventStore(dbPath), path: dbPath };
  }

  function coordinatorFor(
    store: EventStore,
    autoResume: () => boolean | Promise<boolean>,
  ) {
    let sent = 0;
    const dispatch = vi.fn<RecoveryDispatchAdapter['dispatch']>(
      async ({ replay }) => {
        replay.signal.throwIfAborted();
        sent += 1;
        return { kind: 'accepted', turnId: `resumed-${sent}` };
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
    return { coordinator, dispatch };
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

  test('with automatic resume off, the stop waits with its reset visible and is never sent', async () => {
    vi.useFakeTimers({ now: STOPPED_AT });
    const { store } = openStore();
    const { coordinator, dispatch } = coordinatorFor(store, () => false);
    stopOnUsageLimit(coordinator, store);
    await vi.advanceTimersByTimeAsync(0);
    // The setting is applied at the reset, not before.
    expect(coordinator.latestProjection(THREAD)).toMatchObject({
      failureKind: 'rate-limit',
      decision: 'wait-until-reset',
      dueAt: RESET_AT,
      outcome: 'armed',
      usageLimit: true,
    });
    await vi.advanceTimersByTimeAsync(UNTIL_RESET_MS + 60_000);
    expect(dispatch).not.toHaveBeenCalled();
    expect(coordinator.latestProjection(THREAD)).toMatchObject({
      decision: 'wait-until-reset',
      dueAt: RESET_AT,
      outcome: 'manual',
      outcomeReason: 'auto-resume-off',
    });
    await coordinator.dispose();
    store.close();
  });

  test('turning the setting on before the reset sends exactly one resume', async () => {
    vi.useFakeTimers({ now: STOPPED_AT });
    const { store } = openStore();
    let enabled = false;
    const { coordinator, dispatch } = coordinatorFor(store, () => enabled);
    stopOnUsageLimit(coordinator, store);
    await vi.advanceTimersByTimeAsync(60_000);
    enabled = true;
    await vi.advanceTimersByTimeAsync(UNTIL_RESET_MS);
    expect(dispatch).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(24 * 60 * 60 * 1_000);
    expect(dispatch).toHaveBeenCalledOnce();
    await coordinator.dispose();
    store.close();
  });

  test('the setting gates only usage-limit stops: an ordinary timed retry still runs', async () => {
    vi.useFakeTimers({ now: STOPPED_AT });
    const { store } = openStore();
    const autoResume = vi.fn(() => false);
    const { coordinator, dispatch } = coordinatorFor(store, autoResume);
    stopOnUsageLimit(coordinator, store, {
      scope: 'provider',
      retryAfterMs: 60_000,
    });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(dispatch).toHaveBeenCalledOnce();
    expect(autoResume).not.toHaveBeenCalled();
    expect(coordinator.latestProjection(THREAD)).not.toHaveProperty(
      'usageLimit',
    );
    await coordinator.dispose();
    store.close();
  });

  test('a newer turn also retires a stop that was left to the user', async () => {
    vi.useFakeTimers({ now: STOPPED_AT });
    const { store } = openStore();
    const { coordinator, dispatch } = coordinatorFor(store, () => false);
    stopOnUsageLimit(coordinator, store);
    await vi.advanceTimersByTimeAsync(UNTIL_RESET_MS + 1_000);
    expect(coordinator.latestProjection(THREAD)).toMatchObject({
      outcome: 'manual',
      outcomeReason: 'auto-resume-off',
    });
    observe(coordinator, store, {
      eventId: 'moved-on-start',
      provider: 'codex',
      threadId: THREAD,
      turnId: 'moved-on-turn',
      createdAt: new Date(Date.now()).toISOString(),
      method: 'turn.started',
      prompt: 'Something else.',
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(coordinator.latestProjection(THREAD)).toMatchObject({
      outcome: 'canceled',
      outcomeReason: 'superseded',
    });
    expect(dispatch).not.toHaveBeenCalled();
    await coordinator.dispose();
    store.close();
  });

  test('with it on, exactly one resume is sent, and only after the reset', async () => {
    vi.useFakeTimers({ now: STOPPED_AT });
    const { store } = openStore();
    const { coordinator, dispatch } = coordinatorFor(store, () => true);
    stopOnUsageLimit(coordinator, store);
    await vi.advanceTimersByTimeAsync(UNTIL_RESET_MS - 1_000);
    expect(dispatch).not.toHaveBeenCalled();
    expect(coordinator.latestProjection(THREAD)).toMatchObject({
      decision: 'wait-until-reset',
      outcome: 'armed',
      dueAt: RESET_AT,
    });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(dispatch).toHaveBeenCalledOnce();
    expect(dispatch.mock.calls[0]?.[0].replay).toMatchObject({
      threadId: THREAD,
      input: 'Finish the migration.',
    });
    await vi.advanceTimersByTimeAsync(24 * 60 * 60 * 1_000);
    expect(dispatch).toHaveBeenCalledOnce();
    expect(coordinator.latestProjection(THREAD)).toMatchObject({
      outcome: 'resumed',
    });
    await coordinator.dispose();
    store.close();
  });

  test('turning the setting off before the reset stops a waiting resume', async () => {
    vi.useFakeTimers({ now: STOPPED_AT });
    const { store } = openStore();
    let enabled = true;
    const { coordinator, dispatch } = coordinatorFor(store, () => enabled);
    stopOnUsageLimit(coordinator, store);
    await vi.advanceTimersByTimeAsync(60_000);
    enabled = false;
    await vi.advanceTimersByTimeAsync(UNTIL_RESET_MS);
    expect(dispatch).not.toHaveBeenCalled();
    expect(coordinator.latestProjection(THREAD)).toMatchObject({
      outcome: 'manual',
      outcomeReason: 'auto-resume-off',
      dueAt: RESET_AT,
    });
    await coordinator.dispose();
    store.close();
  });

  test('a waiting resume survives a server restart and is sent exactly once after the reset', async () => {
    vi.useFakeTimers({ now: STOPPED_AT });
    const first = openStore();
    const before = coordinatorFor(first.store, () => true);
    stopOnUsageLimit(before.coordinator, first.store);
    await vi.advanceTimersByTimeAsync(60_000);
    await expect(before.coordinator.dispose()).resolves.toBeUndefined();
    first.store.close();

    const second = openStore(first.path);
    const after = coordinatorFor(second.store, () => true);
    after.coordinator.reconcile();
    expect(after.coordinator.latestProjection(THREAD)).toMatchObject({
      outcome: 'armed',
      dueAt: RESET_AT,
    });
    await vi.advanceTimersByTimeAsync(UNTIL_RESET_MS - 120_000);
    expect(after.dispatch).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(before.dispatch).not.toHaveBeenCalled();
    expect(after.dispatch).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(24 * 60 * 60 * 1_000);
    expect(after.dispatch).toHaveBeenCalledOnce();
    await after.coordinator.dispose();
    second.store.close();
  });

  test('restart rehydration does not send a resume while the setting is off', async () => {
    vi.useFakeTimers({ now: STOPPED_AT });
    const first = openStore();
    // Armed while on, so the restart finds a waiting intent with a timer.
    const before = coordinatorFor(first.store, () => true);
    stopOnUsageLimit(before.coordinator, first.store);
    await vi.advanceTimersByTimeAsync(0);
    await before.coordinator.dispose();
    first.store.close();

    const second = openStore(first.path);
    const after = coordinatorFor(second.store, () => false);
    after.coordinator.reconcile();
    await vi.advanceTimersByTimeAsync(UNTIL_RESET_MS + 60_000);
    expect(after.dispatch).not.toHaveBeenCalled();
    expect(after.coordinator.latestProjection(THREAD)).toMatchObject({
      outcome: 'manual',
      outcomeReason: 'auto-resume-off',
    });
    await after.coordinator.dispose();
    second.store.close();
  });

  test('a usage-limit stop with no reset is spared at shutdown and stays with the user (#3157 banner)', async () => {
    vi.useFakeTimers({ now: STOPPED_AT });
    const first = openStore();
    const before = coordinatorFor(first.store, () => true);
    stopOnUsageLimit(before.coordinator, first.store, {
      usageLimit: true,
      scope: 'account',
    });
    await before.coordinator.dispose();
    first.store.close();
    const second = openStore(first.path);
    const after = coordinatorFor(second.store, () => true);
    after.coordinator.reconcile();
    // Never dispatched on its own, so there is nothing for the fence to stop;
    // its banner still offers Resume now.
    expect(after.coordinator.latestProjection(THREAD)).toMatchObject({
      outcome: 'manual',
      usageLimit: true,
    });
    expect(after.dispatch).not.toHaveBeenCalled();
    await after.coordinator.dispose();
    second.store.close();
  });

  test('an unreadable setting counts as off', async () => {
    vi.useFakeTimers({ now: STOPPED_AT });
    const { store } = openStore();
    const { coordinator, dispatch } = coordinatorFor(store, () => {
      throw new Error('config unreadable');
    });
    stopOnUsageLimit(coordinator, store);
    await vi.advanceTimersByTimeAsync(UNTIL_RESET_MS + 1_000);
    expect(dispatch).not.toHaveBeenCalled();
    expect(coordinator.latestProjection(THREAD)).toMatchObject({
      outcome: 'manual',
      outcomeReason: 'auto-resume-off',
    });
    await coordinator.dispose();
    store.close();
  });

  test('the Session exiting cancels the waiting resume with session-ended', async () => {
    vi.useFakeTimers({ now: STOPPED_AT });
    const { store } = openStore();
    const { coordinator, dispatch } = coordinatorFor(store, () => true);
    stopOnUsageLimit(coordinator, store);
    observe(coordinator, store, {
      eventId: 'limited-exit',
      provider: 'codex',
      threadId: THREAD,
      createdAt: STOPPED_AT.toISOString(),
      method: 'session.exited',
      sessionId: THREAD,
      reason: 'stopped',
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(coordinator.latestProjection(THREAD)).toMatchObject({
      outcome: 'canceled',
      outcomeReason: 'session-ended',
    });
    await vi.advanceTimersByTimeAsync(UNTIL_RESET_MS + 1_000);
    expect(dispatch).not.toHaveBeenCalled();
    await coordinator.dispose();
    store.close();
  });

  test('a stop left to the user keeps its reset and reason across a restart', async () => {
    vi.useFakeTimers({ now: STOPPED_AT });
    const first = openStore();
    const before = coordinatorFor(first.store, () => false);
    stopOnUsageLimit(before.coordinator, first.store);
    await vi.advanceTimersByTimeAsync(UNTIL_RESET_MS + 1_000);
    await before.coordinator.dispose();
    first.store.close();
    const second = openStore(first.path);
    const after = coordinatorFor(second.store, () => true);
    after.coordinator.reconcile();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(after.coordinator.latestProjection(THREAD)).toMatchObject({
      outcome: 'manual',
      outcomeReason: 'auto-resume-off',
      dueAt: RESET_AT,
    });
    // Left to the user: a restart does not turn it into a dispatch.
    expect(after.dispatch).not.toHaveBeenCalled();
    await after.coordinator.dispose();
    second.store.close();
  });

  test('a newer user turn cancels the waiting resume at once, with a reason', async () => {
    vi.useFakeTimers({ now: STOPPED_AT });
    const { store } = openStore();
    const { coordinator, dispatch } = coordinatorFor(store, () => true);
    stopOnUsageLimit(coordinator, store);
    await vi.advanceTimersByTimeAsync(60_000);
    observe(coordinator, store, {
      eventId: 'newer-start',
      provider: 'codex',
      threadId: THREAD,
      turnId: 'newer-turn',
      createdAt: new Date(Date.now()).toISOString(),
      method: 'turn.started',
      prompt: 'Actually, do something else.',
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(coordinator.latestProjection(THREAD)).toMatchObject({
      outcome: 'canceled',
      outcomeReason: 'superseded',
    });
    await vi.advanceTimersByTimeAsync(UNTIL_RESET_MS);
    expect(dispatch).not.toHaveBeenCalled();
    await coordinator.dispose();
    store.close();
  });

  test('a newer turn in the successor Session of the same conversation also supersedes it', async () => {
    vi.useFakeTimers({ now: STOPPED_AT });
    const { store } = openStore();
    const { coordinator, dispatch } = coordinatorFor(store, () => true);
    stopOnUsageLimit(coordinator, store);
    // Claude refuses another turn on a failed Session; a follow-up runs in a
    // successor Session of the same conversation.
    const successor = store.reserveNextConversationSession({
      conversationId: THREAD,
      predecessorSessionId: THREAD,
      proposedSessionId: `${THREAD}:session:next`,
      createdAt: STOPPED_AT.toISOString(),
    }).lineage.sessionId;
    observe(coordinator, store, {
      eventId: 'successor-start',
      provider: 'codex',
      threadId: successor,
      turnId: 'successor-turn',
      createdAt: STOPPED_AT.toISOString(),
      method: 'turn.started',
      prompt: 'Continue here instead.',
    });
    await vi.advanceTimersByTimeAsync(UNTIL_RESET_MS + 1_000);
    expect(dispatch).not.toHaveBeenCalled();
    expect(coordinator.latestProjection(THREAD)).toMatchObject({
      outcome: 'canceled',
      outcomeReason: 'superseded',
    });
    await coordinator.dispose();
    store.close();
  });

  test('a request still open when the reset passes cancels the resume, with a reason', async () => {
    vi.useFakeTimers({ now: STOPPED_AT });
    const { store } = openStore();
    const { coordinator, dispatch } = coordinatorFor(store, () => true);
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
    await vi.advanceTimersByTimeAsync(UNTIL_RESET_MS + 1_000);
    expect(dispatch).not.toHaveBeenCalled();
    expect(coordinator.latestProjection(THREAD)).toMatchObject({
      outcome: 'canceled',
      outcomeReason: 'request-pending',
    });
    await coordinator.dispose();
    store.close();
  });

  test('a Session closed before the reset cancels the resume, with a reason', async () => {
    vi.useFakeTimers({ now: STOPPED_AT });
    const { store } = openStore();
    const { coordinator, dispatch } = coordinatorFor(store, () => true);
    stopOnUsageLimit(coordinator, store);
    store.markSessionClosed(THREAD, 'codex');
    await vi.advanceTimersByTimeAsync(UNTIL_RESET_MS + 1_000);
    expect(dispatch).not.toHaveBeenCalled();
    expect(coordinator.latestProjection(THREAD)).toMatchObject({
      outcome: 'canceled',
      outcomeReason: 'session-ended',
    });
    await coordinator.dispose();
    store.close();
  });

  test('a stop with no reported reset is manual and never sent, whatever the setting', async () => {
    vi.useFakeTimers({ now: STOPPED_AT });
    const { store } = openStore();
    const { coordinator, dispatch } = coordinatorFor(store, () => true);
    stopOnUsageLimit(coordinator, store, {
      usageLimit: true,
      scope: 'account',
    });
    await vi.advanceTimersByTimeAsync(48 * 60 * 60 * 1_000);
    expect(dispatch).not.toHaveBeenCalled();
    expect(coordinator.latestProjection(THREAD)).toMatchObject({
      failureKind: 'rate-limit',
      decision: 'manual',
      outcome: 'manual',
    });
    expect(coordinator.latestProjection(THREAD)).not.toHaveProperty(
      'outcomeReason',
    );
    await coordinator.dispose();
    store.close();
  });
});
