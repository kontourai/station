import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { TaskDispatcher } from '../../projects/task-dispatcher.js';
import type { StarterOwnerAdapter } from '../starter-owner-adapter.js';
import {
  type StarterLaunchReadiness,
  StarterRegistry,
  StarterWorkPrerequisiteError,
  StarterWorkTargetError,
} from '../starter-registry.js';
import { StarterWorkModule } from '../starter-work-module.js';

async function fixture(firstRun = 'completed') {
  const root = await mkdtemp(join(tmpdir(), 'starter-registry-'));
  const readTaskForOpen = vi.fn(async (id: string) =>
    id === 'task-1' ? ({ id, projectId: 'project-1' } as never) : null,
  );
  const createTaskIdempotent = vi.fn(
    async () =>
      ({ id: 'task-1', projectId: 'project-1', agentId: 'station' }) as never,
  );
  const dispatch = vi.fn<TaskDispatcher['dispatch']>(
    async () =>
      ({
        kind: 'dispatched',
        result: { session: { threadId: 'session-1' } },
      }) as never,
  );
  const check = vi.fn<StarterLaunchReadiness['check']>(async () => ({
    state: 'ready' as const,
  }));
  const checkScheduled = vi.fn<StarterLaunchReadiness['checkScheduled']>(
    async () => ({ state: 'ready' as const }),
  );
  const readTaskGraph = vi.fn(
    async () =>
      ({
        links: [
          {
            sourceType: 'task',
            sourceId: 'task-1',
            targetType: 'session',
            targetId: 'session-1',
            relationType: 'spawned_session',
          },
          {
            sourceType: 'task',
            sourceId: 'task-1',
            targetType: 'receipt',
            targetId: 'receipt-1',
            relationType: 'references_receipt',
          },
        ],
      }) as never,
  );
  const readSession = vi.fn(async (id: string) =>
    id === 'external-session'
      ? {
          threadId: id,
          controlMode: 'read-only-attached' as const,
        }
      : id === 'continued-session'
        ? { threadId: id, controlMode: 'station-owned' as const }
        : null,
  );
  const continueSession = vi.fn(async () => ({
    state: 'continued' as const,
    session: {
      threadId: 'continued-session',
      provider: 'claude',
      controlMode: 'station-owned' as const,
      status: 'ready' as const,
      createdAt: '2026-08-24T00:00:00.000Z',
      updatedAt: '2026-08-24T00:00:00.000Z',
    },
    receiptId: 'command-receipt-1',
  }));
  const ownerCandidate = vi.fn<StarterOwnerAdapter['candidate']>(async () => ({
    state: 'missing' as const,
  }));
  const ownerResolve = vi.fn<StarterOwnerAdapter['resolve']>(async () => ({
    state: 'missing' as const,
  }));
  const scheduledPrepare = vi.fn();
  return {
    readTaskForOpen,
    createTaskIdempotent,
    dispatch,
    check,
    readTaskGraph,
    readSession,
    continueSession,
    registry: new StarterRegistry(
      new StarterWorkModule(join(root, 'starter-work.json')),
      { readTaskForOpen, createTaskIdempotent, readTaskGraph } as never,
      { dispatch } as never,
      { check, checkScheduled },
      { read: readSession, continue: continueSession },
      () => ({ firstRun: { status: firstRun } }) as never,
      { candidate: ownerCandidate, resolve: ownerResolve },
      { prepare: scheduledPrepare },
    ),
    ownerCandidate,
    ownerResolve,
    checkScheduled,
    scheduledPrepare,
  };
}

describe('StarterRegistry', () => {
  it('projects the bounded Task and Session catalog and validates exact Task ownership', async () => {
    const { registry, readTaskForOpen } = await fixture();
    await expect(registry.list()).resolves.toMatchObject([
      {
        id: 'start-task',
        targetKind: 'task',
        prerequisite: 'first-run-completed',
        status: { state: 'unbound' },
      },
      {
        id: 'continue-session',
        targetKind: 'session',
        prerequisite: 'first-run-completed',
        status: { state: 'unbound' },
      },
      {
        id: 'inspect-approval',
        targetKind: 'approval',
        prerequisite: 'first-run-completed',
        status: { state: 'unbound' },
      },
      {
        id: 'inspect-receipt',
        targetKind: 'receipt',
        prerequisite: 'first-run-completed',
        status: { state: 'unbound' },
      },
      {
        id: 'run-scheduled-check',
        targetKind: 'receipt',
        prerequisite: 'first-run-completed',
        status: { state: 'unbound' },
      },
    ]);
    await expect(
      registry.bind({
        starterId: 'start-task',
        operationId: 'create:task-1',
        targetRef: { kind: 'task', id: 'task-1', projectId: 'project-1' },
      }),
    ).resolves.toMatchObject({ outcome: 'bound', replayed: false });
    expect(readTaskForOpen).toHaveBeenCalledWith('task-1');
    await expect(
      registry.bind({
        starterId: 'start-task',
        operationId: 'wrong-project',
        targetRef: { kind: 'task', id: 'task-1', projectId: 'other' },
      }),
    ).rejects.toBeInstanceOf(StarterWorkTargetError);
  });

  it('selects, binds, replays, and re-observes one exact approval owner', async () => {
    const { registry, ownerCandidate, ownerResolve } = await fixture();
    const targetRef = { kind: 'approval' as const, id: 'notification-1' };
    ownerCandidate.mockResolvedValue({
      state: 'current',
      reference: targetRef,
    });
    ownerResolve.mockResolvedValue({ state: 'current', completion: 'open' });
    await expect(registry.candidate('inspect-approval')).resolves.toEqual({
      state: 'current',
      starterId: 'inspect-approval',
      reference: targetRef,
    });
    const input = {
      starterId: 'inspect-approval' as const,
      operationId: 'inspect:notification-1',
      targetRef,
    };
    await expect(registry.launchInspection(input)).resolves.toMatchObject({
      state: 'opened',
      href: '/notifications?approval=notification-1',
      completion: { state: 'open' },
      correlation: { state: 'bound', replayed: false },
      evidence: { state: 'NOT_VERIFIED' },
    });
    await expect(registry.launchInspection(input)).resolves.toMatchObject({
      correlation: { state: 'bound', replayed: true },
    });
    ownerResolve.mockResolvedValue({
      state: 'current',
      completion: 'resolved',
    });
    await expect(registry.observe('inspect-approval')).resolves.toMatchObject({
      targetRef,
      href: '/notifications?approval=notification-1',
      completion: { state: 'resolved' },
      evidence: { state: 'NOT_VERIFIED' },
    });
  });

  it('refuses an inspection kind mismatch before writing correlation', async () => {
    const { registry, ownerResolve } = await fixture();
    await expect(
      registry.launchInspection({
        starterId: 'inspect-receipt',
        operationId: 'wrong-kind',
        targetRef: { kind: 'approval', id: 'notification-1' },
      }),
    ).rejects.toBeInstanceOf(StarterWorkTargetError);
    expect(ownerResolve).not.toHaveBeenCalled();
    await expect(registry.status('inspect-receipt')).resolves.toEqual({
      state: 'unbound',
    });
  });

  it('binds the exact Scheduler receipt before activating and re-observes owner completion', async () => {
    const { registry, ownerResolve, scheduledPrepare } = await fixture();
    const reference = {
      kind: 'receipt' as const,
      owner: 'scheduler-run' as const,
      id: 'schedule:built-in:station-starter-check:run-1',
    };
    ownerResolve.mockResolvedValue({
      state: 'current',
      completion: 'running',
    });
    const activate = vi.fn(async () => {
      await expect(
        registry.status('run-scheduled-check'),
      ).resolves.toMatchObject({
        state: 'bound',
        binding: { targetRef: reference },
      });
      return {
        outcome: 'completed' as const,
        message: 'completed',
        runId: reference.id,
      };
    });
    scheduledPrepare.mockReturnValue({
      replayed: false,
      completion: 'running',
      reference,
      receipt: {
        outcome: 'indeterminate',
        message: 'prepared',
        runId: reference.id,
      },
      activate,
      releaseUnstarted: vi.fn(() => ({ kind: 'applied' as const })),
    });
    await expect(
      registry.launchScheduledCheck({
        starterId: 'run-scheduled-check',
        operationId: 'scheduled-check-v1',
      }),
    ).resolves.toMatchObject({
      state: 'started',
      receipt: reference,
      href: `/schedule?run=${encodeURIComponent(reference.id)}`,
      completion: { state: 'completed' },
      correlation: { state: 'bound', replayed: false },
      replayed: false,
      evidence: { state: 'NOT_VERIFIED' },
    });
    expect(activate).toHaveBeenCalledTimes(1);
    scheduledPrepare.mockReturnValue({
      replayed: true,
      completion: 'completed',
      reference,
      receipt: {
        outcome: 'completed',
        message: 'completed',
        runId: reference.id,
      },
    });
    await expect(
      registry.launchScheduledCheck({
        starterId: 'run-scheduled-check',
        operationId: 'scheduled-check-v1',
      }),
    ).resolves.toMatchObject({
      state: 'started',
      receipt: reference,
      replayed: true,
      correlation: { state: 'bound', replayed: true },
      completion: { state: 'completed' },
    });
    expect(activate).toHaveBeenCalledTimes(1);
    ownerResolve.mockResolvedValue({
      state: 'current',
      completion: 'completed',
    });
    await expect(
      registry.observe('run-scheduled-check'),
    ).resolves.toMatchObject({
      receipt: reference,
      completion: { state: 'completed' },
      evidence: { state: 'NOT_VERIFIED' },
    });
  });

  it('releases an unstarted Scheduler intent when a different binding already won', async () => {
    const { registry, ownerResolve, scheduledPrepare } = await fixture();
    ownerResolve.mockResolvedValue({
      state: 'current',
      completion: 'running',
    });
    await registry.bind({
      starterId: 'run-scheduled-check',
      operationId: 'winner',
      targetRef: {
        kind: 'receipt',
        owner: 'scheduler-run',
        id: 'schedule:built-in:station-starter-check:winner-1',
      },
    });
    const releaseUnstarted = vi.fn(() => ({ kind: 'applied' as const }));
    scheduledPrepare.mockReturnValue({
      replayed: false,
      completion: 'running',
      reference: {
        kind: 'receipt',
        owner: 'scheduler-run',
        id: 'schedule:built-in:station-starter-check:loser-1',
      },
      receipt: {
        outcome: 'indeterminate',
        message: 'prepared',
        runId: 'schedule:built-in:station-starter-check:loser-1',
      },
      activate: vi.fn(),
      releaseUnstarted,
    });
    await expect(
      registry.launchScheduledCheck({
        starterId: 'run-scheduled-check',
        operationId: 'loser',
      }),
    ).rejects.toThrow('conflicts with an existing operation');
    expect(releaseUnstarted).toHaveBeenCalledTimes(1);
    expect(
      scheduledPrepare.mock.results[0]?.value.activate,
    ).not.toHaveBeenCalled();
  });

  it('does not admit starter binding before the durable first-run decision', async () => {
    const { registry } = await fixture('pending');
    await expect(
      registry.bind({
        starterId: 'start-task',
        operationId: 'create:task-1',
        targetRef: { kind: 'task', id: 'task-1', projectId: 'project-1' },
      }),
    ).rejects.toBeInstanceOf(StarterWorkPrerequisiteError);
  });

  it('creates no Scheduler intent while the Station Agent is deferred', async () => {
    const { registry, checkScheduled, scheduledPrepare } = await fixture();
    checkScheduled.mockResolvedValue({
      state: 'deferred',
      reason: 'Station Agent is starting.',
    });
    await expect(
      registry.launchScheduledCheck({
        starterId: 'run-scheduled-check',
        operationId: 'deferred-check',
      }),
    ).resolves.toEqual({
      state: 'deferred',
      starterId: 'run-scheduled-check',
      reason: 'Station Agent is starting.',
      retrySafe: true,
    });
    expect(scheduledPrepare).not.toHaveBeenCalled();
  });

  it.each([
    {
      code: 'busy',
      state: 'deferred',
      retrySafe: true,
      reason: 'already running',
    },
    {
      code: 'collision',
      state: 'conflict',
      retrySafe: false,
      reason: 'job name is already in use',
    },
    {
      code: 'capacity',
      state: 'unavailable',
      retrySafe: false,
      reason: 'capacity is full',
    },
    {
      code: 'corrupt',
      state: 'unavailable',
      retrySafe: false,
      reason: 'needs operator repair',
    },
    {
      code: 'invalid',
      state: 'unavailable',
      retrySafe: false,
      reason: 'identity is invalid',
    },
    {
      code: 'unavailable',
      state: 'unavailable',
      retrySafe: true,
      reason: 'could not prepare',
    },
  ] as const)(
    'preserves the Scheduler $code preparation outcome',
    async ({ code, state, retrySafe, reason }) => {
      const { registry, scheduledPrepare } = await fixture();
      scheduledPrepare.mockImplementation(() => {
        throw Object.assign(new Error(`owner ${code}`), {
          name: 'StarterScheduledCheckPrepareError',
          code,
          retrySafe,
        });
      });
      await expect(
        registry.launchScheduledCheck({
          starterId: 'run-scheduled-check',
          operationId: `prepare-${code}`,
        }),
      ).resolves.toEqual({
        state,
        starterId: 'run-scheduled-check',
        reason: expect.stringContaining(reason),
        retrySafe,
      });
    },
  );

  it('creates, binds, and dispatches exactly once with the exact Session identity', async () => {
    const { registry, createTaskIdempotent, dispatch } = await fixture();
    await expect(
      registry.launchStartTask({
        starterId: 'start-task',
        operationId: 'launch-1',
        task: { projectId: 'project-1', title: 'First task' },
      }),
    ).resolves.toMatchObject({
      task: { kind: 'task', id: 'task-1', projectId: 'project-1' },
      correlation: { state: 'bound' },
      dispatch: {
        state: 'dispatched',
        session: { kind: 'session', id: 'session-1' },
      },
      evidence: { state: 'NOT_VERIFIED' },
    });
    expect(createTaskIdempotent).toHaveBeenCalledTimes(1);
    expect(dispatch).toHaveBeenCalledTimes(1);
  });

  it('preserves indeterminate dispatch without an automatic retry', async () => {
    const { registry, dispatch } = await fixture();
    dispatch.mockResolvedValueOnce({
      kind: 'indeterminate',
      reason: 'response lost',
    });
    await expect(
      registry.launchStartTask({
        starterId: 'start-task',
        operationId: 'launch-2',
        task: { projectId: 'project-1', title: 'First task' },
      }),
    ).resolves.toMatchObject({
      dispatch: {
        state: 'indeterminate',
        reason: 'response lost',
        retrySafe: false,
      },
      evidence: { state: 'NOT_VERIFIED' },
    });
    expect(dispatch).toHaveBeenCalledTimes(1);
  });

  it('replays one durable launch outcome without dispatching the Task again', async () => {
    const { registry, dispatch } = await fixture();
    const input = {
      starterId: 'start-task' as const,
      operationId: 'launch-replay',
      task: { projectId: 'project-1', title: 'First task' },
    };
    await registry.launchStartTask(input);
    await expect(registry.launchStartTask(input)).resolves.toMatchObject({
      dispatch: { state: 'dispatched', session: { id: 'session-1' } },
    });
    expect(dispatch).toHaveBeenCalledTimes(1);
  });

  it('does not create a Task while the explicit Agent readiness adapter is deferred', async () => {
    const { registry, createTaskIdempotent, check } = await fixture();
    check.mockResolvedValueOnce({
      state: 'deferred',
      reason: 'Agent engine is starting.',
    });
    await expect(
      registry.launchStartTask({
        starterId: 'start-task',
        operationId: 'launch-deferred',
        task: {
          projectId: 'project-1',
          title: 'First task',
          agentId: 'station',
        },
      }),
    ).resolves.toEqual({
      state: 'deferred',
      reason: 'Agent engine is starting.',
      retrySafe: true,
    });
    expect(createTaskIdempotent).not.toHaveBeenCalled();
  });

  it('observes only exact Task graph session and receipt owners and never Task status as evidence', async () => {
    const { registry } = await fixture();
    await registry.bind({
      starterId: 'start-task',
      operationId: 'bind-observe',
      targetRef: { kind: 'task', id: 'task-1', projectId: 'project-1' },
    });
    await expect(registry.observe('start-task')).resolves.toMatchObject({
      session: { kind: 'session', id: 'session-1' },
      receipt: { kind: 'receipt', id: 'receipt-1' },
      evidence: { state: 'NOT_VERIFIED' },
    });
  });

  it('continues one exact attached Session through the owner idempotency seam', async () => {
    const { registry, continueSession, readSession } = await fixture();
    const input = {
      starterId: 'continue-session' as const,
      operationId: 'continue-op-1',
      sourceSessionId: 'external-session',
    };
    await expect(registry.launchContinueSession(input)).resolves.toMatchObject({
      state: 'continued',
      source: { kind: 'session', id: 'external-session' },
      session: { threadId: 'continued-session', controlMode: 'station-owned' },
      correlation: {
        state: 'bound',
        binding: {
          targetRef: { kind: 'session', id: 'continued-session' },
        },
      },
      receipt: { kind: 'receipt', id: 'command-receipt-1' },
      evidence: { state: 'NOT_VERIFIED' },
    });
    expect(continueSession).toHaveBeenCalledWith({
      sourceSessionId: 'external-session',
      operationId: 'continue-op-1',
    });
    await expect(registry.observe('continue-session')).resolves.toMatchObject({
      starterId: 'continue-session',
      session: { kind: 'session', id: 'continued-session' },
      correlation: { state: 'bound' },
      evidence: { state: 'NOT_VERIFIED' },
    });
    readSession.mockResolvedValueOnce({
      threadId: 'continued-session',
      controlMode: 'read-only-attached',
    });
    await expect(registry.observe('continue-session')).resolves.toMatchObject({
      correlation: { state: 'not_verified' },
      evidence: { state: 'NOT_VERIFIED' },
    });
  });

  it('does not continue a missing or Station-owned source Session', async () => {
    const { registry, continueSession } = await fixture();
    await expect(
      registry.launchContinueSession({
        starterId: 'continue-session',
        operationId: 'continue-op-2',
        sourceSessionId: 'continued-session',
      }),
    ).resolves.toMatchObject({ state: 'unavailable', retrySafe: false });
    expect(continueSession).not.toHaveBeenCalled();
  });

  it('keeps ordinary Session binding behind the Station-owned owner check', async () => {
    const { registry } = await fixture();
    await expect(
      registry.bind({
        starterId: 'continue-session',
        operationId: 'bind-owned-session',
        targetRef: { kind: 'session', id: 'continued-session' },
      }),
    ).resolves.toMatchObject({ outcome: 'bound' });
    const other = await fixture();
    await expect(
      other.registry.bind({
        starterId: 'continue-session',
        operationId: 'bind-read-only-session',
        targetRef: { kind: 'session', id: 'external-session' },
      }),
    ).rejects.toBeInstanceOf(StarterWorkTargetError);
  });
});
