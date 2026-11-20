import { describe, expect, it, vi } from 'vitest';
import { OrchestrationCommandDispatchError } from '../../orchestration/orchestration-service.js';
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
      // An unverified agent's review: the operator's to read, acting for no one.
      ownerAttribution: 'unattributed-agent' as const,
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
  it.each([
    {
      label: 'definitive refusal',
      status: 'rejected',
      persistence: 'persisted',
      release: 'safe',
    },
    {
      label: 'unpersisted refusal',
      status: 'rejected',
      persistence: 'unavailable',
      release: 'retain',
    },
    {
      label: 'failed start with refusal metadata',
      status: 'failed',
      persistence: 'persisted',
      release: 'retain',
    },
  ] as const)(
    'settles workspace ownership for $label',
    async ({ status, persistence, release }) => {
      const orchestration = runtime();
      orchestration.dispatchWithReceipt.mockImplementationOnce(
        async (command) => {
          throw new OrchestrationCommandDispatchError(
            'Start refused',
            {
              commandType: 'startSession',
              commandId: 'review-start',
              threadId: command.input.threadId,
              status,
              createdAt: '2026-01-01T00:00:00.000Z',
            },
            undefined,
            persistence,
            false,
            'model_not_advertised',
            {
              kind: 'model_unavailable',
              retryable: false,
              failurePhase: 'refused',
            },
          );
        },
      );
      const executor = new OrchestrationReviewExecutor({
        orchestration: orchestration as never,
        supportsReadOnlyReview: () => true,
      });
      await expect(executor.execute(input())).resolves.toMatchObject({
        kind: 'failed',
        workspaceRelease: release,
      });
      expect(orchestration.dispatch).not.toHaveBeenCalled();
      expect(orchestration.dispatchWithReceipt).toHaveBeenCalledOnce();
    },
  );

  it.each([
    {
      label: 'confirmed stop',
      session: 'exact',
      stop: 'confirmed',
      release: 'safe',
    },
    {
      label: 'failed stop',
      session: 'exact',
      stop: 'failed',
      release: 'retain',
    },
    { label: 'late stop', session: 'exact', stop: 'late', release: 'retain' },
    {
      label: 'unrelated session',
      session: 'other',
      stop: 'confirmed',
      release: 'retain',
    },
    {
      label: 'unknown session',
      session: 'absent',
      stop: 'confirmed',
      release: 'retain',
    },
  ] as const)(
    'reconciles a lost start receipt with $label',
    async ({ session, stop, release }) => {
      const orchestration = runtime({ stopFails: stop === 'failed' });
      let threadId: string;
      let finishStop: (() => void) | undefined;
      if (stop === 'late') {
        orchestration.dispatch.mockImplementation(
          () =>
            new Promise<void>((resolve) => {
              finishStop = resolve;
            }),
        );
      }
      orchestration.dispatchWithReceipt.mockImplementationOnce(
        async (command) => {
          threadId = command.input.threadId;
          throw new OrchestrationCommandDispatchError(
            'Accepted start receipt unavailable',
            {
              commandType: 'startSession',
              commandId: 'review-start',
              threadId,
              status: 'accepted',
              createdAt: '2026-01-01T00:00:00.000Z',
            },
            session === 'absent'
              ? undefined
              : {
                  threadId: session === 'exact' ? threadId : 'other-session',
                  provider: 'codex',
                  status: 'ready',
                  createdAt: '2026-01-01T00:00:00.000Z',
                  updatedAt: '2026-01-01T00:00:00.000Z',
                },
            'unavailable',
            false,
            'foreground_message_indeterminate',
          );
        },
      );
      const executor = new OrchestrationReviewExecutor({
        orchestration: orchestration as never,
        supportsReadOnlyReview: () => true,
        stopTimeoutMs: 5,
      });
      const outcome = await executor.execute(input());
      expect(outcome).toMatchObject({
        kind: 'failed',
        workspaceRelease: release,
      });
      if (session === 'exact') {
        expect(orchestration.dispatch).toHaveBeenCalledExactlyOnceWith(
          { type: 'stopSession', threadId: threadId! },
          { userId: 'operator', ownerAttribution: 'unattributed-agent' },
        );
      } else {
        expect(orchestration.dispatch).not.toHaveBeenCalled();
      }
      finishStop?.();
      expect(outcome.workspaceRelease).toBe(release);
      expect(orchestration.dispatchWithReceipt).toHaveBeenCalledOnce();
    },
  );

  it('retains the snapshot when Session start may have happened before its reply was lost', async () => {
    const orchestration = runtime();
    orchestration.dispatchWithReceipt.mockRejectedValueOnce(
      new Error('start response lost'),
    );
    const executor = new OrchestrationReviewExecutor({
      orchestration: orchestration as never,
      supportsReadOnlyReview: () => true,
    });
    await expect(executor.execute(input())).resolves.toMatchObject({
      kind: 'failed',
      workspaceRelease: 'retain',
    });
    expect(orchestration.dispatchWithReceipt).toHaveBeenCalledTimes(1);
  });
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
        // The requester owns the reviewer session, so its own turn below is
        // authorized against a recorded owner rather than an ownerless row.
        metadata: { userId: 'operator' },
      },
    });
    // The owner stamp's attribution rides the start context, where the
    // service's start choke point marks an unverified agent's session.
    expect(orchestration.dispatchWithReceipt.mock.calls[0][1]).toEqual({
      userId: 'operator',
      ownerAttribution: 'unattributed-agent',
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
      { userId: 'operator', ownerAttribution: 'unattributed-agent' },
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

describe('OrchestrationReviewExecutor with a reply stored out of line', () => {
  it('parses the exact reply behind the reference, never its preview', async () => {
    const reply = JSON.stringify({
      findings: [{ title: 'x'.repeat(40_000) }],
      deltaAssessments: [],
    });
    const ref = `sha256-${'d'.repeat(64)}`;
    const orchestration = runtime();
    orchestration.readSessionEventPage.mockImplementation(
      async (threadId: string) => ({
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
              spilledContent: { v: 1, count: 1, bytes: reply.length },
              outputText: {
                $stationContent: 1,
                ref,
                kind: 'string',
                bytes: reply.length,
                length: reply.length,
                preview: reply.slice(0, 100),
              },
            } as never,
          },
        ],
        hasMore: false,
        nextSequence: 1,
      }),
    );
    const readEventContent = vi.fn(() => ({
      kind: 'string' as const,
      body: reply,
      bytes: reply.length,
    }));
    const executor = new OrchestrationReviewExecutor({
      orchestration: { ...orchestration, readEventContent } as never,
      supportsReadOnlyReview: () => true,
      pollMs: 1,
    });
    await expect(executor.execute(input())).resolves.toEqual({
      kind: 'completed',
      output: JSON.parse(reply),
      workspaceRelease: 'safe',
    });
    expect(readEventContent).toHaveBeenCalledWith(
      expect.any(String),
      ref,
      expect.anything(),
    );
  });
});
