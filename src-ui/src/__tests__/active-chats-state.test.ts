import { describe, expect, test } from 'vitest';
import type { ChatUIState } from '../contexts/active-chats-state';
import {
  appendInputHistory,
  assignConversationIdState,
  clearEphemeralMessagesState,
  clearInputState,
  clearQueueState,
  createDefaultChatState,
  createEphemeralMessageState,
  hydrateActiveChats,
  mergeChatUpdates,
  navigateHistoryDownState,
  navigateHistoryUpState,
  removeQueuedMessageState,
  reorderQueuedMessageState,
  serializeActiveChats,
} from '../contexts/active-chats-state';
import type { PlanArtifact } from '../utils/planArtifacts';

describe('active chat state helpers', () => {
  test('creates default chat state with metadata merged in', () => {
    expect(
      createDefaultChatState({
        agentSlug: 'planner',
        agentName: 'Planner',
        title: 'Planning',
        conversationId: 'conv-1',
        projectSlug: 'proj',
        projectName: 'Project',
        provider: 'anthropic',
        model: 'sonnet',
        providerOptions: { temperature: 0.2 },
      }),
    ).toMatchObject({
      input: '',
      attachments: [],
      queuedMessages: [],
      inputHistory: [],
      hasUnread: false,
      provider: 'anthropic',
      providerOptions: { temperature: 0.2 },
      orchestrationSessionStarted: false,
      agentSlug: 'planner',
      title: 'Planning',
      conversationId: 'conv-1',
      model: 'sonnet',
      projectSlug: 'proj',
      projectName: 'Project',
    });
  });

  test('hydrates and serializes only conversation-backed sessions', () => {
    const planArtifact: PlanArtifact = {
      source: 'reasoning',
      rawText: '✅ First\n🔄 Second',
      steps: [
        { content: 'First', status: 'completed' },
        { content: 'Second', status: 'in_progress' },
      ],
      updatedAt: '2026-01-01T00:00:00.000Z',
    };
    const chats = hydrateActiveChats([
      {
        sessionId: 'draft:1',
        conversationId: 'conv-draft',
        agentSlug: 'planner',
        inputHistory: ['/resume'],
        currentModeId: 'plan',
        planArtifact,
      },
      {
        sessionId: 'ephemeral:1',
        conversationId: undefined as never,
        agentSlug: 'planner',
      } as never,
    ]);

    expect(chats['draft:1']).toMatchObject({
      input: '',
      inputHistory: ['/resume'],
      provider: undefined,
      ephemeralMessages: [],
      currentModeId: 'plan',
      planArtifact,
    });

    expect(
      serializeActiveChats({
        ...chats,
        'draft:1': {
          ...chats['draft:1'],
          model: 'sonnet',
        },
      }),
    ).toEqual([
      expect.objectContaining({
        sessionId: 'draft:1',
        conversationId: 'conv-draft',
        agentSlug: 'planner',
        model: 'sonnet',
        currentModeId: 'plan',
        planArtifact,
      }),
    ]);
  });

  // archive#1566: title round-trips through serialize -> hydrate, and a
  // title change is itself a persist-worthy update, so a reload shows the
  // real title immediately instead of falling back to a stale default while
  // the conversation list refetches.
  test('station#3300: a persisted LIVE orchestrationStatus is not resurrected as a claim of in-flight work', () => {
    // The resume defect: `orchestrationStatus: 'running'` was persisted
    // mid-turn, the turn settled while the app was hidden, and a webview
    // reload restored the stale claim — with `orchestrationTurnOpen`,
    // `status`, and `streamingMessage` all deliberately NOT persisted, the
    // restored flag was a label nothing could re-derive, and the chat
    // rendered "Working…" under its own settled answer. Fail closed: a
    // rehydrated chat cannot claim work it cannot verify; the SSE
    // snapshot/state-changed sync supplies the true value after connect.
    const hydrate = (orchestrationStatus?: string) =>
      hydrateActiveChats([
        {
          sessionId: 's1',
          conversationId: 'c1',
          agentSlug: 'planner',
          createdAt: 1,
          orchestrationSessionStarted: true,
          orchestrationStatus,
          providerOptions: {},
          sessionAutoApprove: [],
          inputHistory: [],
          planArtifact: null,
          flowRun: null,
        } as any,
      ]).s1;

    expect(hydrate('running').orchestrationStatus).toBeUndefined();
    expect(hydrate('awaiting-approval').orchestrationStatus).toBeUndefined();
    // Settled statuses are facts about the past, not live claims — they
    // survive the round trip unchanged.
    expect(hydrate('errored').orchestrationStatus).toBe('errored');
    expect(hydrate('exited').orchestrationStatus).toBe('exited');
    expect(hydrate('idle').orchestrationStatus).toBe('idle');
    expect(hydrate(undefined).orchestrationStatus).toBeUndefined();
  });

  test('station#1566: title round-trips through serializeActiveChats -> hydrateActiveChats', () => {
    const [persisted] = serializeActiveChats({
      'chat:1': {
        ...createDefaultChatState(),
        agentSlug: 'planner',
        conversationId: 'conv-1',
        title: 'Deploying the app to production',
      },
    });

    expect(persisted).toMatchObject({
      title: 'Deploying the app to production',
    });
    expect(hydrateActiveChats([persisted])['chat:1']).toMatchObject({
      title: 'Deploying the app to production',
    });
  });

  test('#749 reload persists only the last child identity and fails closed pending a fresh open resolution', () => {
    const [persisted] = serializeActiveChats({
      'chat:749': {
        ...createDefaultChatState(),
        agentSlug: 'planner',
        conversationId: 'cool-conversation',
        currentSessionId: 'cool-conversation:child:2',
        conversationOpenState: {
          status: 'resolved',
          conversation: {
            id: 'cool-conversation',
            source: 'runtime',
            agentSlug: 'planner' as any,
            title: 'Cool',
            createdAt: '2026-08-01T00:00:00.000Z',
            updatedAt: '2026-08-01T00:01:00.000Z',
            messageCount: 2,
            mutable: false,
            answerability: { answerable: true },
          },
          currentSessionId: 'cool-conversation:child:2',
          transcript: { available: true, owner: 'runtime', messageCount: 2 },
          canContinue: true,
          answerability: { answerable: true },
          recoveryActions: [],
        },
      },
    });

    expect(persisted).toMatchObject({
      currentSessionId: 'cool-conversation:child:2',
    });
    expect(persisted).not.toHaveProperty('conversationOpenState');
    expect(hydrateActiveChats([persisted])['chat:749']).toMatchObject({
      currentSessionId: 'cool-conversation:child:2',
      conversationOpenPending: true,
    });
    expect(hydrateActiveChats([persisted])['chat:749']).not.toHaveProperty(
      'conversationOpenState',
    );
  });

  test('station#2460: picker requests survive the sessionStorage round trip', () => {
    const [persisted] = serializeActiveChats({
      'chat:1': {
        ...createDefaultChatState(),
        agentSlug: 'planner',
        conversationId: 'conv-1',
        requestedModel: 'gpt-5',
        requestedModelSource: 'session override',
        requestedProviderOptions: { effort: 'high' },
      },
    });
    expect(hydrateActiveChats([persisted])['chat:1']).toMatchObject({
      requestedModel: 'gpt-5',
      requestedModelSource: 'session override',
      requestedProviderOptions: { effort: 'high' },
    });
  });

  test('station#2460: a legacy persisted payload without picker-request fields hydrates cleanly', () => {
    const hydrated = hydrateActiveChats([
      {
        sessionId: 'legacy:1',
        conversationId: 'conv-legacy',
        agentSlug: 'planner',
        title: 'Legacy chat',
        model: 'agent-default',
      },
    ]);

    expect(hydrated['legacy:1']).toMatchObject({
      model: 'agent-default',
      requestedModel: undefined,
      requestedProviderOptions: undefined,
    });
  });

  test('station#1566: a title change triggers persist', () => {
    const result = mergeChatUpdates(
      {
        input: '',
        attachments: [],
        queuedMessages: [],
        inputHistory: [],
        hasUnread: false,
      },
      { title: 'A generated title' },
    );

    expect(result).toEqual({
      chat: expect.objectContaining({ title: 'A generated title' }),
      shouldPersist: true,
      droppedQueuedMessages: [],
    });
  });

  test('persists the default provider separately from a per-chat provider override', () => {
    const [persisted] = serializeActiveChats({
      'chat:1': {
        ...createDefaultChatState(),
        agentSlug: 'planner',
        conversationId: 'conv-1',
        providerId: 'bedrock-prod',
        defaultProviderId: 'codex-work',
      },
    });

    expect(persisted).toMatchObject({
      providerId: 'bedrock-prod',
      defaultProviderId: 'codex-work',
    });
    expect(hydrateActiveChats([persisted])['chat:1']).toMatchObject({
      providerId: 'bedrock-prod',
      defaultProviderId: 'codex-work',
    });
  });

  test('hydrateActiveChats preserves clean executionMode values', () => {
    const chats = hydrateActiveChats([
      {
        sessionId: 'station-agent',
        conversationId: 'conv-station',
        agentSlug: 'planner',
        executionMode: 'station',
      },
      {
        sessionId: 'external-agent',
        conversationId: 'conv-external',
        agentSlug: 'planner',
        executionMode: 'external',
      },
    ]);

    expect(chats['station-agent'].executionMode).toBe('station');
    expect(chats['external-agent'].executionMode).toBe('external');
  });

  test('navigates history and restores saved input', () => {
    const seeded = appendInputHistory(
      {
        input: 'draft',
        attachments: [],
        queuedMessages: [],
        inputHistory: ['first', 'second'],
        hasUnread: false,
      },
      'third',
    );

    expect(seeded.inputHistory).toEqual(['first', 'second', 'third']);

    const up = navigateHistoryUpState({
      ...seeded,
      input: 'draft',
      historyIndex: -1,
      savedInput: undefined,
    });

    expect(up).toMatchObject({
      input: 'third',
      historyIndex: 2,
      savedInput: 'draft',
    });

    const down = navigateHistoryDownState({
      ...up!,
      historyIndex: 2,
      savedInput: 'draft',
    });

    expect(down).toMatchObject({
      input: 'draft',
      historyIndex: -1,
      savedInput: undefined,
    });
  });

  test('merges updates and resets history when input changes', () => {
    const result = mergeChatUpdates(
      {
        input: 'draft',
        attachments: [],
        queuedMessages: [],
        inputHistory: [],
        hasUnread: false,
        historyIndex: 2,
      },
      { input: 'changed' },
    );

    expect(result).toEqual({
      chat: expect.objectContaining({
        input: 'changed',
        historyIndex: -1,
      }),
      shouldPersist: false,
      droppedQueuedMessages: [],
    });
  });

  test('persists plan artifact updates', () => {
    const planArtifact: PlanArtifact = {
      source: 'assistant',
      rawText: '- First\n- Second',
      steps: [
        { content: 'First', status: 'pending' },
        { content: 'Second', status: 'pending' },
      ],
      updatedAt: '2026-01-01T00:00:00.000Z',
    };

    const result = mergeChatUpdates(
      {
        input: '',
        attachments: [],
        queuedMessages: [],
        inputHistory: [],
        hasUnread: false,
      },
      { planArtifact },
    );

    expect(result).toEqual({
      chat: expect.objectContaining({ planArtifact }),
      shouldPersist: true,
      droppedQueuedMessages: [],
    });
  });

  test('creates ephemeral messages using the persisted conversation id', () => {
    const next = createEphemeralMessageState(
      {
        input: '',
        attachments: [],
        queuedMessages: [],
        inputHistory: [],
        hasUnread: false,
        agentSlug: 'planner',
        conversationId: 'conv-42',
        ephemeralMessages: [],
      },
      {
        role: 'system',
        content: 'queued',
      },
      () => 100,
      () => 'seed',
      (agentSlug, conversationId) => {
        expect(agentSlug).toBe('planner');
        expect(conversationId).toBe('conv-42');
        return [{ timestamp: '2026-01-01T00:00:05.000Z' }];
      },
    );

    expect(next?.ephemeralMessages?.[0]).toMatchObject({
      id: 'ephemeral-100-seed',
      content: 'queued',
      ephemeral: true,
      timestamp: new Date('2026-01-01T00:00:05.000Z').getTime() + 1,
    });
    // archive#1292: insertAfterCount was dropped — nothing ever read it, and
    // the guaranteed timestamp above is sufficient for the transcript sort.
    expect(next?.ephemeralMessages?.[0]).not.toHaveProperty('insertAfterCount');
  });

  test('creates ephemeral messages carrying an action (station#1292: every failure-path notice, including one with a Retry/Continue/Discard action, now goes through this single assignment path)', () => {
    const handler = () => {};
    const next = createEphemeralMessageState(
      {
        input: '',
        attachments: [],
        queuedMessages: [],
        inputHistory: [],
        hasUnread: false,
        agentSlug: 'planner',
        conversationId: 'conv-42',
        ephemeralMessages: [],
      },
      {
        role: 'system',
        content: 'Something failed',
        action: { label: 'Retry', handler },
      },
      () => 100,
      () => 'seed',
      () => [],
    );

    expect(next?.ephemeralMessages?.[0]).toMatchObject({
      content: 'Something failed',
      ephemeral: true,
      action: { label: 'Retry', handler },
    });
    expect(typeof next?.ephemeralMessages?.[0]?.id).toBe('string');
    expect(typeof next?.ephemeralMessages?.[0]?.timestamp).toBe('number');
  });

  test('station#1292: ephemeral messages are never persisted — serializeActiveChats omits the field entirely', () => {
    const chat: ChatUIState = {
      ...createDefaultChatState(),
      agentSlug: 'planner',
      conversationId: 'conv-persist',
      ephemeralMessages: [
        { role: 'system', content: 'transient notice', ephemeral: true },
      ],
    };

    const [persisted] = serializeActiveChats({ 'planner:1': chat });

    expect(persisted).not.toHaveProperty('ephemeralMessages');
  });

  test('station#1292: hydrateActiveChats always starts with no ephemeral messages, even for a legacy payload that still carries the field', () => {
    const chats = hydrateActiveChats([
      {
        sessionId: 'legacy:1',
        conversationId: 'conv-legacy',
        agentSlug: 'planner',
        // A pre-archive#1292 sessionStorage payload could still have this field —
        // hydrate must discard it rather than resurrect a stale notice.
        ephemeralMessages: [
          { role: 'system', content: 'stale notice from before reload' },
        ],
      } as never,
    ]);

    expect(chats['legacy:1'].ephemeralMessages).toEqual([]);
  });

  test('persists a byte-free attachment stage snapshot for reconnect', () => {
    const [persisted] = serializeActiveChats({
      'planner:1': {
        ...createDefaultChatState({
          agentSlug: 'planner',
          agentName: 'Planner',
          conversationId: 'conv-1',
          title: 'Plan',
        }),
        attachmentStages: [
          {
            clientAttachmentId: 'file-1',
            name: 'notes.txt',
            mimeType: 'text/plain',
            size: 2,
            state: 'complete',
            progress: 1,
            stageId: 'stage-1',
            delivery: 'staged',
            reference: {
              stageId: 'stage-1',
              clientAttachmentId: 'file-1',
              source: 'current-composer',
              kind: 'file',
              name: 'notes.txt',
              mimeType: 'text/plain',
              size: 2,
              digest:
                'sha256-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
              expiresAt: '2030-01-01T00:00:00.000Z',
            },
          },
        ],
      },
    });
    expect(JSON.stringify(persisted)).not.toMatch(/data:|uploadGrant|grant/i);
    expect(persisted.attachmentStages?.[0]).toMatchObject({
      stageId: 'stage-1',
    });
  });

  test('simple state transforms preserve immutability', () => {
    const chat: ChatUIState = {
      ...createDefaultChatState(),
      input: 'draft',
      attachments: [
        { id: 'a1', name: 'file', type: 'text/plain', size: 1, data: '' },
      ],
      queuedMessages: ['queued'],
      ephemeralMessages: [{ role: 'assistant', content: 'hi' }],
    };

    expect(clearInputState(chat)).toEqual(
      expect.objectContaining({
        input: '',
        attachments: [],
      }),
    );
    expect(clearQueueState(chat)).toEqual(
      expect.objectContaining({
        queuedMessages: [],
      }),
    );
    expect(clearEphemeralMessagesState(chat)).toEqual(
      expect.objectContaining({
        ephemeralMessages: [],
      }),
    );
    expect(assignConversationIdState(chat, 'conv-new')).toEqual(
      expect.objectContaining({
        conversationId: 'conv-new',
      }),
    );
    expect(
      removeQueuedMessageState({ ...chat, queuedMessages: ['a', 'b'] }, 0),
    ).toEqual(expect.objectContaining({ queuedMessages: ['b'] }));
  });

  describe('reorderQueuedMessageState (#613)', () => {
    const chatWithQueue = (queuedMessages: string[]): ChatUIState => ({
      ...createDefaultChatState(),
      queuedMessages,
    });

    test('moves a message from one index to another', () => {
      const chat = chatWithQueue(['a', 'b', 'c']);
      expect(reorderQueuedMessageState(chat, 0, 2)).toEqual(
        expect.objectContaining({ queuedMessages: ['b', 'c', 'a'] }),
      );
      expect(reorderQueuedMessageState(chat, 2, 0)).toEqual(
        expect.objectContaining({ queuedMessages: ['c', 'a', 'b'] }),
      );
    });

    test('swaps adjacent messages (the moveUp/moveDown case)', () => {
      const chat = chatWithQueue(['a', 'b', 'c']);
      expect(reorderQueuedMessageState(chat, 1, 0)).toEqual(
        expect.objectContaining({ queuedMessages: ['b', 'a', 'c'] }),
      );
      expect(reorderQueuedMessageState(chat, 1, 2)).toEqual(
        expect.objectContaining({ queuedMessages: ['a', 'c', 'b'] }),
      );
    });

    test('clamps an out-of-range toIndex into the valid range', () => {
      const chat = chatWithQueue(['a', 'b', 'c']);
      expect(reorderQueuedMessageState(chat, 0, 99)).toEqual(
        expect.objectContaining({ queuedMessages: ['b', 'c', 'a'] }),
      );
      expect(reorderQueuedMessageState(chat, 2, -99)).toEqual(
        expect.objectContaining({ queuedMessages: ['c', 'a', 'b'] }),
      );
    });

    test('is a no-op that returns the identical chat object when fromIndex is out of range', () => {
      const chat = chatWithQueue(['a', 'b']);
      expect(reorderQueuedMessageState(chat, -1, 0)).toBe(chat);
      expect(reorderQueuedMessageState(chat, 2, 0)).toBe(chat);
    });

    test('is a no-op that returns the identical chat object at either boundary (moveUp at 0, moveDown at length-1)', () => {
      const chat = chatWithQueue(['a', 'b', 'c']);
      // moveUp(0) → reorder(0, -1): clamps to 0, same position.
      expect(reorderQueuedMessageState(chat, 0, -1)).toBe(chat);
      // moveDown(2) → reorder(2, 3): clamps to 2, same position.
      expect(reorderQueuedMessageState(chat, 2, 3)).toBe(chat);
    });
  });
});

// a queued follow-up is user-authored content Station is holding
// on the user's behalf. Hydration always started it empty and serialization
// omitted it entirely, so a reload destroyed both the retained text and the
// reason it was retained.
describe('queued follow-ups survive a reload (UX audit T3)', () => {
  const chats = {
    s1: {
      ...createDefaultChatState({
        agentSlug: 'claude',
        agentName: 'Claude Code',
        title: 'New chat',
        conversationId: 'conv-t3',
      }),
      queuedMessages: ['and then run the tests', 'then summarise'],
      queuedMessageFailure: {
        message:
          'This conversation was started without a workspace, so it cannot be continued inside one.',
        code: 'continuation_workspace_unbound',
        at: 1_760_000_000_000,
      },
    } as ChatUIState,
  };

  // archive#3706: a permanently refused follow-up has NO queue row left, so
  // the unsent record is its only durable copy. Same principle.
  test('unsent records round-trip through storage', () => {
    const withUnsent = {
      s1: {
        ...chats.s1,
        unsentMessages: [
          {
            id: 'unsent-1',
            content: 'the follow-up that was refused',
            reason:
              'This chat had already ended when Station tried to send it.',
            at: 1_760_000_000_001,
          },
        ],
      } as ChatUIState,
    };
    const persisted = serializeActiveChats(withUnsent);
    expect(persisted[0]?.unsentMessages).toEqual(withUnsent.s1.unsentMessages);
    const rehydrated = hydrateActiveChats(persisted);
    expect(rehydrated.s1?.unsentMessages).toEqual(withUnsent.s1.unsentMessages);
  });

  // archive#3706: a drop can land while a new chat is still
  // awaiting conversation promotion; filtering conversation-less chats out of
  // serialization silently destroyed the record's ONLY durable copy.
  test('a chat holding unsent records is persisted even before conversation promotion', () => {
    const preChats = {
      fresh: {
        ...createDefaultChatState({
          agentSlug: 'codex',
          agentName: 'Codex',
          title: 'New chat',
        }),
        unsentMessages: [
          {
            id: 'unsent-pre-promotion',
            content: 'held text',
            reason: 'Refused.',
            at: 1,
          },
        ],
      } as ChatUIState,
    };
    expect(preChats.fresh.conversationId).toBeUndefined();

    const persisted = serializeActiveChats(preChats);
    expect(persisted).toHaveLength(1);
    expect(persisted[0]?.unsentMessages?.[0]?.content).toBe('held text');

    const rehydrated = hydrateActiveChats(persisted);
    expect(rehydrated.fresh?.unsentMessages?.[0]?.content).toBe('held text');
    expect(rehydrated.fresh?.conversationId).toBeUndefined();
  });

  // …and a conversation-less chat WITHOUT them stays unpersisted — the
  // filter widened for exactly one reason, not for every transient chat.
  test('a conversation-less chat without unsent records is still not persisted', () => {
    const transientChats = {
      transient: createDefaultChatState({
        agentSlug: 'codex',
        agentName: 'Codex',
        title: 'New chat',
      }),
    };
    expect(serializeActiveChats(transientChats)).toHaveLength(0);
  });

  test('a chat with no unsent records serializes without the field', () => {
    const persisted = serializeActiveChats(chats);
    expect(persisted[0]).not.toHaveProperty('unsentMessages');
    expect(hydrateActiveChats(persisted).s1).not.toHaveProperty(
      'unsentMessages',
    );
  });

  test('the retained messages and the refusal round-trip through storage', () => {
    const persisted = serializeActiveChats(chats);
    expect(persisted[0]?.queuedMessages).toEqual([
      'and then run the tests',
      'then summarise',
    ]);
    expect(persisted[0]?.queuedMessageFailure?.code).toBe(
      'continuation_workspace_unbound',
    );

    const rehydrated = hydrateActiveChats(persisted);
    expect(rehydrated.s1?.queuedMessages).toEqual([
      'and then run the tests',
      'then summarise',
    ]);
    expect(rehydrated.s1?.queuedMessageFailure).toEqual(
      chats.s1.queuedMessageFailure,
    );
  });

  test('a chat with no queue rehydrates with an empty one and no stale reason', () => {
    const rehydrated = hydrateActiveChats([
      {
        sessionId: 's2',
        conversationId: 'conv-empty',
        agentSlug: 'claude',
      },
    ]);
    expect(rehydrated.s2?.queuedMessages).toEqual([]);
    expect(rehydrated.s2?.queuedMessageFailure).toBeUndefined();
  });
});
