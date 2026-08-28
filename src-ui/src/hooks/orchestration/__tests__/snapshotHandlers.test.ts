import { beforeEach, describe, expect, test, vi } from 'vitest';

const rehydrateChatSession = vi.fn().mockResolvedValue(undefined);
vi.mock('../rehydrateChatSession', () => ({
  rehydrateChatSession: (...args: unknown[]) => rehydrateChatSession(...args),
}));

let chats: Record<string, any> = {};
const updateChat = vi.fn((threadId: string, updates: any) => {
  chats[threadId] = { ...chats[threadId], ...updates };
});

vi.mock('../../../contexts/active-chats-store', () => ({
  activeChatsStore: {
    // A COPY, matching `ActiveChatsStore.notify`'s `{...this.chats }`: the
    // real store hands out a fresh map after every write, so a caller that
    // captured `getSnapshot` before one keeps reading the PRE-write chat.
    // Returning the live map instead makes every captured snapshot silently
    // read post-write, which is exactly the distinction the reconnect
    // refetch loop below depends on (archive#3352).
    getSnapshot: () => ({ ...chats }),
    updateChat: (...args: [string, any]) => updateChat(...args),
  },
}));

import {
  applyOrchestrationSnapshot,
  buildOrchestrationSnapshotSyncPlan,
} from '../snapshotHandlers';

describe('applyOrchestrationSnapshot reconnect-fallback refetch (station#1225)', () => {
  beforeEach(() => {
    rehydrateChatSession.mockClear();
    updateChat.mockClear();
    chats = {
      'thread-1': {
        provider: 'claude',
        agentSlug: 'claude-code',
        conversationId: 'thread-1',
        orchestrationSessionStarted: true,
      },
    };
  });

  test('an ordinary (non-reconnect) snapshot never triggers a messages refetch', () => {
    applyOrchestrationSnapshot(
      {
        sessions: [
          { provider: 'claude', threadId: 'thread-1', status: 'idle' },
        ],
      },
      { apiBase: 'http://api' },
    );
    expect(rehydrateChatSession).not.toHaveBeenCalled();
  });

  test('omitting options entirely (pre-#1225 call shape) never triggers a refetch', () => {
    applyOrchestrationSnapshot({
      sessions: [{ provider: 'claude', threadId: 'thread-1', status: 'idle' }],
    });
    expect(rehydrateChatSession).not.toHaveBeenCalled();
  });

  test('a reconnect-fallback snapshot force-refetches every tracked, agentSlug+conversationId chat it names', () => {
    const preSyncChat = chats['thread-1'];
    applyOrchestrationSnapshot(
      {
        sessions: [
          { provider: 'claude', threadId: 'thread-1', status: 'idle' },
        ],
      },
      { apiBase: 'http://api', isReconnectFallback: true },
    );

    expect(rehydrateChatSession).toHaveBeenCalledTimes(1);
    expect(rehydrateChatSession).toHaveBeenCalledWith(
      'http://api',
      'thread-1',
      preSyncChat,
      { force: true },
    );
  });

  // `rehydrateChatSession` returns immediately for a chat already marked
  // `orchestrationSessionStarted`, and the status sync above sets that flag on
  // every thread this snapshot names. Reading the post-sync map here would
  // therefore make this loop unable to refetch anything at all — the one case
  // it still serves is a locally tracked chat this client did not yet know had
  // an orchestration session, and it can only see that on the PRE-sync chat.
  test('the reconnect refetch is handed the PRE-sync chat, not the one the status sync just marked started', () => {
    chats['thread-1'].orchestrationSessionStarted = false;
    applyOrchestrationSnapshot(
      {
        sessions: [
          { provider: 'claude', threadId: 'thread-1', status: 'idle' },
        ],
      },
      { apiBase: 'http://api', isReconnectFallback: true },
    );

    expect(rehydrateChatSession).toHaveBeenCalledWith(
      'http://api',
      'thread-1',
      expect.objectContaining({ orchestrationSessionStarted: false }),
      { force: true },
    );
    expect(chats['thread-1'].orchestrationSessionStarted).toBe(true);
  });

  test('a reconnect-fallback snapshot skips a tracked chat missing agentSlug/conversationId', () => {
    chats['thread-2'] = {
      provider: 'claude',
      orchestrationSessionStarted: true,
    };
    applyOrchestrationSnapshot(
      {
        sessions: [
          { provider: 'claude', threadId: 'thread-1', status: 'idle' },
          { provider: 'claude', threadId: 'thread-2', status: 'idle' },
        ],
      },
      { apiBase: 'http://api', isReconnectFallback: true },
    );

    expect(rehydrateChatSession).toHaveBeenCalledTimes(1);
    expect(rehydrateChatSession).toHaveBeenCalledWith(
      'http://api',
      'thread-1',
      expect.anything(),
      { force: true },
    );
  });

  test('station#1225 review (MEDIUM fix): a supplied queryClient is forwarded to rehydrateChatSession', () => {
    const fakeQueryClient = { getQueryData: vi.fn() } as any;
    const preSyncChat = chats['thread-1'];
    applyOrchestrationSnapshot(
      {
        sessions: [
          { provider: 'claude', threadId: 'thread-1', status: 'idle' },
        ],
      },
      {
        apiBase: 'http://api',
        isReconnectFallback: true,
        queryClient: fakeQueryClient,
      },
    );

    expect(rehydrateChatSession).toHaveBeenCalledWith(
      'http://api',
      'thread-1',
      preSyncChat,
      { force: true, queryClient: fakeQueryClient },
    );
  });

  test('a reconnect-fallback snapshot on a session with an open turn bumps the history revision the window reader refetches on, and hands that turn to the projection', () => {
    chats['thread-1'].orchestrationHistoryRevision = 4;
    chats['thread-1'].streamingMessage = {
      role: 'assistant',
      content: 'text from before the drop',
    };
    applyOrchestrationSnapshot(
      {
        sessions: [
          {
            provider: 'claude',
            threadId: 'thread-1',
            status: 'running',
            hasActiveTurn: true,
          },
        ],
      },
      { apiBase: 'http://api', isReconnectFallback: true },
    );

    expect(updateChat).toHaveBeenCalledWith(
      'thread-1',
      expect.objectContaining({
        orchestrationHistoryRevision: 5,
        openTurnShellSuperseded: true,
        streamingMessage: undefined,
      }),
    );
  });

  test('a legacy reconnect-fallback snapshot without hasActiveTurn still bumps the revision (absent counts as open)', () => {
    applyOrchestrationSnapshot(
      {
        sessions: [
          { provider: 'claude', threadId: 'thread-1', status: 'running' },
        ],
      },
      { apiBase: 'http://api', isReconnectFallback: true },
    );

    expect(updateChat).toHaveBeenCalledWith(
      'thread-1',
      expect.objectContaining({
        orchestrationHistoryRevision: 1,
        openTurnShellSuperseded: true,
      }),
    );
  });

  // archive#3352's permanent case: the turn both streamed and COMPLETED
  // inside the gap, so the session is idle at reconnect and its
  // `turn.completed` — the only other thing that advances this revision — was
  // never delivered. Skipping the bump here leaves the user their prompt and
  // no answer until the dock remounts.
  test('a reconnect-fallback snapshot whose session is idle still bumps the history revision', () => {
    chats['thread-1'].orchestrationHistoryRevision = 2;
    applyOrchestrationSnapshot(
      {
        sessions: [
          {
            provider: 'claude',
            threadId: 'thread-1',
            status: 'idle',
            hasActiveTurn: false,
          },
        ],
      },
      { apiBase: 'http://api', isReconnectFallback: true },
    );

    expect(updateChat).toHaveBeenCalledWith(
      'thread-1',
      expect.objectContaining({ orchestrationHistoryRevision: 3 }),
    );
    // No open turn means no shell to hand over: the suppression this flag
    // disables is gated on `orchestrationTurnOpen`, which this payload clears.
    expect(
      updateChat.mock.calls.some(
        ([, updates]) => 'openTurnShellSuperseded' in updates,
      ),
    ).toBe(false);
  });

  test('a reconnect-fallback snapshot writes each named thread exactly once', () => {
    chats['thread-2'] = {
      provider: 'claude',
      agentSlug: 'claude-code',
      conversationId: 'thread-2',
      orchestrationSessionStarted: true,
    };
    applyOrchestrationSnapshot(
      {
        sessions: [
          {
            provider: 'claude',
            threadId: 'thread-1',
            status: 'running',
            hasActiveTurn: true,
          },
          {
            provider: 'claude',
            threadId: 'thread-2',
            status: 'idle',
            hasActiveTurn: false,
          },
        ],
      },
      { apiBase: 'http://api', isReconnectFallback: true },
    );

    expect(updateChat.mock.calls.map(([threadId]) => threadId)).toEqual([
      'thread-1',
      'thread-2',
    ]);
  });

  test('an ordinary (non-reconnect) snapshot never bumps the history revision even with an open turn', () => {
    applyOrchestrationSnapshot(
      {
        sessions: [
          {
            provider: 'claude',
            threadId: 'thread-1',
            status: 'running',
            hasActiveTurn: true,
          },
        ],
      },
      { apiBase: 'http://api' },
    );

    const revisionBumps = updateChat.mock.calls.filter(
      ([, updates]) => 'orchestrationHistoryRevision' in updates,
    );
    expect(revisionBumps).toEqual([]);
  });

  test('a reconnect-fallback snapshot never refetches a chat this snapshot did not name', () => {
    chats['thread-untracked-elsewhere'] = {
      provider: 'claude',
      agentSlug: 'claude-code',
      conversationId: 'thread-untracked-elsewhere',
      orchestrationSessionStarted: true,
    };
    applyOrchestrationSnapshot(
      {
        sessions: [
          { provider: 'claude', threadId: 'thread-1', status: 'idle' },
        ],
      },
      { apiBase: 'http://api', isReconnectFallback: true },
    );

    expect(rehydrateChatSession).toHaveBeenCalledTimes(1);
    expect(rehydrateChatSession).toHaveBeenCalledWith(
      'http://api',
      'thread-1',
      expect.anything(),
      { force: true },
    );
  });
});

describe('station#1301 slice 1: OrchestrationSnapshotPayload widening is behavior-neutral', () => {
  beforeEach(() => {
    rehydrateChatSession.mockClear();
    updateChat.mockClear();
    chats = {
      'thread-1': {
        provider: 'claude',
        agentSlug: 'claude-code',
        conversationId: 'thread-1',
        orchestrationSessionStarted: true,
      },
    };
  });

  // The type widened in `types.ts` (`delegation`/`createdAt`/`lastEventAt`)
  // is declare-only for `buildOrchestrationSnapshotSyncPlan` — it reads none
  // of those fields. This pins that a payload carrying them (as every real
  // wire payload now does, archive#1301 §1.3) folds into the EXACT same
  // `updateChat` call as a payload that omits them (the pre-widening shape),
  // so the new fields cannot silently perturb the existing chat-status sync.
  test('a session carrying the new fields updates the chat identically to one without them', () => {
    applyOrchestrationSnapshot({
      sessions: [
        {
          provider: 'claude',
          threadId: 'thread-1',
          status: 'running',
          hasActiveTurn: true,
          delegation: { taskId: 'thread-1' },
          createdAt: '2026-07-29T00:00:00.000Z',
          lastEventAt: '2026-07-29T00:05:00.000Z',
        },
      ],
    });
    const withNewFields = updateChat.mock.calls.at(-1);

    updateChat.mockClear();
    chats['thread-1'] = {
      provider: 'claude',
      agentSlug: 'claude-code',
      conversationId: 'thread-1',
      orchestrationSessionStarted: true,
    };
    applyOrchestrationSnapshot({
      sessions: [
        {
          provider: 'claude',
          threadId: 'thread-1',
          status: 'running',
          hasActiveTurn: true,
        },
      ],
    });
    const withoutNewFields = updateChat.mock.calls.at(-1);

    expect(withNewFields).toEqual(withoutNewFields);
  });

  test('a session with only the new fields and no delegation.parentTaskId still never triggers a reconnect refetch', () => {
    applyOrchestrationSnapshot(
      {
        sessions: [
          {
            provider: 'claude',
            threadId: 'thread-1',
            status: 'idle',
            delegation: { taskId: 'thread-1' },
            createdAt: '2026-07-29T00:00:00.000Z',
          },
        ],
      },
      { apiBase: 'http://api' },
    );
    expect(rehydrateChatSession).not.toHaveBeenCalled();
  });

  test('model acknowledgment preserves newer controls but collapses both requests when controls match', () => {
    chats['thread-1'] = {
      ...chats['thread-1'],
      requestedModel: 'B',
      requestedModelSource: 'session override',
      requestedProviderOptions: { effort: 'low' },
    };
    const stale = buildOrchestrationSnapshotSyncPlan(
      {
        sessions: [
          {
            provider: 'claude',
            threadId: 'thread-1',
            status: 'idle',
            effectiveModel: 'B',
            effectiveModelOptions: { effort: 'high' },
          },
        ],
      },
      chats,
    );
    expect(stale.sessionUpdates[0]?.updates).toMatchObject({
      requestedModel: undefined,
      modelSource: 'session override',
    });
    expect(stale.sessionUpdates[0]?.updates).not.toHaveProperty(
      'requestedProviderOptions',
    );

    chats['thread-1'] = {
      ...chats['thread-1'],
      requestedModel: 'B',
      requestedModelSource: 'session override',
      requestedProviderOptions: { effort: 'low' },
    };
    const matching = buildOrchestrationSnapshotSyncPlan(
      {
        sessions: [
          {
            provider: 'claude',
            threadId: 'thread-1',
            status: 'idle',
            effectiveModel: 'B',
            effectiveModelOptions: { effort: 'low' },
          },
        ],
      },
      chats,
    );
    expect(matching.sessionUpdates[0]?.updates).toMatchObject({
      requestedModel: undefined,
      requestedProviderOptions: undefined,
      modelSource: 'session override',
    });
  });

  test('an authoritative default report collapses an explicit default request', () => {
    chats['thread-1'] = {
      ...chats['thread-1'],
      model: 'old-override',
      defaultModel: 'engine-default',
      requestedModel: null,
      requestedModelSource: 'agent default',
    };
    const plan = buildOrchestrationSnapshotSyncPlan(
      {
        sessions: [
          {
            provider: 'claude',
            threadId: 'thread-1',
            status: 'idle',
            reportedModel: 'engine-default',
          },
        ],
      },
      chats,
    );
    expect(plan.sessionUpdates[0]?.updates).toMatchObject({
      model: 'engine-default',
      requestedModel: undefined,
    });
  });

  test('a late duplicate A report cannot erase the next B request', () => {
    chats['thread-1'] = {
      ...chats['thread-1'],
      requestedModel: 'A',
      requestedModelSource: 'session override',
      requestedProviderOptions: { effort: 'high' },
    };
    const acknowledgedA = buildOrchestrationSnapshotSyncPlan(
      {
        sessions: [
          {
            provider: 'claude',
            threadId: 'thread-1',
            status: 'idle',
            effectiveModel: 'A',
            effectiveModelOptions: { effort: 'high' },
          },
        ],
      },
      chats,
    );
    chats['thread-1'] = {
      ...chats['thread-1'],
      ...acknowledgedA.sessionUpdates[0]?.updates,
      requestedModel: 'B',
      requestedModelSource: 'session override',
      requestedProviderOptions: { effort: 'low' },
    };
    const plan = buildOrchestrationSnapshotSyncPlan(
      {
        sessions: [
          {
            provider: 'claude',
            threadId: 'thread-1',
            status: 'idle',
            effectiveModel: 'A',
            effectiveModelOptions: { effort: 'high' },
          },
        ],
      },
      chats,
    );
    expect(plan.sessionUpdates[0]?.updates).not.toHaveProperty(
      'requestedModel',
    );
  });
});
