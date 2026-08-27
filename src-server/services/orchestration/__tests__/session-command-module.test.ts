import type { OrchestrationCommandReceipt } from '@kontourai/station-contracts/orchestration';
import { describe, expect, test, vi } from 'vitest';
import { createSessionCommandModule } from '../session-command-module.js';

function moduleUnderTest(
  options: {
    claimStart?: () => boolean;
    releaseStart?: () => void;
    requireAdapter?: () => never;
    bind?: () => Promise<void>;
    existing?: () => object;
    attachStarted?: () => void;
    initialize?: () => void;
    recordDispatch?: () => void;
    persist?: (receipt: OrchestrationCommandReceipt) => void;
    read?: (commandId: string) => OrchestrationCommandReceipt | null;
    reportUnavailable?: () => void;
  } = {},
) {
  const initialize = vi.fn(options.initialize);
  const recordDispatch = vi.fn(options.recordDispatch);
  const persist = vi.fn(options.persist);
  const reportUnavailable = vi.fn(options.reportUnavailable);
  const start = vi.fn(async () => ({
    threadId: 'thread-1',
    provider: 'claude' as const,
    status: 'ready' as const,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  }));
  const bind = vi.fn(options.bind ?? (async () => undefined));
  const command = createSessionCommandModule({
    receiptLedger: {
      initialize,
      recordDispatch,
      persist,
      read: options.read,
      reportUnavailable,
    },
    sessionState: {
      boundTenant: () => undefined,
      recordTenantMismatch: vi.fn(),
      isQuarantined: () => false,
      isReadOnlyAttached: () => false,
      recordAttachedMutationRejection: vi.fn(),
      canRead: () => true,
      existing: options.existing ?? (() => ({})),
      claimStart: options.claimStart ?? (() => true),
      releaseStart: vi.fn(options.releaseStart),
      attachStarted: vi.fn(options.attachStarted),
    },
    launchPolicy: {
      assertStartAllowed: vi.fn(),
      validateReattach: vi.fn(),
      requireAdapter:
        options.requireAdapter ??
        (() => ({ provider: 'claude', metadata: {} }) as never),
      prepareStart: async (input) => input,
      start,
      recordStarted: vi.fn(),
      ensureStartedSessionCurrent: vi.fn(),
      logStarted: vi.fn(),
      recordGateBlocked: vi.fn(),
    },
    bindings: { bind },
    publicSession: (session) => session,
    isRejectedError: () => false,
    attachedSessionReadOnlyMessage: 'read only',
  });
  return {
    bind,
    command,
    initialize,
    persist,
    recordDispatch,
    reportUnavailable,
    start,
  };
}

describe('SessionCommandModule', () => {
  test('executes the closed start intent and returns its durable receipt', async () => {
    const { command, persist, start } = moduleUnderTest();

    const outcome = await command.execute(
      {
        type: 'start-session',
        input: { threadId: 'thread-1', provider: 'claude' },
      },
      {},
    );

    expect(outcome.status).toBe('accepted');
    if (outcome.status === 'accepted') {
      expect(outcome.receiptStatus).toBe('persisted');
    }
    expect(start).toHaveBeenCalledOnce();
    expect(persist).toHaveBeenCalledOnce();
  });

  test('returns an honest failed receipt when receipt initialization throws', async () => {
    const { command, persist, recordDispatch, reportUnavailable, start } =
      moduleUnderTest({
        initialize: () => {
          throw new Error('receipt initialization unavailable');
        },
      });

    await expect(
      command.execute(
        {
          type: 'start-session',
          input: { threadId: 'thread-1', provider: 'claude' },
        },
        {},
      ),
    ).resolves.toMatchObject({
      status: 'failed',
      receipt: { commandType: 'startSession', status: 'failed' },
      receiptStatus: 'persisted',
      message: 'receipt initialization unavailable',
    });
    expect(recordDispatch).not.toHaveBeenCalled();
    expect(start).not.toHaveBeenCalled();
    expect(persist).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'failed' }),
    );
    expect(reportUnavailable).toHaveBeenCalledWith(
      expect.objectContaining({ phase: 'initialize' }),
    );
  });

  test('returns an honest failed receipt when dispatch recording throws', async () => {
    const { command, persist, reportUnavailable, start } = moduleUnderTest({
      recordDispatch: () => {
        throw new Error('dispatch receipt unavailable');
      },
    });

    await expect(
      command.execute(
        {
          type: 'start-session',
          input: { threadId: 'thread-1', provider: 'claude' },
        },
        {},
      ),
    ).resolves.toMatchObject({
      status: 'failed',
      receipt: { commandType: 'startSession', status: 'failed' },
      receiptStatus: 'persisted',
      message: 'dispatch receipt unavailable',
    });
    expect(start).not.toHaveBeenCalled();
    expect(persist).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'failed' }),
    );
    expect(reportUnavailable).toHaveBeenCalledWith(
      expect.objectContaining({ phase: 'record-dispatch' }),
    );
  });

  test('reports accepted receipt persistence unavailable as indeterminate without overwriting session effects', async () => {
    const { command, persist, reportUnavailable, start } = moduleUnderTest({
      persist: () => {
        throw new Error('accepted receipt unavailable');
      },
    });

    await expect(
      command.execute(
        {
          type: 'start-session',
          input: { threadId: 'thread-1', provider: 'claude' },
        },
        {},
      ),
    ).resolves.toMatchObject({
      status: 'indeterminate',
      receipt: { commandType: 'startSession', status: 'accepted' },
      receiptStatus: 'unavailable',
      session: { threadId: 'thread-1' },
      message:
        'Session started, but the accepted command receipt is unavailable: accepted receipt unavailable',
    });
    expect(start).toHaveBeenCalledOnce();
    expect(persist).toHaveBeenCalledOnce();
    expect(reportUnavailable).toHaveBeenCalledWith(
      expect.objectContaining({ phase: 'persist-accepted' }),
    );
  });

  test('uses exact receipt readback when accepted persistence writes then throws', async () => {
    let durable: OrchestrationCommandReceipt | null = null;
    const { command, persist, reportUnavailable } = moduleUnderTest({
      persist: (receipt) => {
        durable = receipt;
        throw new Error('write returned after durable commit');
      },
      read: () => durable,
    });

    await expect(
      command.execute(
        {
          type: 'start-session',
          input: { threadId: 'thread-1', provider: 'claude' },
        },
        {},
      ),
    ).resolves.toMatchObject({
      status: 'accepted',
      receipt: { commandType: 'startSession', status: 'accepted' },
      receiptStatus: 'persisted',
      session: { threadId: 'thread-1' },
    });
    expect(persist).toHaveBeenCalledOnce();
    expect(reportUnavailable).toHaveBeenCalledWith(
      expect.objectContaining({ phase: 'persist-accepted' }),
    );
  });

  test('preserves the launch failure when terminal receipt persistence also throws', async () => {
    const { command, persist, reportUnavailable } = moduleUnderTest({
      requireAdapter: () => {
        throw new Error('unknown provider');
      },
      persist: () => {
        throw new Error('terminal receipt unavailable');
      },
    });

    await expect(
      command.execute(
        {
          type: 'start-session',
          input: { threadId: 'thread-1', provider: 'claude' },
        },
        {},
      ),
    ).resolves.toMatchObject({
      status: 'failed',
      receipt: { commandType: 'startSession', status: 'failed' },
      receiptStatus: 'unavailable',
      message: 'unknown provider',
    });
    expect(persist).toHaveBeenCalledOnce();
    expect(reportUnavailable).toHaveBeenCalledWith(
      expect.objectContaining({ phase: 'persist-terminal' }),
    );
  });

  test('recognizes an exact failed-receipt readback after a terminal write throws', async () => {
    let durable: OrchestrationCommandReceipt | null = null;
    const { command, persist, reportUnavailable } = moduleUnderTest({
      requireAdapter: () => {
        throw new Error('unknown provider');
      },
      persist: (receipt) => {
        durable = receipt;
        throw new Error('terminal write returned after durable commit');
      },
      read: () => durable,
    });

    await expect(
      command.execute(
        {
          type: 'start-session',
          input: { threadId: 'thread-1', provider: 'claude' },
        },
        {},
      ),
    ).resolves.toMatchObject({
      status: 'failed',
      receipt: { commandType: 'startSession', status: 'failed' },
      receiptStatus: 'persisted',
      message: 'unknown provider',
    });
    expect(persist).toHaveBeenCalledOnce();
    expect(reportUnavailable).toHaveBeenCalledWith(
      expect.objectContaining({ phase: 'persist-terminal' }),
    );
  });

  test('releases a claimed thread when adapter selection throws, so retry is not stranded', async () => {
    const claims = new Set<string>();
    const { command } = moduleUnderTest({
      claimStart: () => {
        if (claims.has('thread-1')) return false;
        claims.add('thread-1');
        return true;
      },
      releaseStart: () => claims.delete('thread-1'),
      requireAdapter: () => {
        throw new Error('unknown provider');
      },
    });

    const first = await command.execute(
      {
        type: 'start-session',
        input: { threadId: 'thread-1', provider: 'claude' },
      },
      {},
    );
    const second = await command.execute(
      {
        type: 'start-session',
        input: { threadId: 'thread-1', provider: 'claude' },
      },
      {},
    );

    expect(first.status).toBe('failed');
    expect(second.status).toBe('failed');
    if (second.status !== 'accepted')
      expect(second.message).toBe('unknown provider');
  });

  test('holds the start claim through bindings, then permits a completed reattach', async () => {
    const claims = new Set<string>();
    let attached = false;
    let continueBinding!: () => void;
    let bindingEntered!: () => void;
    const binding = new Promise<void>((resolve) => {
      continueBinding = resolve;
    });
    const bindingHasStarted = new Promise<void>((resolve) => {
      bindingEntered = resolve;
    });
    const adapter = { provider: 'claude', metadata: {} } as never;
    const session = {
      threadId: 'thread-1',
      provider: 'claude',
      status: 'ready',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    } as never;
    const { bind, command, persist } = moduleUnderTest({
      claimStart: () => {
        if (claims.has('thread-1')) return false;
        claims.add('thread-1');
        return true;
      },
      releaseStart: () => claims.delete('thread-1'),
      existing: () => (attached ? { adapter, session } : {}),
      attachStarted: () => {
        attached = true;
      },
      bind: () => {
        bindingEntered();
        return binding;
      },
    });
    const first = command.execute(
      {
        type: 'start-session',
        input: { threadId: 'thread-1', provider: 'claude' },
      },
      {},
    );
    await bindingHasStarted;
    const concurrent = await command.execute(
      {
        type: 'start-session',
        input: { threadId: 'thread-1', provider: 'claude' },
      },
      {},
    );
    expect(concurrent).toMatchObject({
      status: 'failed',
      receipt: { commandType: 'startSession', status: 'failed' },
      message: 'Session is already starting for thread: thread-1',
    });
    expect(bind).toHaveBeenCalledOnce();
    expect(persist).toHaveBeenCalledOnce();
    continueBinding();
    expect((await first).status).toBe('accepted');
    expect(bind).toHaveBeenCalledOnce();
    const reattach = command.execute(
      {
        type: 'start-session',
        input: { threadId: 'thread-1', provider: 'claude' },
      },
      {},
    );
    expect((await reattach).status).toBe('accepted');
    expect(bind).toHaveBeenCalledTimes(2);
    // The rejected concurrent attempt owns a terminal receipt too; only the
    // first start and later reattach reach the binding/persistence success path.
    expect(persist).toHaveBeenCalledTimes(3);
  });
});
