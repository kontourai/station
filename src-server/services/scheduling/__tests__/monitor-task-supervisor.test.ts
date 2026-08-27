import {
  type CanonicalRuntimeEvent,
  SERVER_EVENTS,
} from '@kontourai/station-contracts/runtime-events';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { EventBus } from '../../orchestration/event-bus.js';
import { BuiltinScheduler } from '../builtin-scheduler.js';
import { MonitorTaskTurnSupervisor } from '../monitor-task-supervisor.js';

const sessions = new Map<string, CanonicalRuntimeEvent[]>();
const cleanups: Array<() => void> = [];

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
    const onMonitorTerminal = vi.fn();
    const trigger = {
      triggerId: 'trigger-1',
      monitorId: 'monitor-1',
      task: { taskId: 'task-1', sessionId: 'session-1', turnId: 'turn-1' },
      startedAt: '2026-01-01T00:00:00.000Z',
      deadlineAt: '2026-01-01T00:01:00.000Z',
      limits: { maxTurns: 1, maxTokens: 10 },
    };
    const ledger = {
      listViews: () => ({
        kind: 'available',
        value: [
          {
            name: 'job',
            monitor: {},
            unattendedPrincipal: { jobId: 'monitor-1' },
            monitorState: {},
          },
        ],
      }),
      monitorTrigger: () => ({ kind: 'available', value: trigger }),
      resolveIndeterminateMonitor: () => ({ kind: 'applied' }),
      update: () => ({ kind: 'updated' }),
    };
    const fake = {
      ledger,
      options: {
        readMonitorTerminals: async () => [
          {
            triggerId: 'trigger-1',
            terminal: 'completed' as const,
            usage: { turns: 1, tokens: 2, runtimeMs: 3 },
          },
        ],
        onMonitorTerminal,
      },
      requireRead: (outcome: { value: unknown }) => outcome.value,
      broadcast: vi.fn(),
    };
    await (BuiltinScheduler.prototype.resolveIndeterminateMonitor as any).call(
      fake,
      'job',
      { triggerId: 'trigger-1', action: 'resolve' },
    );
    expect(onMonitorTerminal).toHaveBeenCalledWith('trigger-1');
  });
});
