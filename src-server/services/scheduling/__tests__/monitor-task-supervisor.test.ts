import {
  type CanonicalRuntimeEvent,
  SERVER_EVENTS,
} from '@kontourai/station-contracts/runtime-events';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { trackTempDirs } from '../../../__test-utils__/temp-dirs.js';
import { EventBus } from '../../orchestration/event-bus.js';
import { BuiltinScheduler } from '../builtin-scheduler.js';
import { MonitorTaskTurnSupervisor } from '../monitor-task-supervisor.js';
import { createSchedulerLedger } from '../scheduler-ledger.js';

const sessions = new Map<string, CanonicalRuntimeEvent[]>();
const cleanups: Array<() => void> = [];
// Created before the afterEach below so its removal runs after those cleanups.
const makeTempDir = trackTempDirs();

afterEach(() => {
  sessions.clear();
  cleanups.splice(0).forEach((cleanup) => cleanup());
  vi.useRealTimers();
});

function event(
  sessionId: string,
  method: CanonicalRuntimeEvent['method'],
  turnId: string,
  extra: Record<string, unknown> = {},
): CanonicalRuntimeEvent {
  return {
    eventId: `${method}:${turnId}:${sessions.get(sessionId)?.length ?? 0}`,
    provider: 'bedrock',
    threadId: sessionId,
    createdAt: new Date().toISOString(),
    method,
    turnId,
    ...extra,
  } as CanonicalRuntimeEvent;
}

function fixture() {
  const bus = new EventBus();
  let admission: ((input: { threadId: string }) => any) | undefined;
  const interrupt = vi.fn(async () => undefined);
  const supervisor = new MonitorTaskTurnSupervisor({
    eventBus: bus,
    registerTurnAdmission: (candidate) => {
      admission = candidate;
      return () => {
        admission = undefined;
      };
    },
    interruptTurn: interrupt,
    listEvents: (sessionId) => sessions.get(sessionId) ?? [],
  });
  cleanups.push(() => supervisor.close());
  const publish = (value: CanonicalRuntimeEvent) => {
    const values = sessions.get(value.threadId) ?? [];
    values.push(value);
    sessions.set(value.threadId, values);
    bus.emit(SERVER_EVENTS.ORCHESTRATION_EVENT, { event: value });
  };
  const seed = (value: CanonicalRuntimeEvent) => {
    const values = sessions.get(value.threadId) ?? [];
    values.push(value);
    sessions.set(value.threadId, values);
  };
  return {
    supervisor,
    publish,
    seed,
    interrupt,
    admission: () => admission!,
    admissionRaw: () => admission,
  };
}

function arm(
  f: ReturnType<typeof fixture>,
  overrides: Partial<{
    sessionId: string;
    maxTurns: number;
    maxTokens: number;
    signal: AbortSignal;
    deadlineAt: number;
    onInitialTurnStarted: (task: {
      taskId: string;
      sessionId: string;
      turnId: string;
    }) => void;
  }> = {},
) {
  const initial = overrides.onInitialTurnStarted ?? vi.fn();
  f.supervisor.arm({
    triggerId: 'trigger-1',
    taskId: 'task-1',
    sessionId: overrides.sessionId ?? 'session-1',
    deadlineAt: overrides.deadlineAt ?? Date.now() + 60_000,
    limits: {
      maxTurns: overrides.maxTurns ?? 2,
      maxTokens: overrides.maxTokens ?? 100,
    },
    signal: overrides.signal ?? new AbortController().signal,
    onInitialTurnStarted: initial,
  });
  return initial;
}

describe('MonitorTaskTurnSupervisor', () => {
  test('persists the authoritative initial turn, not a scheduler dispatch id, and returns its exact receipt', () => {
    const f = fixture();
    const initial = arm(f);
    f.publish(event('session-1', 'turn.started', 'provider-turn-1'));
    f.publish(
      event('session-1', 'token-usage.updated', 'provider-turn-1', {
        totalTokens: 7,
      }),
    );
    f.publish(event('session-1', 'turn.completed', 'provider-turn-1'));
    expect(initial).toHaveBeenCalledWith({
      taskId: 'task-1',
      sessionId: 'session-1',
      turnId: 'provider-turn-1',
    });
    expect(
      f.supervisor.receipt({
        triggerId: 'trigger-1',
        monitorId: 'monitor',
        task: {
          taskId: 'task-1',
          sessionId: 'session-1',
          turnId: 'provider-turn-1',
        },
        startedAt: new Date().toISOString(),
        deadlineAt: new Date(Date.now() + 60_000).toISOString(),
        limits: { maxTurns: 2, maxTokens: 100 },
      }),
    ).toMatchObject({ turns: 1, tokens: 7 });
  });

  test('#2324: a turn the engine opened on its own is never taken as the monitor’s initial turn, but one after it counts toward the budget', () => {
    const f = fixture();
    const initial = arm(f);
    const provider = { metadata: { trigger: 'provider' } };
    f.publish(event('session-1', 'turn.started', 'provider:early', provider));
    expect(initial).not.toHaveBeenCalled();
    f.publish(event('session-1', 'turn.completed', 'provider:early', provider));
    f.publish(event('session-1', 'turn.started', 'monitor-turn'));
    expect(initial).toHaveBeenCalledWith({
      taskId: 'task-1',
      sessionId: 'session-1',
      turnId: 'monitor-turn',
    });
    f.publish(
      event('session-1', 'token-usage.updated', 'monitor-turn', {
        totalTokens: 7,
      }),
    );
    f.publish(event('session-1', 'turn.completed', 'monitor-turn'));
    // The engine replies on its own after the monitor's turn: that reply's
    // tokens are the task's too.
    f.publish(event('session-1', 'turn.started', 'provider:late', provider));
    f.publish(
      event('session-1', 'token-usage.updated', 'provider:late', {
        totalTokens: 5,
      }),
    );
    f.publish(event('session-1', 'turn.completed', 'provider:late', provider));
    expect(
      f.supervisor.receipt({
        triggerId: 'trigger-1',
        monitorId: 'monitor',
        task: {
          taskId: 'task-1',
          sessionId: 'session-1',
          turnId: 'monitor-turn',
        },
        startedAt: new Date().toISOString(),
        deadlineAt: new Date(Date.now() + 60_000).toISOString(),
        limits: { maxTurns: 2, maxTokens: 100 },
      }),
    ).toMatchObject({ turns: 2, tokens: 12 });
  });

  test('allows the initial turn but refuses the second after maxCompletedTurns', () => {
    const f = fixture();
    arm(f, { maxTurns: 1 });
    expect(f.admission()({ threadId: 'session-1' })).toEqual({ allowed: true });
    f.publish(event('session-1', 'turn.started', 'turn-1'));
    f.publish(
      event('session-1', 'token-usage.updated', 'turn-1', { totalTokens: 1 }),
    );
    f.publish(event('session-1', 'turn.completed', 'turn-1'));
    expect(f.admission()({ threadId: 'session-1' })).toMatchObject({
      allowed: false,
    });
    expect(f.interrupt).toHaveBeenCalledWith('session-1');
  });

  test('refuses a successor when the observed Task token total reached its fence', () => {
    const f = fixture();
    arm(f, { maxTokens: 3 });
    f.publish(event('session-1', 'turn.started', 'turn-1'));
    f.publish(
      event('session-1', 'token-usage.updated', 'turn-1', { totalTokens: 3 }),
    );
    expect(f.admission()({ threadId: 'session-1' })).toMatchObject({
      allowed: false,
    });
  });

  test('interrupts the current long-running turn as soon as usage reaches its token fence', () => {
    const f = fixture();
    arm(f, { maxTokens: 3 });
    f.publish(event('session-1', 'turn.started', 'turn-1'));
    f.publish(
      event('session-1', 'token-usage.updated', 'turn-1', { totalTokens: 3 }),
    );
    expect(f.interrupt).toHaveBeenCalledWith('session-1');
  });

  test('uses the canonical terminal timestamp, not reconciliation time, for runtime accounting', () => {
    const f = fixture();
    arm(f);
    f.publish(
      event('session-1', 'turn.started', 'turn-1', {
        createdAt: '2026-01-01T00:00:00.000Z',
      }),
    );
    f.publish(
      event('session-1', 'token-usage.updated', 'turn-1', { totalTokens: 3 }),
    );
    f.publish(
      event('session-1', 'turn.completed', 'turn-1', {
        createdAt: '2026-01-01T00:00:02.500Z',
      }),
    );
    expect(
      f.supervisor.receipt({
        triggerId: 'trigger-1',
        monitorId: 'monitor',
        task: { taskId: 'task-1', sessionId: 'session-1', turnId: 'turn-1' },
        startedAt: '2026-01-01T00:00:00.000Z',
        deadlineAt: new Date(Date.now() + 60_000).toISOString(),
        limits: { maxTurns: 2, maxTokens: 100 },
      }),
    ).toMatchObject({ runtimeMs: 2500 });
  });

  test('interrupts a running turn when the wall deadline expires', () => {
    vi.useFakeTimers();
    const f = fixture();
    arm(f, { deadlineAt: Date.now() + 1 });
    f.publish(event('session-1', 'turn.started', 'turn-1'));
    vi.advanceTimersByTime(1);
    expect(f.interrupt).toHaveBeenCalledWith('session-1');
  });

  test('uses the scheduler stop signal for a live monitor session', () => {
    const f = fixture();
    const controller = new AbortController();
    arm(f, { signal: controller.signal });
    controller.abort(new Error('Scheduler is stopping'));
    expect(f.interrupt).toHaveBeenCalledWith('session-1');
  });

  test('re-adopts a persisted observer and fences a successor after restart', () => {
    const f = fixture();
    const controller = new AbortController();
    f.supervisor.adopt(
      {
        triggerId: 'trigger-1',
        monitorId: 'monitor',
        task: { taskId: 'task-1', sessionId: 'session-1', turnId: 'turn-1' },
        startedAt: new Date().toISOString(),
        deadlineAt: new Date(Date.now() + 60_000).toISOString(),
        limits: { maxTurns: 1, maxTokens: 10 },
      },
      controller.signal,
      () => undefined,
    );
    f.publish(event('session-1', 'turn.started', 'turn-1'));
    f.publish(
      event('session-1', 'token-usage.updated', 'turn-1', { totalTokens: 1 }),
    );
    f.publish(event('session-1', 'turn.completed', 'turn-1'));
    expect(f.admission()({ threadId: 'session-1' })).toMatchObject({
      allowed: false,
    });
  });

  test('hydrates a complete persisted Task window without any live EventBus replay', () => {
    const f = fixture();
    f.seed(
      event('session-1', 'turn.started', 'turn-1', {
        createdAt: '2026-01-01T00:00:00.000Z',
      }),
    );
    f.seed(
      event('session-1', 'token-usage.updated', 'turn-1', {
        totalTokens: 8,
        createdAt: '2026-01-01T00:00:01.000Z',
      }),
    );
    f.seed(
      event('session-1', 'turn.completed', 'turn-1', {
        createdAt: '2026-01-01T00:00:03.000Z',
      }),
    );
    const persisted = vi.fn();
    f.supervisor.adopt(
      {
        triggerId: 'trigger-1',
        monitorId: 'monitor',
        task: { taskId: 'task-1', sessionId: 'session-1', turnId: 'turn-1' },
        startedAt: '2026-01-01T00:00:00.000Z',
        deadlineAt: new Date(Date.now() + 60_000).toISOString(),
        limits: { maxTurns: 2, maxTokens: 10 },
      },
      new AbortController().signal,
      persisted,
    );
    expect(persisted).not.toHaveBeenCalled();
    expect(
      f.supervisor.receipt({
        triggerId: 'trigger-1',
        monitorId: 'monitor',
        task: { taskId: 'task-1', sessionId: 'session-1', turnId: 'turn-1' },
        startedAt: '2026-01-01T00:00:00.000Z',
        deadlineAt: new Date(Date.now() + 60_000).toISOString(),
        limits: { maxTurns: 2, maxTokens: 10 },
      }),
    ).toEqual({ turns: 1, tokens: 8, runtimeMs: 3000 });
  });

  test('persists the recovered first turn when boot adoption finds it in the event ledger', () => {
    const f = fixture();
    f.publish(event('session-1', 'turn.started', 'recovered-turn'));
    const persisted = vi.fn();
    f.supervisor.adopt(
      {
        triggerId: 'trigger-1',
        monitorId: 'monitor',
        task: { taskId: 'task-1', sessionId: 'session-1' },
        startedAt: new Date().toISOString(),
        deadlineAt: new Date(Date.now() + 60_000).toISOString(),
        limits: { maxTurns: 1, maxTokens: 10 },
      },
      new AbortController().signal,
      persisted,
    );
    expect(persisted).toHaveBeenCalledWith({
      taskId: 'task-1',
      sessionId: 'session-1',
      turnId: 'recovered-turn',
    });
    expect(persisted).toHaveBeenCalledTimes(1);
  });

  test('release and close remove the monitor observer and clear its deadline timer', () => {
    vi.useFakeTimers();
    const f = fixture();
    arm(f, { deadlineAt: Date.now() + 10 });
    f.supervisor.release('trigger-1');
    vi.advanceTimersByTime(10);
    expect(f.interrupt).not.toHaveBeenCalled();
    expect(f.admission()({ threadId: 'session-1' })).toEqual({ allowed: true });
    arm(f, { deadlineAt: Date.now() + 10 });
    f.supervisor.close();
    vi.advanceTimersByTime(10);
    expect(f.interrupt).not.toHaveBeenCalled();
    expect(f.admissionRaw()).toBeUndefined();
  });

  test('explicit monitor resolution releases the matching observer', async () => {
    const root = makeTempDir('station-monitor-resolve-');
    // The scheduler's stop() below closes the ledger.
    const ledger = createSchedulerLedger({ directory: root });
    expect(
      ledger.create({
        name: 'watch',
        schedule: { kind: 'every', everyMs: 60_000 },
        prompt: 'observe',
        enabled: true,
        createdAt: '2026-01-01T00:00:00.000Z',
        monitor: {
          kind: 'github-pull-request',
          objective: 'review-ready',
          target: 'https://github.com/kontourai/station/pull/4210',
          projectId: 'personal',
          agentId: 'station',
        },
      }),
    ).toEqual({ kind: 'created' });
    const views = ledger.listViews();
    if (views.kind !== 'available') throw new Error('expected scheduler view');
    const monitorId = views.value[0]!.unattendedPrincipal!.jobId;
    const reserved = ledger.reserveMonitorTrigger({
      monitorId,
      ownerId: 'personal',
      fingerprint: 'revision-1',
      budget: { maxTurns: 1, maxTokens: 100 },
    });
    if (reserved.kind !== 'dispatch') throw new Error('expected dispatch');
    const task = { taskId: 'task-1', sessionId: 'session-1', turnId: 'turn-1' };
    ledger.attachMonitorTask({ triggerId: reserved.triggerId, task });
    const attached = ledger.monitorTrigger(reserved.triggerId);
    if (attached.kind !== 'available' || !attached.value)
      throw new Error('expected an attached trigger');

    // The observer the runtime arms for this trigger reaches its turn fence.
    const f = fixture();
    f.supervisor.adopt(attached.value, new AbortController().signal, () => {});
    f.publish(event('session-1', 'turn.started', 'turn-1'));
    f.publish(
      event('session-1', 'token-usage.updated', 'turn-1', { totalTokens: 2 }),
    );
    f.publish(event('session-1', 'turn.completed', 'turn-1'));
    expect(f.admission()({ threadId: 'session-1' })).toMatchObject({
      allowed: false,
    });
    ledger.settleMonitorTrigger({
      triggerId: reserved.triggerId,
      terminal: 'indeterminate',
    });

    // Wired as runtime-route-support wires the two.
    const scheduler = new BuiltinScheduler({
      ledger,
      turnAdapter: { invoke: vi.fn() },
      readMonitorTerminals: async (triggers) =>
        triggers.map((trigger) => ({
          triggerId: trigger.triggerId,
          terminal: 'completed' as const,
          usage: f.supervisor.receipt(trigger),
        })),
      onMonitorTerminal: (triggerId) => f.supervisor.release(triggerId),
    });

    await scheduler.resolveIndeterminateMonitor('watch', {
      triggerId: reserved.triggerId,
      action: 'resolve',
    });

    expect(f.admission()({ threadId: 'session-1' })).toEqual({ allowed: true });
    await scheduler.stop();
  });
});
