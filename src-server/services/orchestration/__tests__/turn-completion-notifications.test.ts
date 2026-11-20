import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { SERVER_EVENTS } from '@kontourai/station-contracts/runtime-events';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { trackTempDirs } from '../../../__test-utils__/temp-dirs.js';
import { turnCompletionNotificationOps } from '../../../telemetry/metrics.js';
import { agentActivityPhaseFor } from '../../notifications/agent-activity-card.js';
import { isCardAlerted } from '../../notifications/delivery/card-alerted-categories.js';
import { NotificationService } from '../../notifications/notification-service.js';
import {
  createSqliteCoordinatorStore,
  wireCoordinatorWakes,
} from '../coordinator-session.js';
import { EventBus } from '../event-bus.js';
import {
  createFileFinishedAlertEpisodeStore,
  FINISHED_ALERT_EPISODES_MAX,
  FinishedAlertEpisodes,
  type PersistedFinishedAlertEpisode,
} from '../finished-alert-episodes.js';
import {
  type FinishedAlertHoldFacts,
  finishedAlertHoldReasons,
} from '../finished-alert-hold.js';
import {
  type OrchestrationStreamPresenceSubject,
  orchestrationStreamPresenceSubjectForSession,
} from '../orchestration-stream-presence.js';
import { projectSessionLifecycle } from '../session-lifecycle-service.js';
import {
  FINISHED_ALERT_CONFIRM_MS,
  FINISHED_ALERT_RECHECK_MS,
  FINISHED_ALERT_RETRY_BASE_MS,
  FINISHED_ALERT_RETRY_MAX_MS,
  resolveTurnCompletionOutcome,
  turnTerminalOnActivityCard,
  wireInternalStopRedispatchFailureNotifications,
  wireTurnCompletionNotifications,
} from '../turn-completion-notifications.js';

vi.mock('../../../telemetry/metrics.js', () => ({
  notificationOps: { add: vi.fn() },
  jsonFileStoreWriteBytes: { record: vi.fn() },
  orchestrationEventPersistDuration: { record: vi.fn() },
  orchestrationEventsPersisted: { add: vi.fn() },
  orchestrationStreamPresenceOps: { add: vi.fn() },
  turnCompletionNotificationOps: { add: vi.fn() },
}));

/** #2589: the threads the fake orchestration service reports ephemeral. */
const ephemeralThreads = new Set<string>();
const attachedThreads = new Set<string>();

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

/**
 * A timer the test runs by hand. The listener holds a finish for its
 * confirmation window before pushing it; the per-turn suites below run
 * every armed window at the end of each emit, so one completion with nothing
 * holding it still yields its push within that emit.
 */
function manualTimers() {
  let queue: Array<{ callback: () => void; delayMs: number; live: boolean }> =
    [];
  return {
    setTimer(callback: () => void, delayMs: number) {
      const entry = { callback, delayMs, live: true };
      queue.push(entry);
      return () => {
        entry.live = false;
      };
    },
    /** Runs every live timer armed so far (not ones they arm). */
    runAll() {
      const due = queue.filter((entry) => entry.live);
      queue = [];
      for (const entry of due) {
        entry.live = false;
        entry.callback();
      }
      return due.length;
    },
    /** Delays of the live timers, oldest first. */
    pending() {
      return queue.filter((entry) => entry.live).map((entry) => entry.delayMs);
    },
  };
}

describe('turnTerminalOnActivityCard (#2589)', () => {
  // The mark claims the card shows the session this terminal leaves behind.
  // Pinned against the real lifecycle fold and the real card phase, so a
  // change to either that the mark does not follow fails here.
  const session = {
    provider: 'claude',
    threadId: 'thread-1',
    status: 'running',
    createdAt: '2026-09-25T00:00:00.000Z',
    updatedAt: '2026-09-25T00:00:05.000Z',
  } as never;
  test.each([
    { method: 'turn.completed', finishReason: 'stop' },
    { method: 'turn.completed' },
    { method: 'turn.completed', finishReason: 'cancelled' },
    { method: 'turn.aborted', reason: 'stopped' },
    { method: 'runtime.error', message: 'boom' },
  ])('%o', (terminal) => {
    const events = [
      baseEvent({ method: 'turn.started' }),
      baseEvent(terminal),
    ] as never[];
    const { lifecycleState } = projectSessionLifecycle({ session, events });
    const cardPhase = agentActivityPhaseFor({ lifecycleState, isLoaded: true });

    expect(
      turnTerminalOnActivityCard(
        { isEphemeralSession: () => false },
        baseEvent(terminal) as never,
      ),
    ).toBe(cardPhase !== null);
    expect(
      turnTerminalOnActivityCard(
        { isEphemeralSession: () => true },
        baseEvent(terminal) as never,
      ),
    ).toBe(false);
  });

  test('covers both answers', () => {
    expect(
      turnTerminalOnActivityCard(
        { isEphemeralSession: () => false },
        baseEvent() as never,
      ),
    ).toBe(true);
    expect(
      turnTerminalOnActivityCard(
        { isEphemeralSession: () => false },
        baseEvent({ method: 'turn.aborted' }) as never,
      ),
    ).toBe(false);
  });
});

describe('resolveTurnCompletionOutcome', () => {
  test('turn.completed -> done, turn.aborted -> failed, runtime.error -> failed, everything else -> undefined', async () => {
    expect(resolveTurnCompletionOutcome({ method: 'turn.completed' })).toBe(
      'done',
    );
    expect(resolveTurnCompletionOutcome({ method: 'turn.aborted' })).toBe(
      'failed',
    );
    // station#2235: a recovery-synthesized abort is the crash's only
    // offline signal (the needs_input attention path schedules no push),
    // so it resolves 'failed' exactly like the engine abort it stands in
    // for — the in-app copy stays owned by the interrupted-turn banner.
    expect(
      resolveTurnCompletionOutcome({
        method: 'turn.aborted',
        turnId: 'turn-1',
        reason: 'The turn was interrupted before it finished.',
        recoveryTerminal: true,
      } as Parameters<typeof resolveTurnCompletionOutcome>[0]),
    ).toBe('failed');
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
  let timers: ReturnType<typeof manualTimers>;
  let bus: EventBus;
  let dir: string;
  let notificationService: NotificationService;

  async function emit(
    event: Parameters<EventBus['emit']>[0],
    data?: Parameters<EventBus['emit']>[1],
  ): Promise<void> {
    bus.emit(event, data);
    await notificationService.drainAsyncDispatch();
    if (timers.runAll() > 0) await notificationService.drainAsyncDispatch();
  }
  let resolveSessionPresenceSubject: (
    threadId: string,
  ) => OrchestrationStreamPresenceSubject | undefined;
  /** #5072: the Project a session recorded at its start. */
  let projectOf: (threadId: string) => string | undefined;
  let logger: {
    warn: ReturnType<
      typeof vi.fn<(message: string, meta?: Record<string, unknown>) => void>
    >;
  };

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'turn-completion-notifications-'));
    timers = manualTimers();
    bus = new EventBus();
    notificationService = new NotificationService(bus, dir, 999_999);
    resolveSessionPresenceSubject = () =>
      orchestrationStreamPresenceSubjectForSession('owner-1');
    projectOf = () => undefined;
    logger = {
      warn: vi.fn<(message: string, meta?: Record<string, unknown>) => void>(),
    };
    wireTurnCompletionNotifications(
      bus,
      {
        isReadOnlyAttachedSession: (threadId: string) =>
          attachedThreads.has(threadId),
        isEphemeralSession: (threadId) => {
          // #2589: the fail-soft path, a lookup that cannot answer.
          if (threadId === 'thread-lookup-throws')
            throw new Error('ephemeral lookup failed');
          return ephemeralThreads.has(threadId);
        },
        resolveSessionPresenceSubject: (threadId) =>
          resolveSessionPresenceSubject(threadId),
      },
      notificationService,
      logger,
      {
        setTimer: timers.setTimer,
        resolveProjectId: (threadId) => projectOf(threadId),
      },
    );
    await notificationService.start();
  });

  afterEach(async () => {
    ephemeralThreads.clear();
    attachedThreads.clear();
    await notificationService.shutdown();
    rmSync(dir, { force: true, recursive: true });
  });

  test('stale invocation error on reused N cannot schedule B failure, exact B remains positive', async () => {
    await emit('orchestration:event', {
      event: baseEvent({
        method: 'turn.started',
        invocationId: 'A',
        turnId: 'N',
      }),
    });
    await emit('orchestration:event', {
      event: baseEvent({
        method: 'turn.started',
        invocationId: 'B',
        turnId: 'N',
      }),
    });
    await emit('orchestration:event', {
      event: baseEvent({
        method: 'runtime.error',
        invocationId: 'A',
        turnId: 'N',
        severity: 'error',
        message: 'late A error',
      }),
    });
    expect(await notificationService.list()).toHaveLength(0);
    await emit('orchestration:event', {
      event: baseEvent({
        method: 'runtime.error',
        invocationId: 'B',
        turnId: 'N',
        severity: 'error',
        message: 'exact B error',
      }),
    });
    expect(await notificationService.list()).toHaveLength(1);
    expect((await notificationService.list())[0]).toMatchObject({
      category: 'turn-failed',
    });
  });

  // #2589: the phone alert channels leave a notification to the
  // agent-activity card only when its writer marked it as on the card. An
  // ephemeral (webhook) session is not in the read model the card is built
  // from, and an aborted turn folds to `canceled`, which the card leaves off.
  test.each([
    ['a completed turn', 'thread-1', {}, true],
    [
      'a failed turn (runtime.error)',
      'thread-1',
      { method: 'runtime.error' },
      true,
    ],
    ['a completed turn in an ephemeral session', 'thread-e', {}, false],
    [
      'a failed turn in an ephemeral session',
      'thread-e',
      { method: 'runtime.error' },
      false,
    ],
    // Fail-soft: an unmarked notification still alerts.
    [
      'a completed turn whose ephemeral lookup throws',
      'thread-lookup-throws',
      {},
      false,
    ],
    [
      'a failed turn whose ephemeral lookup throws',
      'thread-lookup-throws',
      { method: 'runtime.error' },
      false,
    ],
    ['an aborted turn', 'thread-1', { method: 'turn.aborted' }, false],
    [
      'a cancelled turn.completed',
      'thread-1',
      { finishReason: 'cancelled' },
      false,
    ],
  ])(
    '%s on %s is left to the card: %s',
    async (_label, threadId, overrides, onCard) => {
      ephemeralThreads.add('thread-e');
      await emit('orchestration:event', {
        event: baseEvent({ threadId, ...overrides }),
      });

      const [notification] = await notificationService.list();
      expect(notification?.metadata).toMatchObject({
        sessionId: threadId,
        sessionKind: 'runtime',
      });
      expect(isCardAlerted(notification!)).toBe(onCard);
    },
  );

  test.each(['turn.completed', 'turn.aborted', 'runtime.error'])(
    'a readable external transcript never delivers a %s notification',
    async (method) => {
      attachedThreads.add('thread-1');
      await emit('orchestration:event', { event: baseEvent({ method }) });
      expect(await notificationService.list()).toEqual([]);
      expect(logger.warn).not.toHaveBeenCalled();
    },
  );

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

  test('an ACP request-limit stop delivers attention instead of a finished notice', async () => {
    await emit('orchestration:event', {
      event: baseEvent({
        provider: 'acp',
        method: 'turn.completed',
        finishReason: 'other',
        stopReason: 'max_turn_requests',
      }),
    });
    expect(await notificationService.list()).toEqual([
      expect.objectContaining({
        category: 'turn-failed',
        title: 'Your agent needs attention',
        priority: 'high',
      }),
    ]);
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
      .spyOn(notificationService, 'scheduleEnveloped')
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
      expect.anything(),
    );
  });

  test('a Codex abort followed by its interrupted terminal only notifies Stop', async () => {
    const schedule = vi
      .spyOn(notificationService, 'scheduleEnveloped')
      .mockResolvedValue({} as never);
    const event = (overrides: Record<string, unknown>) =>
      baseEvent({ provider: 'codex', ...overrides });
    await emit('orchestration:event', {
      event: event({ method: 'turn.started' }),
    });
    await emit('orchestration:event', {
      event: event({
        method: 'session.stop-settled',
        outcome: 'cooperative',
        initiatedBy: 'user',
      }),
    });
    await emit('orchestration:event', {
      event: event({ method: 'turn.aborted', reason: 'interrupted' }),
    });
    await emit('orchestration:event', {
      event: event({ method: 'turn.completed', finishReason: 'cancelled' }),
    });
    expect(schedule).toHaveBeenCalledExactlyOnceWith(
      'turn-completion',
      expect.objectContaining({ category: 'turn-stopped' }),
      expect.anything(),
    );
  });

  describe('#2324 (D1): a turn the engine opened on its own', () => {
    const provider = {
      metadata: { trigger: 'provider' },
      turnId: 'provider:p',
    };

    test('its completion notifies "Your agent replied"', async () => {
      const schedule = vi
        .spyOn(notificationService, 'scheduleEnveloped')
        .mockResolvedValue({} as never);
      await emit('orchestration:event', {
        event: baseEvent({ method: 'turn.started', ...provider }),
      });
      await emit('orchestration:event', {
        event: baseEvent({ finishReason: 'stop', ...provider }),
      });
      expect(schedule).toHaveBeenCalledTimes(1);
      expect(schedule).toHaveBeenCalledWith(
        'turn-completion',
        expect.objectContaining({
          category: 'turn-completed',
          title: 'Your agent replied',
          body: 'Agent replied in session thread-1',
          priority: 'normal',
          dedupeTag: 'turn-completion:thread-1:provider:p',
        }),
        expect.anything(),
      );
    });

    test('F1: its failure still notifies, worded as the reply failing', async () => {
      const schedule = vi
        .spyOn(notificationService, 'scheduleEnveloped')
        .mockResolvedValue({} as never);
      await emit('orchestration:event', {
        event: baseEvent({ method: 'turn.started', ...provider }),
      });
      await emit('orchestration:event', {
        event: baseEvent({
          method: 'runtime.error',
          severity: 'error',
          message: 'overloaded',
          ...provider,
        }),
      });
      expect(schedule).toHaveBeenCalledWith(
        'turn-completion',
        expect.objectContaining({
          category: 'turn-failed',
          title: "Your agent's reply failed",
          body: "Your agent's reply on its own failed in session thread-1",
        }),
        expect.anything(),
      );
    });

    test('a Stop on it is never reported as "stopped"', async () => {
      const schedule = vi
        .spyOn(notificationService, 'scheduleEnveloped')
        .mockResolvedValue({} as never);
      await emit('orchestration:event', {
        event: baseEvent({ method: 'turn.started', ...provider }),
      });
      await emit('orchestration:event', {
        event: baseEvent({
          method: 'session.stop-settled',
          outcome: 'forced',
          initiatedBy: 'user',
          ...provider,
        }),
      });
      await emit('orchestration:event', {
        event: baseEvent({
          method: 'turn.aborted',
          reason: 'interrupted',
          ...provider,
        }),
      });
      expect(schedule).not.toHaveBeenCalled();
    });

    test('L6: a reply that ended on a deferred tool (finishReason other, its own result) still notifies "replied"', async () => {
      const schedule = vi
        .spyOn(notificationService, 'scheduleEnveloped')
        .mockResolvedValue({} as never);
      await emit('orchestration:event', {
        event: baseEvent({ method: 'turn.started', ...provider }),
      });
      await emit('orchestration:event', {
        event: baseEvent({ finishReason: 'other', ...provider }),
      });
      expect(schedule).toHaveBeenCalledWith(
        'turn-completion',
        expect.objectContaining({ title: 'Your agent replied' }),
        expect.anything(),
      );
    });

    test('closed without its own result (a folded send, a new turn) it adds no push; the same shape on a caller turn still does', async () => {
      const schedule = vi
        .spyOn(notificationService, 'scheduleEnveloped')
        .mockResolvedValue({} as never);
      await emit('orchestration:event', {
        event: baseEvent({ method: 'turn.started', ...provider }),
      });
      await emit('orchestration:event', {
        event: baseEvent({
          finishReason: 'other',
          turnId: provider.turnId,
          metadata: { trigger: 'provider', closedWithoutResult: 'folded-send' },
        }),
      });
      expect(schedule).not.toHaveBeenCalled();
      await emit('orchestration:event', {
        event: baseEvent({
          method: 'turn.started',
          turnId: 'user-turn',
          prompt: 'hi',
        }),
      });
      await emit('orchestration:event', {
        event: baseEvent({ finishReason: 'other', turnId: 'user-turn' }),
      });
      expect(schedule).toHaveBeenCalledWith(
        'turn-completion',
        expect.objectContaining({ title: 'Your agent finished' }),
        expect.anything(),
      );
    });
  });

  test('an unaccompanied Codex turn.completed(cancelled) keeps the existing completed mapping', async () => {
    const schedule = vi
      .spyOn(notificationService, 'scheduleEnveloped')
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
      expect.anything(),
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

  test('schedules nothing for a session with no owner: nobody may read it', async () => {
    resolveSessionPresenceSubject = () => undefined;
    await emit('orchestration:event', { event: baseEvent() });
    expect(await notificationService.list()).toHaveLength(0);
  });

  // Read state needs an envelope: without one `markRead` answers
  // `no-envelope`, so a watched failure could never cancel its escalation.
  test.each([
    ['a completed turn', {}, 'done'],
    ['a failed turn', { method: 'runtime.error', message: 'boom' }, 'failed'],
  ] as const)(
    '%s is recorded with a session envelope a reader can mark read',
    async (_label, overrides, urgency) => {
      await emit('orchestration:event', { event: baseEvent(overrides) });
      const [notification] = await notificationService.list();
      expect(notification.metadata?.envelope).toEqual({
        v: 1,
        source: { kind: 'system', subsystem: 'turn-completion' },
        audience: { kind: 'session-readers', sessionId: 'thread-1' },
        urgency,
        target: { kind: 'session', sessionId: 'thread-1' },
        interrupt: 'default',
      });
      const read = await notificationService.markRead(
        notification.id,
        'device:phone',
      );
      expect(read).toBe('read');
    },
  );

  test('names the session’s Project on the record, so its settings apply (#5072)', async () => {
    projectOf = (threadId) =>
      threadId === 'thread-1' ? 'project-alpha' : undefined;
    await emit('orchestration:event', { event: baseEvent() });
    const [notification] = await notificationService.list();
    expect(
      (notification.metadata!.envelope as { source: unknown }).source,
    ).toEqual({
      kind: 'system',
      subsystem: 'turn-completion',
      projectId: 'project-alpha',
    });
  });

  test('a Project lookup that throws still delivers the record, without a Project', async () => {
    projectOf = () => {
      throw new Error('project store unavailable');
    };
    await emit('orchestration:event', { event: baseEvent() });
    const [notification] = await notificationService.list();
    expect(
      (notification.metadata!.envelope as { source: unknown }).source,
    ).toEqual({ kind: 'system', subsystem: 'turn-completion' });
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
      .spyOn(notificationService, 'scheduleEnveloped')
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
  let timers: ReturnType<typeof manualTimers>;
  let bus: EventBus;
  let dir: string;
  let notificationService: NotificationService;
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
    if (timers.runAll() > 0) await notificationService.drainAsyncDispatch();
  }

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'turn-completion-notifications-stop-'));
    timers = manualTimers();
    bus = new EventBus();
    notificationService = new NotificationService(bus, dir, 999_999);
    logger = {
      warn: vi.fn<(message: string, meta?: Record<string, unknown>) => void>(),
    };
    consumeInternalStopSuppression = () => false;
    wireTurnCompletionNotifications(
      bus,
      {
        isReadOnlyAttachedSession: (threadId: string) =>
          attachedThreads.has(threadId),
        isEphemeralSession: (threadId) => ephemeralThreads.has(threadId),
        resolveSessionPresenceSubject: () =>
          orchestrationStreamPresenceSubjectForSession('owner-1'),
        consumeInternalStopSuppression: (turnId) =>
          consumeInternalStopSuppression(turnId),
      },
      notificationService,
      logger,
      { setTimer: timers.setTimer },
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
    logger = {
      warn: vi.fn<(message: string, meta?: Record<string, unknown>) => void>(),
    };
    resolveSessionPresenceSubject = () =>
      orchestrationStreamPresenceSubjectForSession('owner-1');
    wireInternalStopRedispatchFailureNotifications(
      bus,
      {
        isReadOnlyAttachedSession: (threadId: string) =>
          attachedThreads.has(threadId),
        isEphemeralSession: (threadId) => ephemeralThreads.has(threadId),
        resolveSessionPresenceSubject: (threadId) =>
          resolveSessionPresenceSubject(threadId),
      },
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
          isReadOnlyAttachedSession: (threadId: string) =>
            attachedThreads.has(threadId),
          isEphemeralSession: (threadId) => ephemeralThreads.has(threadId),
          resolveSessionPresenceSubject: () =>
            orchestrationStreamPresenceSubjectForSession('owner-1'),
        },
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
          isReadOnlyAttachedSession: (threadId: string) =>
            attachedThreads.has(threadId),
          isEphemeralSession: (threadId) => ephemeralThreads.has(threadId),
          resolveSessionPresenceSubject: () =>
            orchestrationStreamPresenceSubjectForSession('owner-1'),
        },
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

const makeTempDir = trackTempDirs();

describe('wireTurnCompletionNotifications: one finished alert per completion episode', () => {
  let timers: ReturnType<typeof manualTimers>;
  let bus: EventBus;
  let dir: string;
  let notificationService: NotificationService;
  let schedule: ReturnType<typeof vi.spyOn>;
  /** The facts the real `OrchestrationService.readFinishedAlertHold` folds. */
  let facts: Map<string, FinishedAlertHoldFacts>;
  let delegatedChildren: Set<string>;
  let holdThrows: boolean;
  const subagent = {
    producer: 'engine-subagent' as const,
    reporterThreadId: 'thread-1',
  };

  async function emit(event: Record<string, unknown>): Promise<void> {
    bus.emit('orchestration:event', { event: baseEvent(event) });
    await notificationService.drainAsyncDispatch();
  }
  /** Lets every armed confirmation window and recheck run out. */
  async function elapse(): Promise<void> {
    timers.runAll();
    await notificationService.drainAsyncDispatch();
  }
  const titles = () =>
    schedule.mock.calls.map(
      (call: unknown[]) => (call[1] as { title: string }).title,
    );

  beforeEach(async () => {
    dir = makeTempDir('turn-completion-held-');
    timers = manualTimers();
    bus = new EventBus();
    notificationService = new NotificationService(bus, dir, 999_999);
    facts = new Map();
    delegatedChildren = new Set();
    holdThrows = false;
    wireTurnCompletionNotifications(
      bus,
      {
        isReadOnlyAttachedSession: () => false,
        isEphemeralSession: () => false,
        resolveSessionPresenceSubject: () =>
          orchestrationStreamPresenceSubjectForSession('owner-1'),
        readFinishedAlertHold: (threadId) => {
          if (holdThrows) throw new Error('hold unreadable');
          return finishedAlertHoldReasons(facts.get(threadId) ?? {});
        },
        isDelegatedChildSession: (threadId) => delegatedChildren.has(threadId),
      },
      notificationService,
      { warn: vi.fn() },
      { setTimer: timers.setTimer },
    );
    await notificationService.start();
    schedule = vi
      .spyOn(notificationService, 'scheduleEnveloped')
      .mockResolvedValue({} as never);
  });

  afterEach(async () => {
    await notificationService.shutdown();
  });

  test('a finish waits out its confirmation window before it is pushed', async () => {
    await emit({ method: 'turn.started' });
    await emit({ finishReason: 'stop' });
    expect(schedule).not.toHaveBeenCalled();
    expect(timers.pending()).toEqual([FINISHED_ALERT_CONFIRM_MS]);
    await elapse();
    expect(titles()).toEqual(['Your agent finished']);
  });

  test('a running subagent holds "finished" until it settles, then one alert goes out', async () => {
    facts.set('thread-1', {
      childWork: {
        observability: 'reported',
        observedAt: '2026-11-15T00:00:00.000Z',
        running: [
          {
            ...subagent,
            childId: 'agent-1',
            status: 'running',
            workKind: 'agent',
          },
        ],
      },
    });
    await emit({ method: 'turn.started' });
    await emit({ finishReason: 'stop' });
    // Held: only the recheck is armed, no confirmation window.
    expect(timers.pending()).toEqual([FINISHED_ALERT_RECHECK_MS]);
    await elapse();
    await elapse();
    expect(schedule).not.toHaveBeenCalled();

    // The child settles: the next child-work frame opens the window.
    facts.set('thread-1', {
      childWork: {
        observability: 'reported',
        observedAt: '2026-11-15T00:00:00.000Z',
        running: [],
      },
    });
    await emit({ method: 'child-work.updated', turnId: undefined });
    expect(schedule).not.toHaveBeenCalled();
    await elapse();
    expect(titles()).toEqual(['Your agent finished']);
    expect(schedule.mock.calls[0]?.[1]).toMatchObject({
      dedupeTag: 'turn-completion:thread-1:turn-1',
    });
  });

  test('a delegated session or queued follow-up holds; a backgrounded command does not', async () => {
    facts.set('thread-1', {
      ownedWork: { runningChildCount: 1, pendingStopCount: 0 },
    });
    await emit({ method: 'turn.started' });
    await emit({ finishReason: 'stop' });
    await elapse();
    expect(schedule).not.toHaveBeenCalled();

    facts.set('thread-1', { queuedFollowUp: true });
    await elapse();
    expect(schedule).not.toHaveBeenCalled();

    // A dev server left running: backgrounded, and the engine's open-work
    // flag is explained by it. Not held.
    facts.set('thread-1', {
      openEngineWork: true,
      childWork: {
        observability: 'reported',
        observedAt: '2026-11-15T00:00:00.000Z',
        running: [
          {
            ...subagent,
            childId: 'bash-1',
            status: 'running',
            workKind: 'command',
            backgrounded: true,
          },
        ],
      },
    });
    await elapse(); // the recheck sees the release and opens the window
    await elapse();
    expect(titles()).toEqual(['Your agent finished']);
  });

  test('a user finish followed by the engine\'s own reply is one "finished", not "finished" then "replied"', async () => {
    await emit({ method: 'turn.started' });
    await emit({ finishReason: 'stop' });
    // Claude opens its own turn after a background child settles.
    await emit({
      method: 'turn.started',
      turnId: 'provider:p',
      metadata: { trigger: 'provider' },
    });
    await elapse(); // the cancelled window does not fire
    expect(schedule).not.toHaveBeenCalled();
    await emit({
      finishReason: 'stop',
      turnId: 'provider:p',
      metadata: { trigger: 'provider' },
    });
    await elapse();
    expect(titles()).toEqual(['Your agent finished']);
    expect(schedule.mock.calls[0]?.[1]).toMatchObject({
      dedupeTag: 'turn-completion:thread-1:provider:p',
    });
  });

  test('a failure ends the episode at once and the held finish is never sent', async () => {
    await emit({ method: 'turn.started' });
    await emit({ finishReason: 'stop' });
    await emit({ method: 'turn.started', turnId: 'turn-2' });
    await emit({
      method: 'runtime.error',
      turnId: 'turn-2',
      severity: 'error',
      message: 'boom',
    });
    expect(titles()).toEqual(['Your agent needs attention']);
    await elapse();
    expect(titles()).toEqual(['Your agent needs attention']);
  });

  test('a delegated child announces no finish of its own, but its failure still notifies', async () => {
    delegatedChildren.add('thread-1');
    await emit({ method: 'turn.started' });
    await emit({ finishReason: 'stop' });
    await elapse();
    expect(schedule).not.toHaveBeenCalled();
    await emit({ method: 'turn.started', turnId: 'turn-2' });
    await emit({
      method: 'runtime.error',
      turnId: 'turn-2',
      severity: 'error',
      message: 'boom',
    });
    expect(titles()).toEqual(['Your agent needs attention']);
  });

  test('a hold that ends with no runtime event is read again on the session projection update', async () => {
    facts.set('thread-1', { followUpPending: true });
    await emit({ method: 'turn.started' });
    await emit({ finishReason: 'stop' });
    expect(timers.pending()).toEqual([FINISHED_ALERT_RECHECK_MS]);
    // Claude's pending follow-up expires: only the projection says so.
    facts.delete('thread-1');
    bus.emit(SERVER_EVENTS.ORCHESTRATION_SESSION_PROJECTION_UPDATED, {
      threadId: 'thread-1',
    });
    await notificationService.drainAsyncDispatch();
    // The window opens now, not at the next recheck.
    expect(timers.pending()).toEqual([
      FINISHED_ALERT_RECHECK_MS,
      FINISHED_ALERT_CONFIRM_MS,
    ]);
    await elapse();
    expect(titles()).toEqual(['Your agent finished']);
  });

  test('an unreadable hold fails open: the finish is still announced', async () => {
    holdThrows = true;
    await emit({ method: 'turn.started' });
    await emit({ finishReason: 'stop' });
    await elapse();
    expect(titles()).toEqual(['Your agent finished']);
  });
});

/**
 * The episode record the phone card reads, and its persistence across a
 * restart. Real NotificationService records and a real file store in a
 * temporary Station home: a restart is a second wiring over the same home.
 */
describe('wireTurnCompletionNotifications: episode record and restart', () => {
  const owner = orchestrationStreamPresenceSubjectForSession('owner-1');
  let home: string;
  let holding: Set<string>;
  const services: NotificationService[] = [];
  const unwires: Array<() => void> = [];

  beforeEach(() => {
    home = makeTempDir('turn-completion-episodes-');
    holding = new Set();
  });
  afterEach(async () => {
    for (const unwire of unwires.splice(0)) unwire();
    for (const service of services.splice(0)) await service.shutdown();
  });

  /** One Station process: its bus, records, listener and episode record. */
  async function boot(clock = { now: Date.parse('2026-11-15T16:00:00Z') }) {
    const bus = new EventBus();
    const notifications = new NotificationService(bus, home, 999_999);
    services.push(notifications);
    await notifications.start();
    const timers = manualTimers();
    const episodes = new FinishedAlertEpisodes();
    const warn = vi.fn();
    unwires.push(
      wireTurnCompletionNotifications(
        bus,
        {
          isReadOnlyAttachedSession: () => false,
          isEphemeralSession: () => false,
          resolveSessionPresenceSubject: () => owner,
          readFinishedAlertHold: (threadId) =>
            holding.has(threadId) ? ['child-agent'] : [],
        },
        notifications,
        { warn },
        {
          setTimer: timers.setTimer,
          episodes,
          episodeStore: createFileFinishedAlertEpisodeStore(home),
          now: () => clock.now,
        },
      ),
    );
    const emit = (event: Record<string, unknown>) =>
      bus.emit('orchestration:event', { event: baseEvent(event) });
    const elapse = async () => {
      await notifications.drainAsyncDispatch();
      timers.runAll();
      await notifications.drainAsyncDispatch();
    };
    const finished = async () =>
      (await notifications.list()).filter(
        (record) => record.category === 'turn-completed',
      );
    return { notifications, episodes, emit, elapse, finished, warn, clock };
  }

  test('a completed turn is pending from the moment it is published, and its release names its terminal and time', async () => {
    const station = await boot();
    station.emit({ method: 'turn.started' });
    station.emit({ eventId: 'terminal-1', finishReason: 'stop' });
    // Synchronously, before the producer's queued task runs: the card
    // cannot read Done in that moment.
    expect(station.episodes.isPending('thread-1')).toBe(true);
    await station.notifications.drainAsyncDispatch();
    expect(station.episodes.isPending('thread-1')).toBe(true);
    expect(station.episodes.releaseFor('thread-1')).toBeUndefined();

    station.clock.now += FINISHED_ALERT_CONFIRM_MS;
    await station.elapse();
    expect(station.episodes.isPending('thread-1')).toBe(false);
    expect(station.episodes.releaseFor('thread-1')).toEqual({
      key: 'event:terminal-1',
      at: station.clock.now,
    });
    expect(await station.finished()).toHaveLength(1);
  });

  test('a finish still in its confirmation window when Station stops is sent once after the next start', async () => {
    const first = await boot();
    first.emit({ method: 'turn.started' });
    first.emit({ eventId: 'terminal-1', finishReason: 'stop' });
    await first.notifications.drainAsyncDispatch();
    expect(await first.finished()).toEqual([]);
    // Stopped inside the window: its timer never runs.
    for (const unwire of unwires.splice(0)) unwire();
    await first.notifications.shutdown();

    const second = await boot();
    // Replayed: the card reads it pending until it is sent.
    expect(second.episodes.isPending('thread-1')).toBe(true);
    await second.elapse();
    expect(await second.finished()).toEqual([
      expect.objectContaining({
        title: 'Your agent finished',
        metadata: expect.objectContaining({ turnId: 'turn-1' }),
      }),
    ]);
    expect(second.episodes.releaseFor('thread-1')?.key).toBe(
      'event:terminal-1',
    );
    expect(second.warn).not.toHaveBeenCalled();

    // Sent, so a third start has nothing to replay.
    for (const unwire of unwires.splice(0)) unwire();
    await second.notifications.shutdown();
    const third = await boot();
    expect(third.episodes.isPending('thread-1')).toBe(false);
    await third.elapse();
    expect(await third.finished()).toHaveLength(1);
  });

  test('a finish held across a restart is read again and sent once nothing holds it', async () => {
    holding.add('thread-1');
    const first = await boot();
    first.emit({ method: 'turn.started' });
    first.emit({ finishReason: 'stop' });
    await first.elapse();
    expect(await first.finished()).toEqual([]);
    for (const unwire of unwires.splice(0)) unwire();
    await first.notifications.shutdown();

    const second = await boot();
    await second.elapse();
    // Still held after the restart: not sent.
    expect(await second.finished()).toEqual([]);
    expect(second.episodes.isPending('thread-1')).toBe(true);

    holding.delete('thread-1');
    // The recheck opens the window; the window sends it.
    await second.elapse();
    await second.elapse();
    expect(await second.finished()).toHaveLength(1);
    expect(second.episodes.isPending('thread-1')).toBe(false);
  });

  test('an unreadable saved record replays nothing and says so, and the next finish still goes out', async () => {
    writeFileSync(join(home, 'finished-alert-episodes.json'), '{not json');
    const station = await boot();
    expect(station.warn).toHaveBeenCalledWith(
      'turn-completion: pending finished alerts are unreadable; none were replayed',
      expect.anything(),
    );
    station.emit({ method: 'turn.started' });
    station.emit({ finishReason: 'stop' });
    await station.elapse();
    expect(await station.finished()).toHaveLength(1);
  });
});

/**
 * Each finish's durable steps (held -> writing -> released) across failures
 * and restarts, over a real NotificationService, the real file store and,
 * for the replay of an already-written finish, the real coordinator wake
 * (`wireCoordinatorWakes` over a SQLite coordinator store that outlives each
 * Station process, as the home's database does).
 */
describe('wireTurnCompletionNotifications: durable finish lifecycle', () => {
  const PERSON = 'person-1';
  const owner = orchestrationStreamPresenceSubjectForSession('owner-1');
  const tag = 'turn-completion:thread-1:turn-1';
  let home: string;
  let coordinatorDb: DatabaseSync;
  let coordinatorStore: ReturnType<typeof createSqliteCoordinatorStore>;
  let holding: (threadId: string) => boolean;
  /** The session's reader and attachment, as the write reads them. */
  let recipient: typeof owner | undefined;
  let external: boolean;
  const clock = { now: 0 };
  const services: NotificationService[] = [];
  const unwires: Array<() => void> = [];

  beforeEach(() => {
    home = makeTempDir('turn-completion-durable-');
    coordinatorDb = new DatabaseSync(':memory:');
    coordinatorStore = createSqliteCoordinatorStore(coordinatorDb as never);
    coordinatorStore.designate({
      conversationId: 'coordinator-chat',
      actor: { userId: PERSON },
      replace: false,
      now: Date.parse('2026-11-15T15:00:00Z'),
    });
    holding = () => false;
    recipient = owner;
    external = false;
    clock.now = Date.parse('2026-11-15T16:00:00Z');
  });
  afterEach(async () => {
    await stop();
    coordinatorDb.close();
  });

  /** Station stops: its listeners go, and its records are flushed. */
  async function stop() {
    for (const unwire of unwires.splice(0)) unwire();
    for (const service of services.splice(0)) await service.shutdown();
  }

  const rows = (): PersistedFinishedAlertEpisode[] =>
    JSON.parse(
      readFileSync(join(home, 'finished-alert-episodes.json'), 'utf8'),
    );

  /** Coordinator items waiting for the person, by item key. */
  const coordinatorItems = () =>
    coordinatorStore.waitingItems(PERSON).map((item) => item.itemKey);

  async function boot(
    opts: {
      /** This process's coordinator wake is not listening (it never saw DELIVERED). */
      coordinator?: false;
      /** The process stops before a save that matches this lands. */
      crashBeforeSave?: (
        rows: readonly PersistedFinishedAlertEpisode[],
      ) => boolean;
    } = {},
  ) {
    const bus = new EventBus();
    const notifications = new NotificationService(bus, home, 999_999);
    services.push(notifications);
    await notifications.start();
    const frames: string[] = [];
    unwires.push(bus.subscribe((frame) => void frames.push(frame.event)));
    const timers = manualTimers();
    const episodes = new FinishedAlertEpisodes();
    const warn = vi.fn();
    const file = createFileFinishedAlertEpisodeStore(home);
    const wakes =
      opts.coordinator === false
        ? undefined
        : wireCoordinatorWakes({
            eventBus: bus,
            eventStore: {
              conversationForSession: () => undefined,
              delegationResultStore: () => ({ owner: () => undefined }),
            } as never,
            store: coordinatorStore,
            enabled: () => true,
            threadInbox: {
              submit: vi.fn(),
              list: () => [],
              cancelQueued: () => [],
            } as never,
            mayRead: () => true,
            logger: { warn: vi.fn() } as never,
            setTimer: (() => () => {}) as never,
          });
    if (wakes) unwires.push(() => wakes.unsubscribe());
    unwires.push(
      wireTurnCompletionNotifications(
        bus,
        {
          isReadOnlyAttachedSession: () => external,
          isEphemeralSession: () => false,
          resolveSessionPresenceSubject: () => recipient,
          readFinishedAlertHold: (threadId) =>
            holding(threadId) ? ['child-agent'] : [],
        },
        notifications,
        { warn },
        {
          setTimer: timers.setTimer,
          episodes,
          episodeStore: {
            load: () => file.load(),
            save: (next) => {
              if (opts.crashBeforeSave?.(next))
                throw new Error('simulated stop before the save');
              file.save(next);
            },
          },
          now: () => clock.now,
          // As runtime-route-support.ts wires it.
          onReplayedDelivery: (notification) =>
            wakes?.observeNotification(notification),
        },
      ),
    );
    const emit = (event: Record<string, unknown>) =>
      bus.emit('orchestration:event', { event: baseEvent(event) });
    const elapse = async () => {
      await notifications.drainAsyncDispatch();
      timers.runAll();
      await notifications.drainAsyncDispatch();
    };
    const finished = async () =>
      (await notifications.list()).filter(
        (record) => record.category === 'turn-completed',
      );
    return {
      notifications,
      episodes,
      emit,
      elapse,
      finished,
      warn,
      timers,
      frames,
    };
  }

  test.each(['unread', 'read', 'dismissed'] as const)(
    'a finish written just before Station stopped reaches the coordinator once after the restart, and its record is untouched (%s)',
    async (variant) => {
      // The record is written, then Station stops before the release is saved
      // and before the coordinator saw its NOTIFICATION_DELIVERED.
      const first = await boot({
        coordinator: false,
        crashBeforeSave: (next) => next.some((row) => row.state === 'released'),
      });
      first.emit({ method: 'turn.started' });
      first.emit({ eventId: 'terminal-1', finishReason: 'stop' });
      await first.elapse();
      const [record] = await first.finished();
      expect(record?.metadata).toMatchObject({ dedupeTag: tag });
      expect(rows()).toEqual([
        expect.objectContaining({ state: 'writing', turnId: 'turn-1' }),
      ]);
      if (variant === 'read')
        await first.notifications.markRead(record!.id, 'device:laptop');
      if (variant === 'dismissed')
        await first.notifications.dismiss(record!.id);
      const before = await first.notifications.get(record!.id);
      expect(coordinatorItems()).toEqual([]);
      await stop();

      const second = await boot();
      await second.elapse();
      // A person reading it is not the coordinator seeing it; a dismissal is
      // the person's decision and stands.
      expect(coordinatorItems()).toEqual(
        variant === 'dismissed' ? [] : [`finished:${tag}`],
      );
      // Not rewritten (read state kept), not delivered again (no phone push).
      expect(await second.notifications.get(record!.id)).toEqual(before);
      expect(
        second.frames.filter(
          (event) =>
            event === SERVER_EVENTS.NOTIFICATION_DELIVERED ||
            event === SERVER_EVENTS.NOTIFICATION_UPDATED,
        ),
      ).toEqual([]);
      expect(await second.finished()).toHaveLength(1);
      if (variant === 'dismissed') {
        // Nothing is replayed, and the card gets no fresh release: it reads
        // Done without an "Agent finished".
        expect(second.episodes.releaseFor('thread-1')).toBeUndefined();
        expect(second.episodes.isPending('thread-1')).toBe(false);
        expect(rows()).toEqual([]);
      } else {
        expect(second.episodes.releaseFor('thread-1')?.key).toBe(
          'event:terminal-1',
        );
        expect(rows()).toEqual([
          expect.objectContaining({ state: 'released', turnId: 'turn-1' }),
        ]);
      }
      expect(second.warn).not.toHaveBeenCalled();
    },
  );

  test("a saved finish whose tag is held by another producer's record is not handed to the coordinator", async () => {
    const seed = await boot({ coordinator: false });
    await seed.notifications.schedule('scheduler', {
      category: 'turn-completed',
      title: 'Not this producer',
      body: 'A colliding record',
      dedupeTag: tag,
      metadata: {
        sessionId: 'thread-1',
        threadId: 'thread-1',
        turnId: 'turn-1',
      },
    } as never);
    const [foreign] = await seed.finished();
    await stop();
    writeFileSync(
      join(home, 'finished-alert-episodes.json'),
      JSON.stringify([
        {
          state: 'writing',
          threadId: 'thread-1',
          turnId: 'turn-1',
          outcome: 'done',
          onActivityCard: false,
          attempts: 0,
        },
      ]),
    );

    const station = await boot();
    await station.elapse();
    expect(coordinatorItems()).toEqual([]);
    expect(await station.notifications.get(foreign!.id)).toEqual(foreign);
    expect(station.warn).toHaveBeenCalledWith(
      'turn-completion: a saved finish names a record this producer did not write; not replayed',
      expect.anything(),
    );
    // Another producer's record is no reason to announce this finish.
    expect(station.episodes.releaseFor('thread-1')).toBeUndefined();
    expect(station.episodes.isPending('thread-1')).toBe(false);
    expect(rows()).toEqual([]);
  });

  test('a restart that finds no record for a writing finish drops it as ambiguous: nothing is written, pushed or announced', async () => {
    // The producer's own bytes: the write failed, so the row is `writing`
    // and no record exists. A restart cannot tell this from a record the
    // person cleared, so it must not recreate one.
    const first = await boot({ coordinator: false });
    vi.spyOn(first.notifications, 'scheduleEnveloped').mockRejectedValueOnce(
      new Error('ENOSPC'),
    );
    first.emit({ method: 'turn.started' });
    first.emit({ eventId: 'terminal-1', finishReason: 'stop' });
    await first.elapse();
    expect(await first.finished()).toEqual([]);
    expect(rows()).toEqual([
      expect.objectContaining({ state: 'writing', attempts: 1 }),
    ]);
    await stop();

    const second = await boot();
    await second.elapse();
    await second.elapse();
    expect(await second.finished()).toEqual([]);
    expect(
      second.frames.filter(
        (event) =>
          event === SERVER_EVENTS.NOTIFICATION_DELIVERED ||
          event === SERVER_EVENTS.NOTIFICATION_UPDATED,
      ),
    ).toEqual([]);
    expect(coordinatorItems()).toEqual([]);
    expect(second.episodes.releaseFor('thread-1')).toBeUndefined();
    expect(second.episodes.isPending('thread-1')).toBe(false);
    expect(rows()).toEqual([]);
    expect(second.warn).toHaveBeenCalledWith(
      'turn-completion: replay_ambiguous: a saved finish has no record, and a cleared one looks the same; not replayed',
      expect.objectContaining({ threadId: 'thread-1', turnId: 'turn-1' }),
    );
  });

  test.each(['skipped_no_recipient', 'skipped_external'] as const)(
    'a finish whose session loses its reader before the write ends quietly (%s)',
    async (result) => {
      const station = await boot();
      const write = vi.spyOn(station.notifications, 'scheduleEnveloped');
      station.emit({ method: 'turn.started' });
      station.emit({ eventId: 'terminal-1', finishReason: 'stop' });
      await station.notifications.drainAsyncDispatch();
      // Accepted and held: the confirmation window is open.
      expect(station.episodes.isPending('thread-1')).toBe(true);
      expect(rows()).toEqual([expect.objectContaining({ state: 'held' })]);
      if (result === 'skipped_no_recipient') recipient = undefined;
      else external = true;
      vi.mocked(turnCompletionNotificationOps.add).mockClear();
      await station.elapse();
      expect(write).not.toHaveBeenCalled();
      expect(await station.finished()).toEqual([]);
      expect(
        vi
          .mocked(turnCompletionNotificationOps.add)
          .mock.calls.filter(([, labels]) => labels?.result === result),
      ).toEqual([[1, { outcome: 'done', result }]]);
      // No record, so no fresh release: the card is neither Running nor alerting.
      expect(station.episodes.releaseFor('thread-1')).toBeUndefined();
      expect(station.episodes.isPending('thread-1')).toBe(false);
      expect(rows()).toEqual([]);
    },
  );

  test('a failed write keeps the finish pending on the card, is saved as writing, and is retried with backoff until written', async () => {
    const station = await boot();
    const write = vi
      .spyOn(station.notifications, 'scheduleEnveloped')
      .mockRejectedValueOnce(new Error('ENOSPC'))
      .mockRejectedValueOnce(new Error('ENOSPC'));
    station.emit({ method: 'turn.started' });
    station.emit({ eventId: 'terminal-1', finishReason: 'stop' });
    await station.elapse();
    expect(await station.finished()).toEqual([]);
    // No release on a failed write: the card does not read Done or alert.
    expect(station.episodes.isPending('thread-1')).toBe(true);
    expect(station.episodes.releaseFor('thread-1')).toBeUndefined();
    expect(rows()).toEqual([
      expect.objectContaining({
        state: 'writing',
        attempts: 1,
        nextAttemptAt: clock.now + FINISHED_ALERT_RETRY_BASE_MS,
      }),
    ]);
    expect(station.timers.pending()).toEqual([FINISHED_ALERT_RETRY_BASE_MS]);

    await station.elapse();
    expect(rows()).toEqual([
      expect.objectContaining({ state: 'writing', attempts: 2 }),
    ]);
    expect(station.timers.pending()).toEqual([
      FINISHED_ALERT_RETRY_BASE_MS * 2,
    ]);

    await station.elapse();
    expect(write).toHaveBeenCalledTimes(3);
    expect(await station.finished()).toHaveLength(1);
    expect(station.episodes.releaseFor('thread-1')).toEqual({
      key: 'event:terminal-1',
      at: clock.now,
    });
    expect(rows()).toEqual([
      expect.objectContaining({ state: 'released', releasedAt: clock.now }),
    ]);
    // Backoff is capped (pinned beside the constant it derives from).
    expect(FINISHED_ALERT_RETRY_BASE_MS).toBe(10_000);
    expect(FINISHED_ALERT_RETRY_MAX_MS).toBe(600_000);
  });

  test('a newer finish on the thread replaces an older one whose write failed: one record, for the newer turn, across a restart', async () => {
    const first = await boot();
    vi.spyOn(first.notifications, 'scheduleEnveloped').mockRejectedValueOnce(
      new Error('ENOSPC'),
    );
    first.emit({ method: 'turn.started' });
    first.emit({ eventId: 'terminal-1', finishReason: 'stop' });
    await first.elapse();
    first.emit({ method: 'turn.started', turnId: 'turn-2' });
    first.emit({
      eventId: 'terminal-2',
      turnId: 'turn-2',
      finishReason: 'stop',
    });
    await first.notifications.drainAsyncDispatch();
    expect(rows()).toEqual([
      expect.objectContaining({ state: 'held', turnId: 'turn-2' }),
    ]);
    await stop();

    const second = await boot();
    await second.elapse();
    expect(await second.finished()).toEqual([
      expect.objectContaining({
        metadata: expect.objectContaining({ turnId: 'turn-2' }),
      }),
    ]);
    expect(second.episodes.releaseFor('thread-1')?.key).toBe(
      'event:terminal-2',
    );
  });

  test('a finish waiting on a write retry never follows a later failure, and a new turn takes it back as held', async () => {
    const station = await boot();
    vi.spyOn(station.notifications, 'scheduleEnveloped').mockRejectedValueOnce(
      new Error('ENOSPC'),
    );
    station.emit({ method: 'turn.started' });
    station.emit({ eventId: 'terminal-1', finishReason: 'stop' });
    await station.elapse();
    expect(rows()).toEqual([expect.objectContaining({ state: 'writing' })]);
    // A new turn starts while the retry waits: the finish is held again
    // with that turn open, so its alert cannot go out while it runs.
    station.emit({ method: 'turn.started', turnId: 'turn-2' });
    await station.notifications.drainAsyncDispatch();
    expect(rows()).toEqual([
      expect.objectContaining({ state: 'held', turnId: 'turn-1' }),
    ]);
    await station.elapse();
    expect(await station.finished()).toEqual([]);
    // The turn fails: the failure is reported and the episode ends.
    station.emit({
      method: 'runtime.error',
      turnId: 'turn-2',
      message: 'boom',
    });
    await station.elapse();
    await station.elapse();
    expect(
      (await station.notifications.list()).map((record) => record.title),
    ).toEqual(['Your agent needs attention']);
    expect(station.episodes.isPending('thread-1')).toBe(false);
    expect(rows()).toEqual([]);
  });

  test('when the writing step cannot be saved, nothing is written or announced and the finish stays held', async () => {
    let refuse = true;
    const station = await boot({
      crashBeforeSave: (next) =>
        refuse && next.some((row) => row.state === 'writing'),
    });
    station.emit({ method: 'turn.started' });
    station.emit({ eventId: 'terminal-1', finishReason: 'stop' });
    await station.elapse();
    expect(await station.finished()).toEqual([]);
    expect(station.episodes.isPending('thread-1')).toBe(true);
    expect(station.episodes.releaseFor('thread-1')).toBeUndefined();
    expect(rows()).toEqual([
      expect.objectContaining({ state: 'held', turnId: 'turn-1' }),
    ]);
    expect(station.timers.pending()).toEqual([FINISHED_ALERT_RECHECK_MS]);
    // The store recovers: the recheck opens the window, and it is sent.
    refuse = false;
    await station.elapse();
    await station.elapse();
    expect(await station.finished()).toHaveLength(1);
  });

  test('a failure accepted while a finish waits on its write retry ends that finish', async () => {
    const station = await boot();
    vi.spyOn(station.notifications, 'scheduleEnveloped').mockRejectedValueOnce(
      new Error('ENOSPC'),
    );
    station.emit({ method: 'turn.started' });
    station.emit({ eventId: 'terminal-1', finishReason: 'stop' });
    await station.elapse();
    expect(rows()).toEqual([expect.objectContaining({ state: 'writing' })]);
    // No turn.started first: the failure reaches the waiting row directly.
    station.emit({ method: 'turn.aborted', reason: 'error' });
    await station.notifications.drainAsyncDispatch();
    expect(station.timers.pending()).toEqual([]);
    expect(rows()).toEqual([]);
    await station.elapse();
    expect(await station.finished()).toEqual([]);
  });

  test("a new turn leaves a restart's not-yet-looked-up finish to its lookup, so its record is never rewritten", async () => {
    const first = await boot({
      coordinator: false,
      crashBeforeSave: (next) => next.some((row) => row.state === 'released'),
    });
    first.emit({ method: 'turn.started' });
    first.emit({ eventId: 'terminal-1', finishReason: 'stop' });
    await first.elapse();
    const [record] = await first.finished();
    await first.notifications.markRead(record!.id, 'device:laptop');
    const before = await first.notifications.get(record!.id);
    await stop();

    const lookup = vi
      .spyOn(NotificationService.prototype, 'findByDedupeTag')
      .mockRejectedValueOnce(new Error('store locked'));
    const second = await boot();
    await second.notifications.drainAsyncDispatch();
    // A provider turn opens and closes without a result while the lookup
    // waits on its retry.
    const provider = { trigger: 'provider' };
    second.emit({
      method: 'turn.started',
      turnId: 'turn-2',
      metadata: provider,
    });
    second.emit({
      eventId: 'terminal-2',
      turnId: 'turn-2',
      finishReason: 'other',
      metadata: { ...provider, closedWithoutResult: 'session-ended' },
    });
    await second.elapse();
    await second.elapse();
    expect(await second.notifications.get(record!.id)).toEqual(before);
    expect(coordinatorItems()).toEqual([`finished:${tag}`]);
    lookup.mockRestore();
  });

  test('a restart whose record lookup fails retries it with backoff instead of leaving the card in Running', async () => {
    const first = await boot({
      coordinator: false,
      crashBeforeSave: (next) => next.some((row) => row.state === 'released'),
    });
    first.emit({ method: 'turn.started' });
    first.emit({ eventId: 'terminal-1', finishReason: 'stop' });
    await first.elapse();
    await stop();

    const lookup = vi
      .spyOn(NotificationService.prototype, 'findByDedupeTag')
      .mockRejectedValueOnce(new Error('store locked'));
    const second = await boot();
    await second.notifications.drainAsyncDispatch();
    expect(second.episodes.isPending('thread-1')).toBe(true);
    expect(coordinatorItems()).toEqual([]);
    expect(rows()).toEqual([
      expect.objectContaining({ state: 'writing', attempts: 1 }),
    ]);
    expect(second.timers.pending()).toEqual([FINISHED_ALERT_RETRY_BASE_MS]);
    await second.elapse();
    expect(lookup).toHaveBeenCalledTimes(2);
    expect(coordinatorItems()).toEqual([`finished:${tag}`]);
    expect(second.episodes.isPending('thread-1')).toBe(false);
    expect(await second.finished()).toHaveLength(1);
    lookup.mockRestore();
  });

  test('a finish whose tag another producer owns ends without a record instead of retrying forever', async () => {
    const station = await boot();
    await station.notifications.schedule('scheduler', {
      category: 'turn-completed',
      title: 'Not this producer',
      body: 'A colliding record',
      dedupeTag: tag,
    } as never);
    station.emit({ method: 'turn.started' });
    station.emit({ eventId: 'terminal-1', finishReason: 'stop' });
    await station.elapse();
    expect(station.warn).toHaveBeenCalledWith(
      'turn-completion: a finished alert cannot be written; its tag belongs to another producer',
      expect.anything(),
    );
    expect(station.timers.pending()).toEqual([]);
    expect(station.episodes.isPending('thread-1')).toBe(false);
    // Not this producer's record: no fresh release for the card either.
    expect(station.episodes.releaseFor('thread-1')).toBeUndefined();
    expect(rows()).toEqual([]);
  });

  test('a release is restored by a restart inside the card window and forgotten after it', async () => {
    const first = await boot();
    first.emit({ method: 'turn.started' });
    first.emit({ eventId: 'terminal-1', finishReason: 'stop' });
    await first.elapse();
    const releasedAt = clock.now;
    expect(first.episodes.releaseFor('thread-1')?.at).toBe(releasedAt);
    await stop();

    clock.now = releasedAt + 60_000;
    const second = await boot();
    expect(second.episodes.releaseFor('thread-1')).toEqual({
      key: 'event:terminal-1',
      at: releasedAt,
    });
    expect(second.episodes.isPending('thread-1')).toBe(false);
    await second.elapse();
    expect(await second.finished()).toHaveLength(1);
    await stop();

    clock.now = releasedAt + 2 * 60_000 + 1;
    const third = await boot();
    expect(third.episodes.releaseFor('thread-1')).toBeUndefined();
  });

  describe(`the ${FINISHED_ALERT_EPISODES_MAX}-row bound`, () => {
    const heldRow = (index: number) => ({
      state: 'held',
      threadId: `held-${index}`,
      turnId: 'turn-1',
      outcome: 'done',
      onActivityCard: false,
    });
    function seed(rowsToSeed: unknown[]) {
      writeFileSync(
        join(home, 'finished-alert-episodes.json'),
        JSON.stringify(rowsToSeed),
      );
    }
    const finishNewThread = async (
      station: Awaited<ReturnType<typeof boot>>,
    ) => {
      station.emit({ method: 'turn.started', threadId: 'thread-new' });
      station.emit({ threadId: 'thread-new', finishReason: 'stop' });
      await station.notifications.drainAsyncDispatch();
    };

    beforeEach(() => {
      holding = (threadId) => threadId.startsWith('held-');
    });

    test('below it, a new finish is held: the store reaches exactly the bound', async () => {
      expect(FINISHED_ALERT_EPISODES_MAX).toBe(2_000);
      seed(
        Array.from({ length: FINISHED_ALERT_EPISODES_MAX - 1 }, (_, i) =>
          heldRow(i),
        ),
      );
      const station = await boot();
      await finishNewThread(station);
      expect(rows()).toHaveLength(FINISHED_ALERT_EPISODES_MAX);
      expect(rows().at(-1)).toMatchObject({
        state: 'held',
        threadId: 'thread-new',
      });
      expect(station.warn).not.toHaveBeenCalled();
    });

    test('at it, a released row gives way to the new finish', async () => {
      seed([
        {
          state: 'released',
          threadId: 'released-1',
          turnId: 'turn-1',
          releaseKey: 'event:old',
          releasedAt: clock.now,
        },
        ...Array.from({ length: FINISHED_ALERT_EPISODES_MAX - 1 }, (_, i) =>
          heldRow(i),
        ),
      ]);
      const station = await boot();
      await finishNewThread(station);
      const saved = rows();
      expect(saved).toHaveLength(FINISHED_ALERT_EPISODES_MAX);
      expect(saved.some((row) => row.threadId === 'released-1')).toBe(false);
      expect(saved.some((row) => row.threadId === 'thread-new')).toBe(true);
      expect(station.warn).not.toHaveBeenCalled();
    });

    test('full of held finishes, the new one is refused and said so; every accepted finish is kept', async () => {
      seed(
        Array.from({ length: FINISHED_ALERT_EPISODES_MAX }, (_, i) =>
          heldRow(i),
        ),
      );
      const station = await boot();
      await finishNewThread(station);
      await station.elapse();
      expect(station.warn).toHaveBeenCalledWith(
        `finished-alert episodes full (${FINISHED_ALERT_EPISODES_MAX}); finish for thread-new not held`,
        { threadId: 'thread-new' },
      );
      expect(turnCompletionNotificationOps.add).toHaveBeenCalledWith(1, {
        outcome: 'done',
        result: 'overflow',
      });
      expect(station.episodes.isPending('thread-new')).toBe(false);
      expect(await station.finished()).toEqual([]);
      const saved = rows();
      expect(saved).toHaveLength(FINISHED_ALERT_EPISODES_MAX);
      expect(saved.some((row) => row.threadId === 'thread-new')).toBe(false);
    });
  });
});
