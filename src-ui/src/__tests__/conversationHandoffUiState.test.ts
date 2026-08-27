import { describe, expect, test } from 'vitest';
import {
  acceptConversationHandoffUiState,
  beginConversationHandoffUiState,
} from '../components/chat-dock/conversationHandoffUiState';
import type { ChatUIState } from '../contexts/active-chats-state';

describe('conversation handoff UI state', () => {
  test('deduplicates the optimistic prompt and clears predecessor-local controls on acceptance', () => {
    const predecessor = {
      messages: [{ role: 'assistant' as const, content: 'historical answer' }],
      queuedMessages: ['old queue'],
      pendingApprovals: ['approval-old'],
      approvalToasts: new Map([['approval-old', 'Approve?']]),
      sessionAutoApprove: ['tool-old'],
      orchestrationTurnOpen: true,
      openTurnId: 'turn-old',
      streamingMessage: { content: 'stale stream' },
      toolCalls: [{ id: 'tool-old', name: 'write', args: {} }],
      planArtifact: { version: 1, entries: [] },
      currentModeId: 'mode-old',
      backgroundTasks: [{ id: 'task-old', description: 'stale task' }],
      orchestrationHistoryRevision: 4,
    } as unknown as ChatUIState;
    const begun = beginConversationHandoffUiState(predecessor, {
      message: 'follow up',
      clientTurnId: 'handoff:key',
      now: 1,
    });
    const repeated = beginConversationHandoffUiState(
      { ...predecessor, ...begun },
      { message: 'follow up', clientTurnId: 'handoff:key', now: 2 },
    );
    expect(
      repeated.messages?.filter(
        (message) => message.clientId === 'handoff:key',
      ),
    ).toHaveLength(1);

    const accepted = acceptConversationHandoffUiState(
      { ...predecessor, ...repeated },
      {
        slug: 'codex',
        name: 'Codex',
        execution: { agentConnectionId: 'codex' },
      } as never,
      {
        predecessorSessionId: 'session-a',
        sessionId: 'session-b',
        currentSessionId: 'session-b',
        outcome: 'created',
        target: {
          agentId: 'codex' as never,
          engine: { kind: 'connection', connectionId: 'codex' as never },
          modelId: 'gpt-5',
        },
        carried: [],
        reset: [],
      },
    );

    const merged = { ...predecessor, ...repeated, ...accepted };
    expect(merged.messages).toEqual(repeated.messages);
    expect(merged).toMatchObject({
      currentSessionId: 'session-b',
      queuedMessages: [],
      pendingApprovals: [],
      sessionAutoApprove: [],
      orchestrationTurnOpen: false,
      toolCalls: [],
      planArtifact: null,
      currentModeId: null,
      backgroundTasks: [],
      orchestrationHistoryRevision: 5,
    });
    expect(accepted.streamingMessage).toBeUndefined();
    expect(accepted.approvalToasts).toEqual(new Map());
  });

  test('accepts a server-receipted deleted target without resolving stale Agent execution', () => {
    const accepted = acceptConversationHandoffUiState(
      { hasUnread: false } as ChatUIState,
      undefined,
      {
        predecessorSessionId: 'session-a',
        sessionId: 'session-b',
        currentSessionId: 'session-b',
        outcome: 'existing',
        target: {
          agentId: 'deleted-agent' as never,
          engine: { kind: 'connection', connectionId: 'codex' as never },
          modelId: 'gpt-5',
        },
        carried: [],
        reset: [],
      },
    );

    expect(accepted).toMatchObject({
      agentSlug: 'deleted-agent',
      agentName: 'Deleted Agent (deleted-agent)',
      agentConnectionId: 'codex',
      currentSessionId: 'session-b',
      model: 'gpt-5',
    });
    expect(accepted.provider).toBeUndefined();
  });
});
