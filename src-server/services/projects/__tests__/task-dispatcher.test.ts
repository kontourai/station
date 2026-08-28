import { describe, expect, test, vi } from 'vitest';
import {
  createTaskDispatcher,
  type TaskDispatchGraphState,
  type TaskDispatchReservation,
} from '../task-dispatcher.js';

const reservation: TaskDispatchReservation = {
  task: { id: 'task-1' } as TaskDispatchReservation['task'],
  sessionId: 'task-task-1-1',
  provider: 'claude',
  sourceSurface: 'api',
  modelId: undefined,
};

// Every graph seam member returns a Promise since archive#2646 (the durable
// transitions await their cross-process lock), so the fakes are async too.
function graph(
  reserve: TaskDispatchGraphState['reserve'] = async () => ({
    kind: 'reserved',
    reservation,
  }),
): TaskDispatchGraphState {
  return {
    reserve,
    markProviderStarting: vi.fn(async () => {}),
    associate: vi.fn(
      async () => ({ task: {}, dispatch: {}, session: {}, links: [] }) as never,
    ),
    markIndeterminate: vi.fn(async () => {}),
    releaseReservation: vi.fn(async () => ({ kind: 'released' as const })),
  };
}

const telemetry = { succeeded: vi.fn(), failed: vi.fn() };

describe('TaskDispatcher Interface', () => {
  test('rejects a monitor whose declared Task Agent differs before reservation', async () => {
    const state = graph();
    const dispatcher = createTaskDispatcher(
      state,
      { claim: vi.fn(), compensate: vi.fn() },
      {
        readiness: () => ({ kind: 'ready' as const }),
        mayHaveStarted: () => false,
        startOrSeed: vi.fn(),
      },
      telemetry,
    );
    await expect(
      dispatcher.dispatch('task-1', {
        agentId: 'configured-agent',
        monitor: {
          agentId: 'other-agent',
          signal: new AbortController().signal,
          deadlineAt: Date.now() + 60_000,
          maxCompletedTurns: 1,
          maxTokens: 1,
        },
      }),
    ).resolves.toMatchObject({ kind: 'failed' });
  });

  test('publishes the exact durable association after graph commit without changing dispatch success', async () => {
    const state = graph();
    const publisher = {
      publishAgentStarted: vi.fn(async () => {
        throw new Error('room unavailable');
      }),
    };
    const dispatcher = createTaskDispatcher(
      state,
      {
        claim: vi.fn(async () => undefined),
        compensate: vi.fn(async () => ({ kind: 'released' as const })),
      },
      {
        readiness: () => ({ kind: 'ready' as const }),
        mayHaveStarted: () => false,
        startOrSeed: vi.fn(async () => ({
          session: {
            provider: 'claude',
            threadId: 'session-1',
            status: 'running' as const,
            createdAt: '2026-08-20T00:00:00.000Z',
            updatedAt: '2026-08-20T00:00:00.000Z',
          },
          outcome: 'started' as const,
        })),
      },
      telemetry,
      publisher,
    );
    await expect(dispatcher.dispatch('task-1', {})).resolves.toMatchObject({
      kind: 'dispatched',
    });
    expect(publisher.publishAgentStarted).toHaveBeenCalledWith(
      await (state.associate as any).mock.results[0].value,
    );
  });
  test('returns admission not-found, contention, and terminal outcomes without side effects', async () => {
    for (const kind of ['not-found', 'contended', 'terminal'] as const) {
      const state = graph(async () => ({ kind, reason: kind }));
      const dispatcher = createTaskDispatcher(
        state,
        {
          claim: vi.fn(),
          compensate: vi.fn().mockResolvedValue({ kind: 'released' as const }),
        },
        {
          readiness: () => ({ kind: 'ready' as const }),
          mayHaveStarted: () => false,
          startOrSeed: vi.fn(),
        },
        telemetry,
      );
      await expect(dispatcher.dispatch('task-1', {})).resolves.toEqual({
        kind,
        reason: kind,
      });
      expect(state.markProviderStarting).not.toHaveBeenCalled();
    }
  });

  test('reports unavailable before claim and releases the reservation for retry', async () => {
    const state = graph();
    const claims = {
      claim: vi.fn(),
      compensate: vi.fn().mockResolvedValue({ kind: 'released' as const }),
    };
    const remote = {
      readiness: () => ({
        kind: 'unavailable' as const,
        reason: 'not ready',
        retryable: true,
      }),
      mayHaveStarted: () => false,
      startOrSeed: vi.fn(),
    };
    const dispatcher = createTaskDispatcher(state, claims, remote, telemetry);

    await expect(dispatcher.dispatch('task-1', {})).resolves.toEqual({
      kind: 'unavailable',
      reason: 'not ready',
      retryable: true,
    });
    expect(claims.claim).not.toHaveBeenCalled();
    expect(remote.startOrSeed).not.toHaveBeenCalled();
    expect(state.releaseReservation).toHaveBeenCalledWith(reservation);
  });

  test('reports indeterminate when restoring a reservation cannot be proven', async () => {
    const state = graph();
    state.releaseReservation = vi.fn(async () => ({
      kind: 'indeterminate' as const,
      reason: 'reservation write failed',
    }));
    const dispatcher = createTaskDispatcher(
      state,
      {
        claim: vi.fn(),
        compensate: vi.fn().mockResolvedValue({ kind: 'released' as const }),
      },
      {
        readiness: () => ({
          kind: 'unavailable' as const,
          reason: 'not ready',
          retryable: true,
        }),
        mayHaveStarted: () => false,
        startOrSeed: vi.fn(),
      },
      telemetry,
    );

    await expect(dispatcher.dispatch('task-1', {})).resolves.toEqual({
      kind: 'indeterminate',
      reason: 'reservation write failed',
    });
  });

  test('returns an abort outcome before admission without graph side effects', async () => {
    const state = graph();
    const dispatcher = createTaskDispatcher(
      state,
      {
        claim: vi.fn(),
        compensate: vi.fn().mockResolvedValue({ kind: 'released' as const }),
      },
      {
        readiness: () => ({ kind: 'ready' as const }),
        mayHaveStarted: () => false,
        startOrSeed: vi.fn(),
      },
      telemetry,
    );

    await expect(
      dispatcher.dispatch('task-1', { signal: AbortSignal.abort() }),
    ).resolves.toEqual({
      kind: 'aborted',
      reason: 'Task dispatch aborted',
      retryable: true,
    });
    expect(state.markProviderStarting).not.toHaveBeenCalled();
  });

  test('keeps a concurrently aborted external claim indeterminate', async () => {
    const controller = new AbortController();
    const externalReservation = {
      ...reservation,
      task: {
        ...reservation.task,
        workItemRef: 'github:kontourai/station#2528',
      },
    } as TaskDispatchReservation;
    const state = graph(async () => ({
      kind: 'reserved',
      reservation: externalReservation,
    }));
    const claims = {
      claim: vi.fn(async () => {
        controller.abort(new Error('request closed'));
        return { outcome: 'claimed' as const, subjectId: 'github:x' };
      }),
      compensate: vi.fn().mockResolvedValue({ kind: 'released' as const }),
    };
    const remote = {
      readiness: () => ({ kind: 'ready' as const }),
      mayHaveStarted: () => false,
      startOrSeed: vi.fn(),
    };
    const dispatcher = createTaskDispatcher(state, claims, remote, telemetry);

    await expect(
      dispatcher.dispatch('task-1', { signal: controller.signal }),
    ).resolves.toMatchObject({
      kind: 'indeterminate',
      reason: 'Task dispatch aborted: request closed',
    });
    expect(claims.compensate).not.toHaveBeenCalled();
    expect(state.releaseReservation).not.toHaveBeenCalled();
    expect(state.markIndeterminate).toHaveBeenCalledWith(externalReservation);
    expect(remote.startOrSeed).not.toHaveBeenCalled();
  });

  test('makes a timeout after a provider start request indeterminate', async () => {
    const state = graph();
    const dispatcher = createTaskDispatcher(
      state,
      {
        claim: vi.fn().mockResolvedValue(undefined),
        compensate: vi.fn().mockResolvedValue({ kind: 'released' as const }),
      },
      {
        readiness: () => ({ kind: 'ready' as const }),
        mayHaveStarted: () => true,
        startOrSeed: vi.fn(
          () =>
            new Promise<{ session: never; outcome: 'started' }>(
              () => undefined,
            ),
        ),
      },
      telemetry,
    );

    await expect(
      dispatcher.dispatch('task-1', { timeoutMs: 1 }),
    ).resolves.toMatchObject({
      kind: 'indeterminate',
      reason: 'Task dispatch timed out',
    });
    expect(state.markIndeterminate).toHaveBeenCalledWith(reservation);
  });

  test('totalizes a hung external claim at its timeout and treats late success as ownership-unknown', async () => {
    let settleClaim!: (value: {
      outcome: 'claimed';
      subjectId: string;
    }) => void;
    const pendingClaim = new Promise<{
      outcome: 'claimed';
      subjectId: string;
    }>((resolve) => {
      settleClaim = resolve;
    });
    const externalReservation = {
      ...reservation,
      task: {
        ...reservation.task,
        workItemRef: 'github:kontourai/station#2528',
      },
    } as TaskDispatchReservation;
    const state = graph(async () => ({
      kind: 'reserved',
      reservation: externalReservation,
    }));
    const claims = {
      claim: vi.fn(() => pendingClaim),
      compensate: vi.fn().mockResolvedValue({ kind: 'released' as const }),
    };
    const dispatcher = createTaskDispatcher(
      state,
      claims,
      {
        readiness: () => ({ kind: 'ready' as const }),
        mayHaveStarted: () => false,
        startOrSeed: vi.fn(),
      },
      telemetry,
    );

    await expect(
      dispatcher.dispatch('task-1', { timeoutMs: 1 }),
    ).resolves.toMatchObject({
      kind: 'indeterminate',
      reason: 'Task dispatch timed out',
    });
    expect(claims.claim).toHaveBeenCalledWith(
      externalReservation,
      expect.any(AbortSignal),
    );
    expect(state.markIndeterminate).toHaveBeenCalledWith(externalReservation);

    settleClaim({
      outcome: 'claimed',
      subjectId: 'github:kontourai/station#2528',
    });
    await Promise.resolve();
    expect(claims.compensate).not.toHaveBeenCalled();
    expect(state.releaseReservation).not.toHaveBeenCalled();
  });

  test('totalizes an aborted in-flight external claim as indeterminate', async () => {
    const controller = new AbortController();
    let settleClaim!: (value: undefined) => void;
    const pendingClaim = new Promise<undefined>((resolve) => {
      settleClaim = resolve;
    });
    const externalReservation = {
      ...reservation,
      task: {
        ...reservation.task,
        workItemRef: 'github:kontourai/station#2528',
      },
    } as TaskDispatchReservation;
    const state = graph(async () => ({
      kind: 'reserved',
      reservation: externalReservation,
    }));
    const claims = {
      claim: vi.fn(() => pendingClaim),
      compensate: vi.fn().mockResolvedValue({ kind: 'released' as const }),
    };
    const dispatcher = createTaskDispatcher(
      state,
      claims,
      {
        readiness: () => ({ kind: 'ready' as const }),
        mayHaveStarted: () => false,
        startOrSeed: vi.fn(),
      },
      telemetry,
    );
    const dispatch = dispatcher.dispatch('task-1', {
      signal: controller.signal,
    });
    await vi.waitFor(() => expect(claims.claim).toHaveBeenCalledOnce());
    controller.abort(new Error('request closed'));

    await expect(dispatch).resolves.toMatchObject({
      kind: 'indeterminate',
      reason: 'Task dispatch aborted: request closed',
    });
    settleClaim(undefined);
    await Promise.resolve();
    expect(state.markIndeterminate).toHaveBeenCalledWith(externalReservation);
    expect(state.releaseReservation).not.toHaveBeenCalled();
  });

  test('maps a failed compensation to an honest indeterminate total outcome', async () => {
    const state = graph();
    const dispatcher = createTaskDispatcher(
      state,
      {
        claim: vi
          .fn()
          .mockResolvedValue({ outcome: 'claimed', subjectId: 'github:x' }),
        compensate: vi.fn().mockResolvedValue({
          kind: 'indeterminate' as const,
          reason: 'release failed',
        }),
      },
      {
        readiness: () => ({ kind: 'ready' as const }),
        mayHaveStarted: () => false,
        startOrSeed: vi.fn().mockRejectedValue(new Error('seed failed')),
      },
      telemetry,
    );

    await expect(dispatcher.dispatch('task-1', {})).resolves.toEqual({
      kind: 'indeterminate',
      reason: 'release failed',
    });
    expect(state.markIndeterminate).toHaveBeenCalledWith(reservation);
  });

  test('maps a blocked claim to contention, releases, and observes blocked telemetry', async () => {
    const state = graph();
    const observer = { succeeded: vi.fn(), failed: vi.fn() };
    const dispatcher = createTaskDispatcher(
      state,
      {
        claim: vi.fn().mockResolvedValue({
          outcome: 'blocked',
          kind: 'conflict',
          reason: 'held',
        }),
        compensate: vi.fn().mockResolvedValue({ kind: 'released' as const }),
      },
      {
        readiness: () => ({ kind: 'ready' as const }),
        mayHaveStarted: () => false,
        startOrSeed: vi.fn(),
      },
      observer,
    );

    await expect(dispatcher.dispatch('task-1', {})).resolves.toMatchObject({
      kind: 'contended',
      reason: 'Task is claimed by another actor: held',
    });
    expect(state.releaseReservation).toHaveBeenCalledWith(reservation);
    expect(observer.failed).toHaveBeenCalledWith(
      reservation,
      expect.any(Number),
      true,
    );
  });

  test('compensates and releases a definite remote-start failure so a retry can proceed', async () => {
    const state = graph();
    const claims = {
      claim: vi
        .fn()
        .mockResolvedValue({ outcome: 'claimed', subjectId: 'github:x' }),
      compensate: vi.fn().mockResolvedValue({ kind: 'released' as const }),
    };
    const remote = {
      readiness: () => ({ kind: 'ready' as const }),
      mayHaveStarted: () => false,
      startOrSeed: vi
        .fn()
        .mockRejectedValue(new Error('workspace/taskSlug failed')),
    };
    const dispatcher = createTaskDispatcher(state, claims, remote, telemetry);

    await expect(dispatcher.dispatch('task-1', {})).resolves.toMatchObject({
      kind: 'failed',
      reason: 'workspace/taskSlug failed',
    });
    expect(claims.compensate).toHaveBeenCalledOnce();
    expect(state.releaseReservation).toHaveBeenCalledOnce();
    remote.startOrSeed.mockResolvedValue({
      session: {} as never,
      outcome: 'started' as const,
    });
    await expect(dispatcher.dispatch('task-1', {})).resolves.toMatchObject({
      kind: 'dispatched',
    });
  });

  test('marks possible remote or association failures indeterminate without compensation', async () => {
    for (const [associationFails, startOrSeed] of [
      [false, vi.fn().mockRejectedValue(new Error('remote start failed'))],
      [
        true,
        vi.fn().mockResolvedValue({
          session: {} as never,
          outcome: 'started' as const,
        }),
      ],
    ] as const) {
      const state = graph();
      if (associationFails) {
        // association is attempted only after a successful remote result.
        state.associate = vi.fn().mockImplementation(() => {
          throw new Error('Task dispatch reservation was superseded');
        });
      }
      const claims = {
        claim: vi
          .fn()
          .mockResolvedValue({ outcome: 'claimed', subjectId: 'github:x' }),
        compensate: vi.fn().mockResolvedValue({ kind: 'released' as const }),
      };
      const dispatcher = createTaskDispatcher(
        state,
        claims,
        {
          readiness: () => ({ kind: 'ready' as const }),
          mayHaveStarted: () => true,
          startOrSeed,
        },
        telemetry,
      );
      await expect(dispatcher.dispatch('task-1', {})).resolves.toMatchObject({
        kind: 'indeterminate',
      });
      expect(state.markIndeterminate).toHaveBeenCalledWith(reservation);
      expect(state.releaseReservation).not.toHaveBeenCalled();
      expect(claims.compensate).not.toHaveBeenCalled();
    }
  });

  test('isolates observer exceptions after a successful association', async () => {
    const state = graph();
    const dispatcher = createTaskDispatcher(
      state,
      {
        claim: vi.fn().mockResolvedValue(undefined),
        compensate: vi.fn().mockResolvedValue({ kind: 'released' as const }),
      },
      {
        readiness: () => ({ kind: 'ready' as const }),
        mayHaveStarted: () => false,
        startOrSeed: vi.fn().mockResolvedValue({
          session: {} as never,
          outcome: 'seeded' as const,
        }),
      },
      {
        succeeded: () => {
          throw new Error('metrics unavailable');
        },
        failed: vi.fn(),
      },
    );
    await expect(dispatcher.dispatch('task-1', {})).resolves.toMatchObject({
      kind: 'dispatched',
    });
  });
});
