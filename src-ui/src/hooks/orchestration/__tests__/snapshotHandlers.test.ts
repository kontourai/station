import { beforeEach, describe, expect, test, vi } from 'vitest';

const rehydrateChatSession = vi.fn().mockResolvedValue(undefined);
const dismissToast = vi.fn((_id: string) => {});
const showToast = vi.fn(
  (_message: string, _sessionId?: string, _duration?: number) => 'new-toast',
);
vi.mock('../../../contexts/ToastContext', () => ({
  toastStore: {
    dismiss: (id: string) => dismissToast(id),
    show: (message: string, sessionId?: string, duration?: number) =>
      showToast(message, sessionId, duration),
  },
}));
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
    // #2309: the carrier seam; these cases carry no activity record.
    applyConversationActivity: vi.fn(),
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
    dismissToast.mockClear();
    showToast.mockClear();
    chats = {
      'thread-1': {
        provider: 'claude',
        agentSlug: 'claude-code',
        conversationId: 'thread-1',
        orchestrationSessionStarted: true,
      },
    };
  });

  test('replaces open approvals and stale toasts from an authoritative snapshot', () => {
    chats['thread-1'].pendingApprovals = ['stale-request'];
    chats['thread-1'].approvalToasts = new Map([
      ['stale-request', 'stale-toast'],
    ]);
    applyOrchestrationSnapshot(
      {
        sessions: [
          {
            provider: 'claude',
            threadId: 'thread-1',
            status: 'ready',
            hasActiveTurn: false,
            openRequestIds: ['new-request'],
          },
        ],
      },
      { apiBase: 'http://api', isReconnectFallback: true },
    );
    expect(chats['thread-1'].pendingApprovals).toEqual(['new-request']);
    expect(chats['thread-1'].orchestrationStatus).toBe('idle');
    expect(dismissToast).toHaveBeenCalledWith('stale-toast');
    expect(showToast).toHaveBeenCalledOnce();
  });

  test('a terminal runtime error replaces a stale idle status', () => {
    applyOrchestrationSnapshot(
      {
        sessions: [
          {
            provider: 'claude',
            threadId: 'thread-1',
            status: 'ready',
            hasActiveTurn: false,
            lastEventMethod: 'runtime.error',
            openRequestIds: [],
          },
        ],
      },
      { apiBase: 'http://api', isReconnectFallback: true },
    );
    expect(chats['thread-1'].orchestrationStatus).toBe('errored');
    expect(chats['thread-1'].status).toBe('error');
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

// #2303: a Station conversation is ONE chat keyed by its conversation id
// (`muse:C`) but MANY execution threads — the root plus one
// `muse:C:session:<uuid>` child per continuation. The snapshot lists execution
// threads, and each row carries the conversation it belongs to
// (`conversationId`, stamped from the session's own `session.started`
// metadata — root and children alike). The fixture is keyed the way a real
// reopened conversation is (`commitConversationOpen`): store key and
// `conversationId` are the conversation, `currentSessionId` is the child the
// open resolved to — here an OLDER child, because a newer turn started a new
// child after the open. A fixture keyed by the running child's thread id
// passes whether or not the defect exists and is deliberately not written.
describe('#2303: a turn running in a lineage child reseeds its conversation chat', () => {
  const ROOT = 'muse:C';
  const OLD_CHILD = 'muse:C:session:old';
  const LIVE_CHILD = 'muse:C:session:live';

  const rootRow = {
    provider: 'muse' as const,
    threadId: ROOT,
    status: 'idle',
    hasActiveTurn: false,
    conversationId: ROOT,
    createdAt: '2026-09-22T17:00:00.000Z',
    lastEventAt: '2026-09-22T17:01:00.000Z',
  };
  const oldChildRow = {
    provider: 'muse' as const,
    threadId: OLD_CHILD,
    status: 'idle',
    hasActiveTurn: false,
    conversationId: ROOT,
    createdAt: '2026-09-22T17:10:00.000Z',
    lastEventAt: '2026-09-22T17:12:00.000Z',
  };
  const liveChildRow = {
    provider: 'muse' as const,
    threadId: LIVE_CHILD,
    status: 'running',
    hasActiveTurn: true,
    conversationId: ROOT,
    createdAt: '2026-09-22T17:40:00.000Z',
    lastEventAt: '2026-09-22T17:52:00.000Z',
  };

  beforeEach(() => {
    rehydrateChatSession.mockClear();
    updateChat.mockClear();
    chats = {
      [ROOT]: {
        provider: 'muse',
        agentSlug: 'muse-agent',
        conversationId: ROOT,
        currentSessionId: OLD_CHILD,
        orchestrationSessionStarted: true,
        status: 'idle',
        // #2304: a start stamped by an earlier turn, before the gap.
        openTurnStartedAt: Date.parse('2026-09-22T17:10:00.000Z'),
      },
    };
  });

  for (const isReconnectFallback of [false, true]) {
    test(`${isReconnectFallback ? 'a reconnect-fallback' : 'a first'} snapshot reads the conversation's turn as in flight, not idle`, () => {
      applyOrchestrationSnapshot(
        { sessions: [rootRow, oldChildRow, liveChildRow] },
        { apiBase: 'http://api', isReconnectFallback },
      );

      const chat = chats[ROOT];
      expect(chat.orchestrationTurnOpen).toBe(true);
      expect(chat.status).toBe('sending');
      expect(chat.orchestrationStatus).toBe('running');
      // Live events for the running child route through
      // `getChatForExecutionSession`, which matches `currentSessionId`.
      expect(chat.currentSessionId).toBe(LIVE_CHILD);
      // The conversation chat is never marked exited because its own key is
      // the (idle) root rather than the live child.
      expect(chat.orchestrationStatus).not.toBe('exited');
      // No chat was fabricated under an execution-thread key.
      expect(Object.keys(chats)).toEqual([ROOT]);
      // The binding changed under the chat, so it is re-proved exactly as
      // the live `session.started` repair does (`handleOrchestrationEvent`).
      expect(chat.conversationOpenPending).toBe(true);
      expect(chat.conversationOpenFailed).toBe(false);
      if (isReconnectFallback) {
        // The catch-up hands the OPEN turn to the projection — keyed by the
        // conversation chat, not by the child row's thread id.
        expect(chat.openTurnShellSuperseded).toBe(true);
        // #2303 + #2304 together: the catch-up drops the pre-gap start on
        // the CONVERSATION chat too, so the working clock re-derives it
        // rather than counting the previous turn's time.
        expect(chat.openTurnStartedAt).toBeUndefined();
      } else {
        // An ordinary snapshot is not a catch-up; it leaves the start alone.
        expect(chat.openTurnStartedAt).toBe(
          Date.parse('2026-09-22T17:10:00.000Z'),
        );
      }
    });
  }

  test('model fields come from the child running the turn, not the root that launched the first one', () => {
    applyOrchestrationSnapshot(
      {
        sessions: [
          { ...rootRow, reportedModel: 'model-a' },
          { ...liveChildRow, reportedModel: 'model-b' },
        ],
      },
      { apiBase: 'http://api' },
    );
    expect(chats[ROOT].model).toBe('model-b');
    expect(chats[ROOT].orchestrationModel).toBe('model-b');
  });

  // KNOWN GAP, not a desired property: for an idle conversation the root row
  // still speaks (pre-#2303 behavior, unchanged here), so the model label is
  // whatever the FIRST turn launched with (`model-a`) even though the newer
  // child reported `model-b`. Pinned so a change to it is deliberate.
  test('an idle conversation keeps the pre-#2303 semantics (known gap: stale root model label), and the binding is untouched', () => {
    applyOrchestrationSnapshot(
      {
        sessions: [
          { ...rootRow, reportedModel: 'model-a' },
          { ...oldChildRow, reportedModel: 'model-b' },
        ],
      },
      { apiBase: 'http://api' },
    );
    expect(chats[ROOT]).toMatchObject({
      orchestrationTurnOpen: false,
      status: 'idle',
      model: 'model-a',
      currentSessionId: OLD_CHILD,
    });
    expect(chats[ROOT].conversationOpenPending).toBeUndefined();
  });

  test('a conversation whose root row is absent is reconciled from its children, not marked exited', () => {
    applyOrchestrationSnapshot(
      { sessions: [oldChildRow, liveChildRow] },
      { apiBase: 'http://api' },
    );
    expect(chats[ROOT].orchestrationStatus).toBe('running');
    expect(chats[ROOT].orchestrationTurnOpen).toBe(true);
  });

  test('a row without conversationId still reaches the chat whose currentSessionId names it (legacy server)', () => {
    chats[ROOT].currentSessionId = LIVE_CHILD;
    const { conversationId: _root, ...legacyRoot } = rootRow;
    const { conversationId: _child, ...legacyChild } = liveChildRow;
    applyOrchestrationSnapshot(
      { sessions: [legacyRoot, legacyChild] },
      { apiBase: 'http://api' },
    );
    expect(chats[ROOT].orchestrationTurnOpen).toBe(true);
    expect(chats[ROOT].currentSessionId).toBe(LIVE_CHILD);
    // Already bound to the live child: nothing to re-prove.
    expect(chats[ROOT].conversationOpenPending).toBeUndefined();
  });

  test('an idle winner that is not the chat key is never adopted as the binding (root absent, rule 3)', () => {
    const newerIdleChild = {
      ...oldChildRow,
      threadId: 'muse:C:session:newer',
      reportedModel: 'model-new',
      createdAt: '2026-09-22T17:20:00.000Z',
      lastEventAt: '2026-09-22T17:25:00.000Z',
    };
    applyOrchestrationSnapshot(
      {
        sessions: [
          { ...oldChildRow, reportedModel: 'model-old' },
          newerIdleChild,
        ],
      },
      { apiBase: 'http://api' },
    );
    // Rule 3: the LATEST row speaks (not merely the first listed)...
    expect(chats[ROOT].model).toBe('model-new');
    expect(chats[ROOT].orchestrationTurnOpen).toBe(false);
    // ...but an idle row is no evidence of the current child: no adoption,
    // no re-proof churn on every snapshot.
    expect(chats[ROOT].currentSessionId).toBe(OLD_CHILD);
    expect(chats[ROOT].conversationOpenPending).toBeUndefined();
  });

  test('recency is lastEventAt, not createdAt, when the two disagree', () => {
    // `early` was created first but has the most recent activity.
    const early = {
      ...oldChildRow,
      threadId: 'muse:C:session:early',
      reportedModel: 'model-recent-activity',
      createdAt: '2026-09-22T17:05:00.000Z',
      lastEventAt: '2026-09-22T17:50:00.000Z',
    };
    const late = {
      ...oldChildRow,
      threadId: 'muse:C:session:late',
      reportedModel: 'model-recent-creation',
      createdAt: '2026-09-22T17:30:00.000Z',
      lastEventAt: '2026-09-22T17:31:00.000Z',
    };
    applyOrchestrationSnapshot(
      { sessions: [late, early] },
      { apiBase: 'http://api' },
    );
    expect(chats[ROOT].model).toBe('model-recent-activity');
  });

  test('two open children (the server should prevent it): the most recently active one wins', () => {
    const olderOpen = {
      ...liveChildRow,
      threadId: 'muse:C:session:older-open',
      createdAt: '2026-09-22T17:30:00.000Z',
      lastEventAt: '2026-09-22T17:35:00.000Z',
    };
    applyOrchestrationSnapshot(
      { sessions: [olderOpen, liveChildRow] },
      { apiBase: 'http://api' },
    );
    expect(chats[ROOT].currentSessionId).toBe(LIVE_CHILD);
  });

  test('a child-keyed chat that declares the conversation, whose own row is gone, follows the conversation (deliberate)', () => {
    const K = 'muse:C:session:k';
    chats = {
      [K]: {
        provider: 'muse',
        conversationId: ROOT,
        orchestrationSessionStarted: true,
        status: 'idle',
      },
    };
    applyOrchestrationSnapshot(
      { sessions: [rootRow, liveChildRow] },
      { apiBase: 'http://api' },
    );
    expect(chats[K].orchestrationStatus).toBe('running');
    expect(chats[K].orchestrationTurnOpen).toBe(true);
    expect(chats[K].currentSessionId).toBe(LIVE_CHILD);
  });

  test('a chat keyed by the child thread itself still receives that row', () => {
    chats[LIVE_CHILD] = {
      provider: 'muse',
      orchestrationSessionStarted: true,
      status: 'idle',
    };
    applyOrchestrationSnapshot(
      { sessions: [rootRow, liveChildRow] },
      { apiBase: 'http://api' },
    );
    expect(chats[LIVE_CHILD].orchestrationTurnOpen).toBe(true);
    expect(chats[LIVE_CHILD].orchestrationStatus).toBe('running');
    // Its own key is its thread: no binding to adopt.
    expect(chats[LIVE_CHILD].currentSessionId).toBeUndefined();
    expect(chats[ROOT].orchestrationTurnOpen).toBe(true);
  });

  test('row order does not matter: an idle root listed AFTER the live child cannot overwrite it', () => {
    applyOrchestrationSnapshot(
      { sessions: [liveChildRow, oldChildRow, rootRow] },
      { apiBase: 'http://api' },
    );
    expect(chats[ROOT].orchestrationTurnOpen).toBe(true);
    expect(chats[ROOT].currentSessionId).toBe(LIVE_CHILD);
  });
});

describe('#2309: with an activity record, the record names the running child (the #2303 outcomes, from the server)', () => {
  const ROOT = 'muse:R';
  const LIVE_CHILD = 'muse:R:session:live';
  const openRecord = {
    conversationId: ROOT,
    asOfSequence: 50,
    openTurn: {
      turnId: 'turn-live',
      threadId: LIVE_CHILD,
      startedAt: '2026-09-22T17:40:00.000Z',
    },
  };
  const closedRecord = { conversationId: ROOT, asOfSequence: 60 };
  // The per-row folds disagree with the record on purpose: the record is the
  // one the rows are read through.
  const rootRow = (record: typeof openRecord | typeof closedRecord) => ({
    provider: 'muse' as const,
    threadId: ROOT,
    status: 'running',
    hasActiveTurn: false,
    conversationId: ROOT,
    createdAt: '2026-09-22T17:00:00.000Z',
    // The idle root is the NEWEST row.
    lastEventAt: '2026-09-22T17:59:00.000Z',
    reportedModel: 'model-root',
    conversationActivity: record,
  });
  const childRow = (
    record: typeof openRecord | typeof closedRecord,
    hasActiveTurn: boolean,
  ) => ({
    provider: 'muse' as const,
    threadId: LIVE_CHILD,
    status: 'running',
    hasActiveTurn,
    conversationId: ROOT,
    createdAt: '2026-09-22T17:40:00.000Z',
    lastEventAt: '2026-09-22T17:52:00.000Z',
    reportedModel: 'model-child',
    conversationActivity: record,
  });

  beforeEach(() => {
    updateChat.mockClear();
    chats = {
      [ROOT]: {
        provider: 'muse',
        agentSlug: 'muse-agent',
        conversationId: ROOT,
        currentSessionId: ROOT,
        orchestrationSessionStarted: true,
        status: 'idle',
      },
    };
  });

  test('reload mid-turn: the child the record names is adopted and speaks, though its own row reads idle and the root is newest', () => {
    applyOrchestrationSnapshot(
      { sessions: [childRow(openRecord, false), rootRow(openRecord)] },
      { apiBase: 'http://api' },
    );
    const chat = chats[ROOT];
    expect(chat.currentSessionId).toBe(LIVE_CHILD);
    expect(chat.conversationOpenPending).toBe(true);
    expect(chat.orchestrationTurnOpen).toBe(true);
    expect(chat.status).toBe('sending');
    expect(chat.model).toBe('model-child');
    expect(chat.orchestrationStatus).not.toBe('exited');
  });

  test("an idle record and a chat bound to a later child: that child's row speaks (its model, not the root's)", () => {
    chats[ROOT] = { ...chats[ROOT], currentSessionId: LIVE_CHILD };
    applyOrchestrationSnapshot(
      { sessions: [rootRow(closedRecord), childRow(closedRecord, false)] },
      { apiBase: 'http://api' },
    );
    expect(chats[ROOT].model).toBe('model-child');
    expect(chats[ROOT].orchestrationTurnOpen).toBe(false);
  });

  test("mixed rows: a record-less root row with a stale open fold cannot contradict the child's idle record", () => {
    const staleRoot = {
      ...rootRow(closedRecord),
      hasActiveTurn: true,
      conversationActivity: undefined,
    };
    applyOrchestrationSnapshot(
      { sessions: [staleRoot, childRow(closedRecord, false)] },
      { apiBase: 'http://api', isReconnectFallback: true },
    );
    const chat = chats[ROOT];
    // The chat's own (root) row speaks for an idle conversation, but the
    // verdict is the CHAT's record: not open, not adopted, not handed to the
    // projection as an open turn.
    expect(chat.orchestrationTurnOpen).toBe(false);
    expect(chat.status).toBe('idle');
    expect(chat.currentSessionId).toBe(ROOT);
    expect(chat.openTurnShellSuperseded).toBeUndefined();
  });

  test('a stale open row cannot open a conversation the record shows idle, nor be adopted', () => {
    applyOrchestrationSnapshot(
      { sessions: [rootRow(closedRecord), childRow(closedRecord, true)] },
      { apiBase: 'http://api' },
    );
    const chat = chats[ROOT];
    expect(chat.currentSessionId).toBe(ROOT);
    expect(chat.conversationOpenPending).toBeUndefined();
    expect(chat.orchestrationTurnOpen).toBe(false);
    expect(chat.status).toBe('idle');
    // The chat's own row speaks for an idle conversation.
    expect(chat.model).toBe('model-root');
  });
});
