import { describe, expect, it, vi } from 'vitest';
import { OrchestrationReviewExecutor } from '../orchestration-review-executor.js';
import type { ReviewExecutionInput } from '../review-evidence-module.js';

function input(signal = new AbortController().signal): ReviewExecutionInput {
  return {
    requestId: 'request-1',
    reviewer: {
      reviewerId: 'reviewer-1',
      executorAgentSlug: 'reviewer-agent',
      actor: { actorId: 'sol' },
      lens: { id: 'failure-totality', instructions: 'Review total outcomes.' },
    },
    workspace: {
      root: '/review/snapshot',
      target: {
        kind: 'git-range',
        projectSlug: 'station',
        baseRevision: 'base',
        headRevision: 'head',
        repositoryId: 'github.com/kontourai/station',
        baseSha: '1'.repeat(40),
        headSha: '2'.repeat(40),
        diffSha256: '3'.repeat(64),
      },
      validateLocation: async () => {},
      close: async () => {},
    },
    prompt: 'review prompt',
    signal,
    context: {
      requestedBy: { actorId: 'user:operator' },
      userId: 'operator',
    },
  };
}

function runtime(options?: { stopFails?: boolean }) {
  const dispatchWithReceipt = vi.fn(
    async (command: any, _context?: unknown, _internal?: unknown) => {
      if (command.type === 'startSession') {
        return {
          receipt: {},
          result: {
            provider: 'codex',
            threadId: command.input.threadId,
            status: 'ready',
            createdAt: '2026-01-01T00:00:00.000Z',
            updatedAt: '2026-01-01T00:00:00.000Z',
          },
        };
      }
      return {
        receipt: {},
        result: { threadId: command.input.threadId, turnId: 'turn-1' },
      };
    },
  );
  const dispatch = vi.fn(async () => {
    if (options?.stopFails) throw new Error('stop unavailable');
  });
  const readSessionEventPage = vi.fn(async (threadId: string) => ({
    session: { threadId },
    events: [
      {
        sequence: 1,
        event: {
          eventId: 'event-1',
          provider: 'codex',
          threadId,
          turnId: 'turn-1',
          createdAt: '2026-01-01T00:00:00.000Z',
          method: 'turn.completed',
          outputText: JSON.stringify({ findings: [], deltaAssessments: [] }),
        },
      },
    ],
    hasMore: false,
    nextSequence: 1,
  }));
  return { dispatchWithReceipt, dispatch, readSessionEventPage };
}

describe('OrchestrationReviewExecutor', () => {
  it('enforces native read-only isolation on both provider boundaries', async () => {
    const orchestration = runtime();
    const executor = new OrchestrationReviewExecutor({
      orchestration: orchestration as never,
      supportsReadOnlyReview: () => true,
      pollMs: 1,
    });

    await expect(executor.execute(input())).resolves.toEqual({
      kind: 'completed',
      output: { findings: [], deltaAssessments: [] },
      workspaceRelease: 'safe',
    });
    expect(orchestration.dispatchWithReceipt).toHaveBeenCalledTimes(2);
    const start = orchestration.dispatchWithReceipt.mock.calls[0][0];
    const turn = orchestration.dispatchWithReceipt.mock.calls[1][0];
    expect(start).toMatchObject({
      type: 'startSession',
      input: {
        provider: 'codex',
        cwd: '/review/snapshot',
        persistSession: false,
      },
    });
    expect(turn).toMatchObject({
      type: 'sendTurn',
      input: {
        clientTurnId: 'review:request-1:reviewer-1',
      },
    });
    const isolation = {
      reviewIsolation: {
        workspaceAccess: 'read-only',
        requestId: 'request-1',
        reviewerId: 'reviewer-1',
      },
    };
    expect(orchestration.dispatchWithReceipt.mock.calls[0][2]).toEqual(
      isolation,
    );
    expect(orchestration.dispatchWithReceipt.mock.calls[1][2]).toEqual(
      isolation,
    );
    expect(orchestration.dispatch).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'stopSession' }),
      { userId: 'operator' },
    );
  });

  it('refuses unsupported engines and pre-aborted work before provider invocation', async () => {
    const unsupported = runtime();
    const executor = new OrchestrationReviewExecutor({
      orchestration: unsupported as never,
      supportsReadOnlyReview: () => false,
    });
    await expect(executor.execute(input())).resolves.toMatchObject({
      kind: 'failed',
      workspaceRelease: 'safe',
    });
    expect(unsupported.dispatchWithReceipt).not.toHaveBeenCalled();

    const abortedRuntime = runtime();
    const controller = new AbortController();
    controller.abort();
    const aborted = new OrchestrationReviewExecutor({
      orchestration: abortedRuntime as never,
      supportsReadOnlyReview: () => true,
    });
    await expect(
      aborted.execute(input(controller.signal)),
    ).resolves.toMatchObject({
      kind: 'timed-out',
      workspaceRelease: 'safe',
    });
    expect(abortedRuntime.dispatchWithReceipt).not.toHaveBeenCalled();
  });

  it('retains the snapshot when provider shutdown cannot be confirmed', async () => {
    const orchestration = runtime({ stopFails: true });
    const executor = new OrchestrationReviewExecutor({
      orchestration: orchestration as never,
      supportsReadOnlyReview: () => true,
      pollMs: 1,
    });
    await expect(executor.execute(input())).resolves.toMatchObject({
      kind: 'completed',
      workspaceRelease: 'retain',
    });
  });
});
