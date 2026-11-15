/**
 * A follow-up waiting in a conversation's inbox holds that session's
 * "finished" alert and its phone card's Done. The inbox lives outside
 * `OrchestrationService`, so only the runtime composition
 * (`configureRuntimeSupportServices`) joins the two: it hands the
 * turn-completion listener and the agent-activity session reader one reader
 * that adds `queued-follow-up` from `options.threadInbox`. The card then
 * reads the listener's completion episodes (`finished-alert-episodes.ts`),
 * so it stays held until the same release the push waits for. Drives that
 * REAL composition: the real EventBus, NotificationService and
 * turn-completion listener, with the inbox answering per thread.
 */
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, expect, test, vi } from 'vitest';
import { trackTempDirs } from '../../../__test-utils__/temp-dirs.js';

// Passthrough spy: what the composition hands the phone card's reader.
const reader = vi.hoisted(() => ({ deps: [] as unknown[] }));
vi.mock('../agent-activity-session-reader.js', async (importOriginal) => {
  const original =
    await importOriginal<
      typeof import('../agent-activity-session-reader.js')
    >();
  return {
    ...original,
    createAgentActivitySessionReader: (
      deps: Parameters<typeof original.createAgentActivitySessionReader>[0],
    ) => {
      reader.deps.push(deps);
      return original.createAgentActivitySessionReader(deps);
    },
  };
});

// Passthrough spy: the composition flushes the phone card when an episode
// changes, which no lifecycle event announces.
const publisher = vi.hoisted(() => ({ flushes: 0 }));
vi.mock(
  '../../../services/notifications/agent-activity-publisher.js',
  async (importOriginal) => {
    const original =
      await importOriginal<
        typeof import('../../../services/notifications/agent-activity-publisher.js')
      >();
    return {
      ...original,
      wireAgentActivityPublisher: (
        options: Parameters<typeof original.wireAgentActivityPublisher>[0],
      ) => {
        const wired = original.wireAgentActivityPublisher(options);
        return {
          ...wired,
          requestFlush: () => {
            publisher.flushes += 1;
            wired.requestFlush();
          },
        };
      },
    };
  },
);

const { configureRuntimeSupportServices } = await import(
  '../runtime-route-support.js'
);
const { EventBus } = await import(
  '../../../services/orchestration/event-bus.js'
);
const { orchestrationStreamPresenceSubjectForSession } = await import(
  '../../../services/orchestration/orchestration-stream-presence.js'
);
const { FINISHED_ALERT_CONFIRM_MS, FINISHED_ALERT_RECHECK_MS } = await import(
  '../../../services/orchestration/turn-completion-notifications.js'
);

const makeTempDir = trackTempDirs();
const shutdowns: Array<() => Promise<unknown>> = [];

afterEach(async () => {
  vi.useRealTimers();
  for (const shutdown of shutdowns.splice(0)) await shutdown();
});

/** Every property is a no-op returning the same stub (never a thenable). */
function stub(): any {
  const fn: any = () => proxy;
  const proxy: any = new Proxy(fn, {
    get: (_target, key) =>
      key === 'then' || key === Symbol.toPrimitive ? undefined : proxy,
    apply: () => proxy,
  });
  return proxy;
}

/** Real members first; anything else the composition touches is inert. */
function withStubFallback<T extends object>(members: T): T {
  return new Proxy(members, {
    get: (target, key) => (key in target ? Reflect.get(target, key) : stub()),
  }) as T;
}

test('a queued inbox follow-up holds the finished alert and the card Done until it is placed', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  const eventBus = new EventBus();
  const owner = orchestrationStreamPresenceSubjectForSession('owner-1');
  const waiting = new Set<string>(['thread-held']);
  const inbox = {
    submit: vi.fn(),
    entry: vi.fn(),
    hasWaitingFollowUp: (id: string) => waiting.has(id),
  };
  const context = new Proxy(
    {
      eventBus,
      logger: { warn: vi.fn(), info: vi.fn(), debug: vi.fn(), error: vi.fn() },
      configLoader: {
        getProjectHomeDir: () => makeTempDir('runtime-support-held-'),
      },
      orchestrationService: withStubFallback({
        isReadOnlyAttachedSession: () => false,
        isEphemeralSession: () => false,
        resolveSessionPresenceSubject: () => owner,
        consumeInternalStopSuppression: () => false,
        isDelegatedChildSession: () => false,
        // The service's own facts: nothing running. A fresh array per call,
        // as the real service returns.
        readFinishedAlertHold: (): string[] => [],
      }),
    } as Record<PropertyKey, unknown>,
    { get: (target, key) => (key in target ? target[key] : stub()) },
  );
  reader.deps.length = 0;
  const services = configureRuntimeSupportServices(context as never, stub(), {
    webPushEnabled: false,
    threadInbox: () => inbox as never,
  });
  shutdowns.push(() => services.notificationService.shutdown());
  const notifications = services.notificationService;
  await notifications.start();

  const finishedFor = async (threadId: string) =>
    (await notifications.list()).filter(
      (n) =>
        n.source === 'turn-completion' &&
        (n.metadata as { threadId?: string } | null)?.threadId === threadId,
    );
  const settle = async (ms: number) => {
    await notifications.drainAsyncDispatch();
    await vi.advanceTimersByTimeAsync(ms);
    await notifications.drainAsyncDispatch();
  };

  for (const threadId of ['thread-held', 'thread-free']) {
    const turn = {
      createdAt: new Date().toISOString(),
      provider: 'claude',
      threadId,
      turnId: 'turn-1',
    };
    eventBus.emit('orchestration:event', {
      event: { ...turn, method: 'turn.started', prompt: 'go' },
    });
    eventBus.emit('orchestration:event', {
      event: { ...turn, method: 'turn.completed', finishReason: 'stop' },
    });
  }
  await settle(FINISHED_ALERT_CONFIRM_MS + 1);

  // Control: the same pipeline announces a session with nothing waiting.
  expect(await finishedFor('thread-free')).toHaveLength(1);
  // The waiting follow-up holds the other one, past windows and rechecks.
  expect(await finishedFor('thread-held')).toEqual([]);
  await settle(FINISHED_ALERT_RECHECK_MS + FINISHED_ALERT_CONFIRM_MS);
  expect(await finishedFor('thread-held')).toEqual([]);

  // The phone card's reader reads the same episodes: held, and released.
  expect(reader.deps).toHaveLength(1);
  const cardDeps = reader.deps[0] as {
    finishedAlertHeld?: (threadId: string) => boolean;
    finishedAlertRelease?: (
      threadId: string,
    ) => { key: string; at: number } | undefined;
  };
  expect(cardDeps.finishedAlertHeld?.('thread-held')).toBe(true);
  expect(cardDeps.finishedAlertHeld?.('thread-free')).toBe(false);
  expect(cardDeps.finishedAlertRelease?.('thread-free')).toBeDefined();
  expect(cardDeps.finishedAlertRelease?.('thread-held')).toBeUndefined();

  // The follow-up is placed (no turn followed, in this test). The card
  // stays held until the release: the next recheck opens the window, and
  // exactly one "finished" goes out when it closes.
  waiting.delete('thread-held');
  expect(cardDeps.finishedAlertHeld?.('thread-held')).toBe(true);
  await settle(FINISHED_ALERT_RECHECK_MS);
  expect(await finishedFor('thread-held')).toEqual([]);
  expect(cardDeps.finishedAlertHeld?.('thread-held')).toBe(true);
  const flushesBefore = publisher.flushes;
  await settle(FINISHED_ALERT_CONFIRM_MS);
  // The release reaches the card without any event of its own.
  expect(publisher.flushes).toBeGreaterThan(flushesBefore);
  expect(await finishedFor('thread-held')).toEqual([
    expect.objectContaining({
      category: 'turn-completed',
      title: 'Your agent finished',
    }),
  ]);
  expect(cardDeps.finishedAlertHeld?.('thread-held')).toBe(false);
  expect(cardDeps.finishedAlertRelease?.('thread-held')).toBeDefined();
});

test('a restart that finds a finish already written hands its record to the coordinator wake the runtime passes in', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  const home = makeTempDir('runtime-support-replay-');
  const owner = orchestrationStreamPresenceSubjectForSession('owner-1');
  /** One Station process over `home`, composed as the runtime does. */
  const compose = async (
    coordinatorWakes?: () => { observeNotification: (n: unknown) => unknown },
  ) => {
    const eventBus = new EventBus();
    const context = new Proxy(
      {
        eventBus,
        logger: {
          warn: vi.fn(),
          info: vi.fn(),
          debug: vi.fn(),
          error: vi.fn(),
        },
        configLoader: { getProjectHomeDir: () => home },
        orchestrationService: withStubFallback({
          isReadOnlyAttachedSession: () => false,
          isEphemeralSession: () => false,
          resolveSessionPresenceSubject: () => owner,
          consumeInternalStopSuppression: () => false,
          isDelegatedChildSession: () => false,
          readFinishedAlertHold: (): string[] => [],
        }),
      } as Record<PropertyKey, unknown>,
      { get: (target, key) => (key in target ? target[key] : stub()) },
    );
    const services = configureRuntimeSupportServices(context as never, stub(), {
      webPushEnabled: false,
      threadInbox: () =>
        ({
          submit: vi.fn(),
          entry: vi.fn(),
          hasWaitingFollowUp: () => false,
        }) as never,
      ...(coordinatorWakes
        ? { coordinatorWakes: coordinatorWakes as never }
        : {}),
    });
    await services.notificationService.start();
    const settle = async (ms: number) => {
      await services.notificationService.drainAsyncDispatch();
      await vi.advanceTimersByTimeAsync(ms);
      await services.notificationService.drainAsyncDispatch();
    };
    return { eventBus, notifications: services.notificationService, settle };
  };

  const first = await compose();
  const turn = {
    createdAt: new Date().toISOString(),
    provider: 'claude',
    threadId: 'thread-1',
    turnId: 'turn-1',
  };
  first.eventBus.emit('orchestration:event', {
    event: { ...turn, method: 'turn.started', prompt: 'go' },
  });
  first.eventBus.emit('orchestration:event', {
    event: { ...turn, method: 'turn.completed', finishReason: 'stop' },
  });
  await first.settle(FINISHED_ALERT_CONFIRM_MS + 1);
  const [record] = (await first.notifications.list()).filter(
    (n) => n.source === 'turn-completion',
  );
  expect(record).toBeDefined();
  await first.notifications.shutdown();
  // Station stopped after the write, before the release was saved: the
  // row the producer saves before writing (finished-alert-episodes.ts).
  writeFileSync(
    join(home, 'finished-alert-episodes.json'),
    JSON.stringify([
      {
        state: 'writing',
        threadId: 'thread-1',
        turnId: 'turn-1',
        outcome: 'done',
        onActivityCard: true,
        attempts: 0,
      },
    ]),
  );

  const observeNotification = vi.fn();
  const second = await compose(() => ({ observeNotification }));
  shutdowns.push(() => second.notifications.shutdown());
  await second.settle(0);
  expect(observeNotification).toHaveBeenCalledTimes(1);
  expect(observeNotification).toHaveBeenCalledWith(
    expect.objectContaining({ id: record!.id, category: 'turn-completed' }),
  );
});
