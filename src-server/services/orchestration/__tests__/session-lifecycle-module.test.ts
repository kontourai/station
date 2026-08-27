import type { OrchestrationSessionDetail } from '@kontourai/station-contracts/orchestration';
import { INTERNAL_SESSION_READ_SCOPE } from '@kontourai/station-contracts/tenancy';
import { describe, expect, test, vi } from 'vitest';
import { SessionExecutionCoordinator } from '../session-execution-coordinator.js';
import {
  createSessionLifecycleModule,
  type SessionLifecycleDependencies,
} from '../session-lifecycle-module.js';

function detail(
  state: 'running' | 'review_pending' | 'completed',
): OrchestrationSessionDetail {
  return {
    session: {
      provider: 'claude',
      threadId: 'thread-1',
      status: 'running',
      controlMode: 'station-owned',
      answerability: { answerable: true },
      lifecycleState: state,
      createdAt: '2026-08-16T00:00:00.000Z',
      updatedAt: '2026-08-16T00:00:00.000Z',
      isLoaded: true,
      isPersisted: true,
      eventCount: 0,
    },
    events: [],
  };
}

function fixture(overrides: Partial<SessionLifecycleDependencies> = {}) {
  let current = detail('running');
  const apply = vi.fn();
  const publish = vi.fn(() => {
    current = detail('completed');
  });
  const deps: SessionLifecycleDependencies = {
    coordinator: new SessionExecutionCoordinator(),
    initialize: vi.fn(),
    isReadOnlyAttached: vi.fn(() => false),
    attachedReadOnlyMessage: 'Attached sessions are read-only.',
    readSession: vi.fn(async () => current),
    prepareCompletion: vi.fn(async () => ({ apply })),
    publish,
    latestStateEventAt: vi.fn(() => undefined),
    observeTransition: vi.fn(),
    observeBoardAction: vi.fn(),
    observeStateDuration: vi.fn(),
    ...overrides,
  };
  return {
    deps,
    module: createSessionLifecycleModule(deps),
    apply,
    publish,
    setCurrent(next: OrchestrationSessionDetail) {
      current = next;
    },
  };
}

describe('SessionLifecycleModule', () => {
  test('owns completion validation, publication, and final projection', async () => {
    const target = fixture();
    await expect(
      target.module.transition({
        threadId: 'thread-1',
        authority: INTERNAL_SESSION_READ_SCOPE,
        to: 'completed',
      }),
    ).resolves.toMatchObject({ lifecycleState: 'completed' });

    expect(target.deps.prepareCompletion).toHaveBeenCalledOnce();
    expect(target.apply).toHaveBeenCalledOnce();
    expect(target.publish).toHaveBeenCalledWith(
      expect.objectContaining({
        method: 'session.state-changed',
        previousState: 'running',
        sessionState: 'completed',
      }),
    );
  });

  test('revalidates authoritative state after an awaited completion gate', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const apply = vi.fn();
    const target = fixture({
      prepareCompletion: vi.fn(async () => {
        await gate;
        return { apply };
      }),
    });

    const transition = target.module.transition({
      threadId: 'thread-1',
      authority: INTERNAL_SESSION_READ_SCOPE,
      to: 'completed',
    });
    await vi.waitFor(() =>
      expect(target.deps.prepareCompletion).toHaveBeenCalledOnce(),
    );
    target.setCurrent(detail('completed'));
    release();

    await expect(transition).rejects.toThrow(
      /changed while completion gates were evaluated/,
    );
    expect(apply).not.toHaveBeenCalled();
    expect(target.publish).not.toHaveBeenCalled();
  });

  test('rejects a legal but stale post-gate lifecycle snapshot', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const apply = vi.fn();
    const target = fixture({
      prepareCompletion: vi.fn(async () => {
        await gate;
        return { apply };
      }),
    });

    const transition = target.module.transition({
      threadId: 'thread-1',
      authority: INTERNAL_SESSION_READ_SCOPE,
      to: 'completed',
    });
    await vi.waitFor(() =>
      expect(target.deps.prepareCompletion).toHaveBeenCalledOnce(),
    );
    target.setCurrent(detail('review_pending'));
    release();

    await expect(transition).rejects.toThrow(
      /changed while completion gates were evaluated/,
    );
    expect(apply).not.toHaveBeenCalled();
    expect(target.publish).not.toHaveBeenCalled();
  });

  test('observer failures cannot overturn an authoritative transition', async () => {
    const target = fixture({
      observeTransition: vi.fn(() => {
        throw new Error('metrics unavailable');
      }),
      observeBoardAction: vi.fn(() => {
        throw new Error('metrics unavailable');
      }),
      observeStateDuration: vi.fn(() => {
        throw new Error('metrics unavailable');
      }),
    });

    await expect(
      target.module.transition({
        threadId: 'thread-1',
        authority: INTERNAL_SESSION_READ_SCOPE,
        to: 'completed',
      }),
    ).resolves.toMatchObject({ lifecycleState: 'completed' });
  });
});
