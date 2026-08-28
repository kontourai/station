import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { NotificationService } from '../../notifications/notification-service.js';
import { EventBus } from '../event-bus.js';
import {
  anyPersonalOrchestrationStreamPresenceSubject,
  OrchestrationStreamPresence,
  type OrchestrationStreamPresenceSubject,
  orchestrationStreamPresenceSubjectForSession,
} from '../orchestration-stream-presence.js';
import {
  resolveTurnCompletionOutcome,
  wireInternalStopRedispatchFailureNotifications,
  wireTurnCompletionNotifications,
} from '../turn-completion-notifications.js';

vi.mock('../../../telemetry/metrics.js', () => ({
  notificationOps: { add: vi.fn() },
  orchestrationEventPersistDuration: { record: vi.fn() },
  orchestrationEventsPersisted: { add: vi.fn() },
  orchestrationStreamPresenceOps: { add: vi.fn() },
  turnCompletionNotificationOps: { add: vi.fn() },
}));

function baseEvent(overrides: Record<string, unknown> = {}) {
  return {
    createdAt: new Date().toISOString(),
    method: 'turn.completed',
    provider: 'claude',
    threadId: 'thread-1',
    turnId: 'turn-1',
    ...overrides,
  };
}

describe('resolveTurnCompletionOutcome', () => {
  test('turn.completed -> done, turn.aborted -> failed, runtime.error -> failed, everything else -> undefined', async () => {
    expect(resolveTurnCompletionOutcome({ method: 'turn.completed' })).toBe(
      'done',
    );
    expect(resolveTurnCompletionOutcome({ method: 'turn.aborted' })).toBe(
      'failed',
    );
    // archive#3442: this is the ONLY event a genuine stream/runtime failure
    // publishes while a turnId is known (bedrock/ollama's
    // `publishTurnFailure`, codex-adapter-notifications' `'error'` case and
    // its `turn.status === 'failed'` branch) — without this arm a failed
    // turn produced no push notification at all. NOT covered:
    // codex-adapter-transport's `finalizeUnexpectedExit` (an app-server
    // process dying mid-turn) publishes `session.exited`, never
    // `runtime.error`, and carries no `turnId` — that case remains
    // uncovered by this listener, disclosed rather than claimed.
    expect(resolveTurnCompletionOutcome({ method: 'runtime.error' })).toBe(
      'failed',
    );
    expect(
      resolveTurnCompletionOutcome({ method: 'content.text-delta' }),
    ).toBeUndefined();
    expect(
      resolveTurnCompletionOutcome({ method: 'turn.started' }),
    ).toBeUndefined();
  });

  test('station#3442 round 2 (HIGH-1): a codex runtime.error with retriable=true (willRetry) defers — codex may resolve the SAME turn without a new turn.started', async () => {
    expect(
      resolveTurnCompletionOutcome({
        method: 'runtime.error',
        provider: 'codex',
        retriable: true,
      }),
    ).toBeUndefined();
  });

  test('a codex runtime.error with retriable=false (or unset) still resolves failed — codex reports this as terminal', async () => {
    expect(
      resolveTurnCompletionOutcome({
        method: 'runtime.error',
        provider: 'codex',
        retriable: false,
      }),
    ).toBe('failed');
    expect(
      resolveTurnCompletionOutcome({
        method: 'runtime.error',
        provider: 'codex',
      }),
    ).toBe('failed');
  });

  test('a non-codex runtime.error with retriable=true still resolves failed — station-agent-adapter hardcodes retriable:true for turns that are ALREADY terminal', async () => {
    expect(
      resolveTurnCompletionOutcome({
        method: 'runtime.error',
        provider: 'station-agent',
        retriable: true,
      }),
    ).toBe('failed');
  });
});

describe('wireTurnCompletionNotifications (station#1225)', () => {
  let bus: EventBus;
  let dir: string;
  let notificationService: NotificationService;

  async function emit(
    event: Parameters<EventBus['emit']>[0],
    data?: Parameters<EventBus['emit']>[1],
  ): Promise<void> {
    bus.emit(event, data);
    await notificationService.drainAsyncDispatch();
  }
  let presence: OrchestrationStreamPresence;
  let resolveSessionPresenceSubject: (
    threadId: string,
  ) => OrchestrationStreamPresenceSubject | undefined;
  let logger: {
    warn: ReturnType<
      typeof vi.fn<(message: string, meta?: Record<string, unknown>) => void>
    >;
  };

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'turn-completion-notifications-'));
    bus = new EventBus();
    notificationService = new NotificationService(bus, dir, 999_999);
    presence = new OrchestrationStreamPresence();
    resolveSessionPresenceSubject = () =>
      orchestrationStreamPresenceSubjectForSession('owner-1');
    logger = {
      warn: vi.fn<(message: string, meta?: Record<string, unknown>) => void>(),
    };
    wireTurnCompletionNotifications(
      bus,
      {
        resolveSessionPresenceSubject: (threadId) =>
          resolveSessionPresenceSubject(threadId),
      },
      presence,
      notificationService,
      logger,
    );
    await notificationService.start();
  });

  afterEach(async () => {
    await notificationService.shutdown();
    rmSync(dir, { force: true, recursive: true });
  });

  test('schedules a "done" notification when the owner has no live stream open', async () => {
    await emit('orchestration:event', { event: baseEvent() });

    const notifications = await notificationService.list();
    expect(notifications).toHaveLength(1);
    expect(notifications[0]).toEqual(
      expect.objectContaining({
        category: 'turn-completed',
        title: 'Your agent finished',
        metadata: expect.objectContaining({
          sessionId: 'thread-1',
          sessionKind: 'runtime',
          threadId: 'thread-1',
          turnId: 'turn-1',
        }),
      }),
    );
  });

  test('schedules a "failed" notification for turn.aborted', async () => {
    await emit('orchestration:event', {
      event: baseEvent({ method: 'turn.aborted', reason: 'crashed' }),
    });

    const notifications = await notificationService.list();
    expect(notifications).toHaveLength(1);
    expect(notifications[0]).toEqual(
      expect.objectContaining({
        category: 'turn-failed',
        priority: 'high',
      }),
    );
  });

  test('a settled stop immediately before Codex turn.completed(cancelled) notifies that the agent stopped', async () => {
    // Isolate the listener's classification/payload from the host's
    // birth-fingerprint-protected JSON mutation lock. Persistence has its own
    // coverage; this test proves the notification never reaches that seam as
    // a high-priority failure in the first place.
    const schedule = vi
      .spyOn(notificationService, 'schedule')
      .mockResolvedValue({} as never);
    await emit('orchestration:event', {
      event: baseEvent({
        method: 'session.stop-settled',
        outcome: 'forced',
        initiatedBy: 'user',
      }),
    });
    await emit('orchestration:event', {
      event: baseEvent({
        method: 'turn.completed',
        finishReason: 'cancelled',
      }),
    });

    expect(schedule).toHaveBeenCalledWith(
      'turn-completion',
      expect.objectContaining({
        category: 'turn-stopped',
        title: 'Your agent stopped',
        body: 'Agent stopped in session thread-1',
        priority: 'normal',
      }),
    );
  });

  test('an unaccompanied Codex turn.completed(cancelled) keeps the existing completed mapping', async () => {
    const schedule = vi
      .spyOn(notificationService, 'schedule')
      .mockResolvedValue({} as never);

    await emit('orchestration:event', {
      event: baseEvent({
        method: 'turn.completed',
        finishReason: 'cancelled',
      }),
    });

    expect(schedule).toHaveBeenCalledWith(
      'turn-completion',
      expect.objectContaining({
        category: 'turn-completed',
        title: 'Your agent finished',
        priority: 'normal',
      }),
    );
  });

  test('station#3442 fix: schedules a "failed" notification for runtime.error (a codex usage-limit death, or any other genuine stream failure) — the case that previously produced NO push at all', async () => {
    await emit('orchestration:event', {
      event: baseEvent({
        method: 'runtime.error',
        severity: 'error',
        message: 'usage limit reached',
      }),
    });

    const notifications = await notificationService.list();
    expect(notifications).toHaveLength(1);
    expect(notifications[0]).toEqual(
      expect.objectContaining({
        category: 'turn-failed',
        title: 'Your agent needs attention',
        priority: 'high',
        metadata: expect.objectContaining({
          sessionId: 'thread-1',
          sessionKind: 'runtime',
          threadId: 'thread-1',
          turnId: 'turn-1',
        }),
      }),
    );
  });

  test('station#3442 round 2 (HIGH-1): a codex runtime.error with retriable=true schedules NO notification — the high-priority alarm this fix was blocking', async () => {
    await emit('orchestration:event', {
      event: baseEvent({
        method: 'runtime.error',
        provider: 'codex',
        severity: 'error',
        message: 'usage limit reached, retrying',
        retriable: true,
      }),
    });
    expect(await notificationService.list()).toHaveLength(0);
  });

  test('station#3442 round 2 (HIGH-1 self-heal): a codex retriable runtime.error followed by turn.completed for the SAME turnId ends as exactly one "done" notification, never a stray "needs attention"', async () => {
    await emit('orchestration:event', {
      event: baseEvent({
        method: 'runtime.error',
        provider: 'codex',
        severity: 'error',
        message: 'usage limit reached, retrying',
        retriable: true,
      }),
    });
    expect(await notificationService.list()).toHaveLength(0);

    await emit('orchestration:event', {
      event: baseEvent({ method: 'turn.completed', provider: 'codex' }),
    });
    const notifications = await notificationService.list();
    expect(notifications).toHaveLength(1);
    expect(notifications[0]).toEqual(
      expect.objectContaining({
        category: 'turn-completed',
        title: 'Your agent finished',
        priority: 'normal',
      }),
    );
  });

  test('station#3442 round 2 (HIGH-1 regression control): a codex NON-retriable runtime.error still schedules the failed notification immediately', async () => {
    await emit('orchestration:event', {
      event: baseEvent({
        method: 'runtime.error',
        provider: 'codex',
        severity: 'error',
        message: 'fatal codex error',
        retriable: false,
      }),
    });
    const notifications = await notificationService.list();
    expect(notifications).toHaveLength(1);
    expect(notifications[0]).toEqual(
      expect.objectContaining({ category: 'turn-failed', priority: 'high' }),
    );
  });

  test('station#3442 round 2 (MEDIUM-4): a runtime.error with no turnId schedules nothing — six real adapter sites publish exactly this shape', async () => {
    await emit('orchestration:event', {
      event: {
        createdAt: new Date().toISOString(),
        method: 'runtime.error',
        provider: 'claude',
        threadId: 'thread-1',
        severity: 'error',
        message: 'adapter stream died',
        retriable: true,
        // deliberately no turnId
      },
    });
    expect(await notificationService.list()).toHaveLength(0);
  });

  test('station#3442 round 2 (LOW-5): two different turns on the SAME thread produce two distinct notifications, not one deduped row', async () => {
    await emit('orchestration:event', {
      event: baseEvent({ turnId: 'turn-1' }),
    });
    await emit('orchestration:event', {
      event: baseEvent({ turnId: 'turn-2' }),
    });
    const notifications = await notificationService.list();
    expect(notifications).toHaveLength(2);
    const turnIds = notifications
      .map((n) => (n.metadata as Record<string, unknown>)?.turnId)
      .sort();
    expect(turnIds).toEqual(['turn-1', 'turn-2']);
  });

  // archive#3573: the stale-terminal companion to archive#3581/#3572. A codex
  // session runs turn-1, then turn-2; turn-2 fails for real; turn-1's late
  // `turn/completed` (codex's own protocol timing, archive#3572) then arrives naming
  // a turn the session has already moved past. Before this fix,
  // `resolveTurnCompletionOutcome` classified purely on method with no
  // identity check at all, so this listener fired a "Your agent finished"
  // push for turn-1 while turn-2 was the one that actually failed and is
  // still the thread's real outcome — the exact spurious/premature
  // notification the issue describes, and the dedupeTag (`turnId`-scoped)
  // does not suppress it against turn-2's own eventual terminal because they
  // are different turn ids.
  test('station#3573: a stale turn.completed for a superseded turn schedules NO notification, and the real terminal for the current turn still does', async () => {
    await emit('orchestration:event', {
      event: {
        createdAt: new Date().toISOString(),
        method: 'turn.started',
        provider: 'codex',
        threadId: 'thread-1',
        turnId: 'turn-1',
        prompt: 'first turn',
      },
    });
    await emit('orchestration:event', {
      event: {
        createdAt: new Date().toISOString(),
        method: 'turn.started',
        provider: 'codex',
        threadId: 'thread-1',
        turnId: 'turn-2',
        prompt: 'second turn',
      },
    });
    await emit('orchestration:event', {
      event: {
        createdAt: new Date().toISOString(),
        method: 'runtime.error',
        provider: 'codex',
        threadId: 'thread-1',
        turnId: 'turn-2',
        severity: 'error',
        message: 'usage limit reached',
        retriable: false,
      },
    });
    // The genuine failure schedules its "needs attention" push immediately.
    expect(await notificationService.list()).toHaveLength(1);

    // The stale/orphaned turn-1 completion arrives after turn-2's real
    // failure. It must NOT schedule a second, contradictory "finished" push.
    await emit('orchestration:event', {
      event: {
        createdAt: new Date().toISOString(),
        method: 'turn.completed',
        provider: 'codex',
        threadId: 'thread-1',
        turnId: 'turn-1',
        finishReason: 'other',
      },
    });
    const afterStale = await notificationService.list();
    expect(afterStale).toHaveLength(1);
    expect(afterStale[0]).toEqual(
      expect.objectContaining({ category: 'turn-failed' }),
    );
  });

  test('does NOT schedule a notification when the owning user is actively connected', async () => {
    const disconnect = presence.connect('owner-1');
    await emit('orchestration:event', { event: baseEvent() });
    expect(await notificationService.list()).toHaveLength(0);
    disconnect();
  });

  test('falls back to hasAnyConnection when the session has no resolvable owner (single-user-compat)', async () => {
    resolveSessionPresenceSubject = () =>
      anyPersonalOrchestrationStreamPresenceSubject();
    const disconnect = presence.connect('some-other-connected-user');
    await emit('orchestration:event', { event: baseEvent() });
    expect(await notificationService.list()).toHaveLength(0);

    disconnect();
    await emit('orchestration:event', {
      event: baseEvent({ turnId: 'turn-2' }),
    });
    expect(await notificationService.list()).toHaveLength(1);
  });

  test('does not let alpha presence suppress a bravo completion for the same user', async () => {
    const alpha = orchestrationStreamPresenceSubjectForSession('shared-user', {
      tenantId: 'alpha' as any,
      source: 'session',
    });
    const bravo = orchestrationStreamPresenceSubjectForSession('shared-user', {
      tenantId: 'bravo' as any,
      source: 'session',
    });
    resolveSessionPresenceSubject = (threadId) =>
      threadId === 'alpha-thread' ? alpha : bravo;
    const disconnectAlpha = presence.connect(alpha);

    await emit('orchestration:event', {
      event: baseEvent({ threadId: 'bravo-thread' }),
    });
    expect(await notificationService.list()).toHaveLength(1);

    await emit('orchestration:event', {
      event: baseEvent({ threadId: 'alpha-thread', turnId: 'turn-2' }),
    });
    expect(await notificationService.list()).toHaveLength(1);
    disconnectAlpha();
  });

  test('never leaks response text into the push body', async () => {
    await emit('orchestration:event', {
      event: baseEvent({ outputText: 'THE SECRET ANSWER IS 42' }),
    });
    const [notification] = await notificationService.list();
    expect(notification.body).not.toContain('THE SECRET ANSWER IS 42');
    expect(notification.body).toContain('thread-1');
  });

  test('ignores non-terminal orchestration events (e.g. content deltas)', async () => {
    await emit('orchestration:event', {
      event: {
        createdAt: new Date().toISOString(),
        method: 'content.text-delta',
        provider: 'claude',
        threadId: 'thread-1',
        itemId: 'item-1',
        delta: 'hello',
      },
    });
    expect(await notificationService.list()).toHaveLength(0);
  });

  test('dedupes a duplicate turn.completed for the same (threadId, turnId)', async () => {
    await emit('orchestration:event', { event: baseEvent() });
    await emit('orchestration:event', { event: baseEvent() });
    expect(await notificationService.list()).toHaveLength(1);
  });

  test('station#1225 HIGH fix: a throwing presence-subject lookup is caught, logged, and does NOT unsubscribe the listener — a later event still schedules', async () => {
    resolveSessionPresenceSubject = () => {
      throw new Error('simulated event-store read failure');
    };
    await emit('orchestration:event', { event: baseEvent() });

    // The throwing call produced no notification and no rethrow...
    expect(await notificationService.list()).toHaveLength(0);
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.warn.mock.calls[0][0]).toContain('turn-completion');

    // ...and, critically, EventBus did NOT permanently delete this listener
    // for throwing (its normal behavior for an unguarded subscriber) — a
    // subsequent, non-throwing event still schedules.
    resolveSessionPresenceSubject = () =>
      orchestrationStreamPresenceSubjectForSession('owner-1');
    await emit('orchestration:event', {
      event: baseEvent({ turnId: 'turn-2' }),
    });
    expect(await notificationService.list()).toHaveLength(1);
  });

  test('station#1225 HIGH fix: a throwing notificationService.schedule is caught, logged, and does NOT unsubscribe the listener', async () => {
    const scheduleSpy = vi
      .spyOn(notificationService, 'schedule')
      .mockImplementationOnce(async () => {
        throw new Error('simulated JsonFileStore write failure (ENOSPC)');
      });
    await emit('orchestration:event', { event: baseEvent() });

    expect(await notificationService.list()).toHaveLength(0);
    expect(logger.warn).toHaveBeenCalledTimes(1);

    scheduleSpy.mockRestore();
    await emit('orchestration:event', {
      event: baseEvent({ turnId: 'turn-2' }),
    });
    expect(await notificationService.list()).toHaveLength(1);
  });
});

describe('wireTurnCompletionNotifications station#3525 internal-stop suppression', () => {
  let bus: EventBus;
  let dir: string;
  let notificationService: NotificationService;
  let presence: OrchestrationStreamPresence;
  let logger: {
    warn: ReturnType<
      typeof vi.fn<(message: string, meta?: Record<string, unknown>) => void>
    >;
  };
  let consumeInternalStopSuppression: (turnId: string) => boolean;

  async function emit(
    event: Parameters<EventBus['emit']>[0],
    data?: Parameters<EventBus['emit']>[1],
  ): Promise<void> {
    bus.emit(event, data);
    await notificationService.drainAsyncDispatch();
  }

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'turn-completion-notifications-stop-'));
    bus = new EventBus();
    notificationService = new NotificationService(bus, dir, 999_999);
    presence = new OrchestrationStreamPresence();
    logger = {
      warn: vi.fn<(message: string, meta?: Record<string, unknown>) => void>(),
    };
    consumeInternalStopSuppression = () => false;
    wireTurnCompletionNotifications(
      bus,
      {
        resolveSessionPresenceSubject: () =>
          orchestrationStreamPresenceSubjectForSession('owner-1'),
        consumeInternalStopSuppression: (turnId) =>
          consumeInternalStopSuppression(turnId),
      },
      presence,
      notificationService,
      logger,
    );
    await notificationService.start();
  });

  afterEach(async () => {
    await notificationService.shutdown();
    rmSync(dir, { force: true, recursive: true });
  });

  test('schedules no notification for a turn id armed by an internal-machinery stop', async () => {
    consumeInternalStopSuppression = (turnId) => turnId === 'turn-1';
    await emit('orchestration:event', {
      event: {
        createdAt: new Date().toISOString(),
        method: 'runtime.error',
        provider: 'codex',
        threadId: 'thread-1',
        turnId: 'turn-1',
        severity: 'error',
        message: 'Codex session was stopped before the turn finished.',
        code: 'codex-turn-orphaned',
      },
    });
    expect(await notificationService.list()).toHaveLength(0);
  });

  test('does not suppress an unrelated turn id on the same thread', async () => {
    consumeInternalStopSuppression = (turnId) => turnId === 'turn-1';
    await emit('orchestration:event', {
      event: {
        createdAt: new Date().toISOString(),
        method: 'runtime.error',
        provider: 'codex',
        threadId: 'thread-1',
        turnId: 'turn-2',
        severity: 'error',
        message: 'a genuine mid-turn death',
      },
    });
    expect(await notificationService.list()).toHaveLength(1);
  });

  test('the armed entry is consume-once — a stale entry cannot swallow a second, unrelated notification for the same turn id', async () => {
    // Mirrors InternalStopSuppression's real Set-based
    // consume-on-match semantics, not a boolean flag, so this proves the
    // production contract (`consumeInternalStopSuppression` deletes on
    // match) rather than a test-local approximation of it.
    const armed = new Set(['turn-1']);
    consumeInternalStopSuppression = (turnId) => armed.delete(turnId);

    // First occurrence: armed, so suppressed.
    await emit('orchestration:event', {
      event: {
        createdAt: new Date().toISOString(),
        method: 'runtime.error',
        provider: 'codex',
        threadId: 'thread-1',
        turnId: 'turn-1',
        severity: 'error',
        message: 'first: suppressed as an internal stop',
        code: 'codex-turn-orphaned',
      },
    });
    expect(await notificationService.list()).toHaveLength(0);

    // The entry was consumed by the first occurrence — a later event for the
    // SAME turn id (a real adapter never re-publishes a terminal for one
    // turn, but this is exactly the property that proves the entry does not
    // stay armed forever and silently suppress something unrelated) pushes
    // normally.
    await emit('orchestration:event', {
      event: {
        createdAt: new Date().toISOString(),
        method: 'runtime.error',
        provider: 'codex',
        threadId: 'thread-1',
        turnId: 'turn-1',
        severity: 'error',
        message: 'second: entry already consumed',
      },
    });
    expect(await notificationService.list()).toHaveLength(1);
  });

  test('fix round MEDIUM 1: a genuine "done" completion for an armed turn id still pushes — the suppression consume never runs for a non-failed outcome', async () => {
    // A turn that was armed for internal-stop suppression (e.g. the race
    // where it finished naturally right as the internal stop was arming)
    // must NOT have its legitimate "done" push swallowed. Track whether the
    // armed entry was ever actually consumed to prove BOTH halves: the push
    // still schedules, AND the entry survives untouched (it is a 'done'
    // outcome, not the 'failed' one this mechanism exists to suppress).
    let consumed = false;
    consumeInternalStopSuppression = (turnId) => {
      if (turnId === 'turn-1') {
        consumed = true;
        return true;
      }
      return false;
    };
    await emit('orchestration:event', {
      event: {
        createdAt: new Date().toISOString(),
        method: 'turn.completed',
        provider: 'codex',
        threadId: 'thread-1',
        turnId: 'turn-1',
        finishReason: 'stop',
      },
    });
    const notifications = await notificationService.list();
    expect(notifications).toHaveLength(1);
    expect(notifications[0]).toEqual(
      expect.objectContaining({
        category: 'turn-completed',
        title: 'Your agent finished',
      }),
    );
    // The gate on outcome === 'failed' means the consume call for a 'done'
    // outcome never even runs — the mock's own tripwire proves it.
    expect(consumed).toBe(false);
  });

  test('a real mid-turn death not armed by an internal stop still pushes "needs attention"', async () => {
    consumeInternalStopSuppression = () => false;
    await emit('orchestration:event', {
      event: {
        createdAt: new Date().toISOString(),
        method: 'runtime.error',
        provider: 'codex',
        threadId: 'thread-1',
        turnId: 'turn-1',
        severity: 'error',
        message: 'usage limit reached',
      },
    });
    const notifications = await notificationService.list();
    expect(notifications).toHaveLength(1);
    expect(notifications[0]).toEqual(
      expect.objectContaining({
        category: 'turn-failed',
        title: 'Your agent needs attention',
        priority: 'high',
      }),
    );
  });
});

describe('wireInternalStopRedispatchFailureNotifications (station#3525 fix round FIX 1)', () => {
  let bus: EventBus;
  let dir: string;
  let notificationService: NotificationService;
  let presence: OrchestrationStreamPresence;
  let logger: {
    warn: ReturnType<
      typeof vi.fn<(message: string, meta?: Record<string, unknown>) => void>
    >;
  };
  let resolveSessionPresenceSubject: (
    threadId: string,
  ) => OrchestrationStreamPresenceSubject | undefined;

  async function emit(
    event: Parameters<EventBus['emit']>[0],
    data?: Parameters<EventBus['emit']>[1],
  ): Promise<void> {
    bus.emit(event, data);
    await notificationService.drainAsyncDispatch();
  }

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'internal-stop-redispatch-failed-'));
    bus = new EventBus();
    notificationService = new NotificationService(bus, dir, 999_999);
    presence = new OrchestrationStreamPresence();
    logger = {
      warn: vi.fn<(message: string, meta?: Record<string, unknown>) => void>(),
    };
    resolveSessionPresenceSubject = () =>
      orchestrationStreamPresenceSubjectForSession('owner-1');
    wireInternalStopRedispatchFailureNotifications(
      bus,
      {
        resolveSessionPresenceSubject: (threadId) =>
          resolveSessionPresenceSubject(threadId),
      },
      presence,
      notificationService,
      logger,
    );
    await notificationService.start();
  });

  afterEach(async () => {
    await notificationService.shutdown();
    rmSync(dir, { force: true, recursive: true });
  });

  test('delivers "Your agent needs attention" for a redispatch-failed signal', async () => {
    await emit('orchestration:internal-stop-redispatch-failed', {
      threadId: 'thread-1',
      turnId: 'turn-2',
      provider: 'codex',
    });
    const notifications = await notificationService.list();
    expect(notifications).toHaveLength(1);
    expect(notifications[0]).toEqual(
      expect.objectContaining({
        category: 'turn-failed',
        title: 'Your agent needs attention',
        priority: 'high',
        metadata: expect.objectContaining({
          threadId: 'thread-1',
          turnId: 'turn-2',
        }),
      }),
    );
  });

  test('does not push when the owner is actively connected', async () => {
    const disconnect = presence.connect('owner-1');
    await emit('orchestration:internal-stop-redispatch-failed', {
      threadId: 'thread-1',
      turnId: 'turn-2',
      provider: 'codex',
    });
    expect(await notificationService.list()).toHaveLength(0);
    disconnect();
  });

  test('ignores an unrelated event on the same bus', async () => {
    await emit('orchestration:event', {
      event: {
        createdAt: new Date().toISOString(),
        method: 'turn.completed',
        provider: 'codex',
        threadId: 'thread-1',
        turnId: 'turn-1',
        finishReason: 'stop',
      },
    });
    expect(await notificationService.list()).toHaveLength(0);
  });

  test.each([
    ['missing threadId', { turnId: 'turn-2', provider: 'codex' }],
    ['missing turnId', { threadId: 'thread-1', provider: 'codex' }],
    ['non-string threadId', { threadId: 42, turnId: 'turn-2' }],
  ])(
    'schedules nothing and does not throw for a malformed payload: %s',
    async (_label, data) => {
      await emit('orchestration:internal-stop-redispatch-failed', data);
      expect(await notificationService.list()).toHaveLength(0);
      expect(logger.warn).not.toHaveBeenCalled();
    },
  );

  test('a throwing presence lookup is caught, logged, and does not unsubscribe the listener', async () => {
    resolveSessionPresenceSubject = () => {
      throw new Error('simulated event-store read failure');
    };
    await emit('orchestration:internal-stop-redispatch-failed', {
      threadId: 'thread-1',
      turnId: 'turn-2',
      provider: 'codex',
    });
    expect(await notificationService.list()).toHaveLength(0);
    expect(logger.warn).toHaveBeenCalledTimes(1);

    resolveSessionPresenceSubject = () =>
      orchestrationStreamPresenceSubjectForSession('owner-1');
    await emit('orchestration:internal-stop-redispatch-failed', {
      threadId: 'thread-1',
      turnId: 'turn-3',
      provider: 'codex',
    });
    expect(await notificationService.list()).toHaveLength(1);
  });
});

describe('wireTurnCompletionNotifications turn-identity-anchor eviction timer (station#3581 review round 3)', () => {
  let bus: EventBus;
  let dir: string;
  let notificationService: NotificationService;
  let presence: OrchestrationStreamPresence;

  async function emit(
    event: Parameters<EventBus['emit']>[0],
    data?: Parameters<EventBus['emit']>[1],
  ): Promise<void> {
    bus.emit(event, data);
    await notificationService.drainAsyncDispatch();
  }

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'turn-completion-notifications-timers-'));
    bus = new EventBus();
    notificationService = new NotificationService(bus, dir, 999_999);
    presence = new OrchestrationStreamPresence();
  });

  afterEach(async () => {
    await notificationService.shutdown();
    rmSync(dir, { force: true, recursive: true });
  });

  // LOW 1: the eviction timer must be touched (clearTimeout + setTimeout)
  // only by turn.started/turn.completed/turn.aborted — not by every event
  // on the bus. A run of streamed content deltas for a thread that already
  // has an armed timer is the discriminating case: gated correctly, NEITHER
  // spy fires for them; gated only by "does the map already have an entry"
  // (the pre-fix shape), each delta would still touch (clear-then-reset)
  // the existing timer, since `nextTurnIdentityAnchor` returns the SAME
  // defined anchor unchanged for a non-`turn.started` event and the old code
  // touched on any defined result.
  test('content deltas do not touch the eviction timer; only turn.started/terminal events do', async () => {
    const setTimeoutSpy = vi.spyOn(global, 'setTimeout');
    const clearTimeoutSpy = vi.spyOn(global, 'clearTimeout');
    try {
      const dispose = wireTurnCompletionNotifications(
        bus,
        {
          resolveSessionPresenceSubject: () =>
            orchestrationStreamPresenceSubjectForSession('owner-1'),
        },
        presence,
        notificationService,
        { warn: vi.fn() },
      );

      await emit('orchestration:event', {
        event: {
          createdAt: new Date().toISOString(),
          method: 'turn.started',
          provider: 'claude',
          threadId: 'thread-timers',
          turnId: 'turn-1',
          prompt: 'go',
        },
      });
      const setTimeoutCallsAfterStart = setTimeoutSpy.mock.calls.length;
      expect(setTimeoutCallsAfterStart).toBeGreaterThan(0);
      expect(clearTimeoutSpy).not.toHaveBeenCalled();

      for (let i = 0; i < 5; i += 1) {
        await emit('orchestration:event', {
          event: {
            createdAt: new Date().toISOString(),
            method: 'content.text-delta',
            provider: 'claude',
            threadId: 'thread-timers',
            itemId: 'item-1',
            delta: 'x',
          },
        });
      }

      expect(setTimeoutSpy.mock.calls.length).toBe(setTimeoutCallsAfterStart);
      expect(clearTimeoutSpy).not.toHaveBeenCalled();

      // A genuine terminal for the SAME turn still touches the timer (the
      // gate is "anchor-relevant", not "never touch again").
      await emit('orchestration:event', {
        event: {
          createdAt: new Date().toISOString(),
          method: 'turn.completed',
          provider: 'claude',
          threadId: 'thread-timers',
          turnId: 'turn-1',
          finishReason: 'stop',
        },
      });
      expect(setTimeoutSpy.mock.calls.length).toBeGreaterThan(
        setTimeoutCallsAfterStart,
      );
      expect(clearTimeoutSpy).toHaveBeenCalled();

      dispose();
    } finally {
      setTimeoutSpy.mockRestore();
      clearTimeoutSpy.mockRestore();
    }
  });

  // LOW 2: the disposer must release every pending eviction timer, not just
  // the EventBus subscription — otherwise each `.unref()`d timer retains a
  // closure over both anchor maps for up to 24h after unwire.
  test('the returned disposer clears every pending eviction timer', async () => {
    vi.useFakeTimers();
    try {
      const dispose = wireTurnCompletionNotifications(
        bus,
        {
          resolveSessionPresenceSubject: () =>
            orchestrationStreamPresenceSubjectForSession('owner-1'),
        },
        presence,
        notificationService,
        { warn: vi.fn() },
      );

      const baseline = vi.getTimerCount();
      bus.emit('orchestration:event', {
        event: {
          createdAt: new Date().toISOString(),
          method: 'turn.started',
          provider: 'claude',
          threadId: 'thread-a',
          turnId: 'turn-a',
          prompt: 'go',
        },
      });
      bus.emit('orchestration:event', {
        event: {
          createdAt: new Date().toISOString(),
          method: 'turn.started',
          provider: 'claude',
          threadId: 'thread-b',
          turnId: 'turn-b',
          prompt: 'go',
        },
      });
      await notificationService.drainAsyncDispatch();
      expect(vi.getTimerCount()).toBeGreaterThanOrEqual(baseline + 2);

      dispose();
      expect(vi.getTimerCount()).toBe(baseline);
    } finally {
      vi.useRealTimers();
    }
  });
});
