// @vitest-environment jsdom
/**
 * #2309: the inbox row's running state, RENDERED, read from the same
 * conversation activity record the thread uses. Built as production builds
 * the dock inbox (ChatDock.tsx: `buildHomeTaskItems({ chats: {}, sessions,
 * chatItems: useOpenChats(agents, sessions) })`, where `useOpenChats` is
 * `buildActiveChatTaskItems`).
 */
import { agentId } from '@kontourai/station-contracts/agent-identity';
import type {
  ConversationTurnActivity,
  OrchestrationSessionSummary,
} from '@kontourai/station-contracts/orchestration';
import { render, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ChatDockInboxPanel } from '../components/chat-dock/ChatDockInboxPanel';
import {
  type ChatUIState,
  createDefaultChatState,
} from '../contexts/active-chats-state';
import { deviceSettingsStore } from '../lib/device-settings-store';
import {
  buildActiveChatTaskItems,
  buildHomeTaskItems,
} from '../views/home/home-view-model';

const CONVERSATION = 'claude:conv-inbox-2309';
const CHILD = `${CONVERSATION}:session:child`;
const NOW = Date.parse('2026-09-22T19:00:00.000Z');

const OPEN: ConversationTurnActivity = {
  conversationId: CONVERSATION,
  asOfSequence: 40,
  openTurn: {
    turnId: 'turn-inbox',
    threadId: CHILD,
    startedAt: '2026-09-22T18:55:25.000Z',
  },
};
const CLOSED: ConversationTurnActivity = {
  conversationId: CONVERSATION,
  asOfSequence: 41,
  lastActivityAt: '2026-09-22T18:59:00.000Z',
};

function rows(
  activity: ConversationTurnActivity,
): OrchestrationSessionSummary[] {
  const root: OrchestrationSessionSummary = {
    threadId: CONVERSATION,
    conversationId: CONVERSATION,
    provider: 'claude',
    status: 'running',
    controlMode: 'station-owned',
    lifecycleState: 'running',
    assignedAgentSlug: agentId('claude-code'),
    createdAt: '2026-09-22T18:00:00Z',
    // The idle root is the newest row by updatedAt.
    updatedAt: '2026-09-22T18:58:00Z',
    isLoaded: true,
    isPersisted: true,
    answerability: { answerable: true },
    eventCount: 4,
    hasActiveTurn: false,
    conversationActivity: activity,
  };
  return [
    root,
    {
      ...root,
      threadId: CHILD,
      updatedAt: '2026-09-22T18:55:25Z',
      hasActiveTurn: activity.openTurn !== undefined,
    },
  ];
}

function chat(overrides: Partial<ChatUIState>): ChatUIState {
  return {
    ...createDefaultChatState(
      {
        agentSlug: 'claude-code',
        agentName: 'Claude Code',
        title: 'Lineage inbox chat',
        conversationId: CONVERSATION,
      },
      NOW - 3_600_000,
    ),
    currentSessionId: CONVERSATION,
    orchestrationSessionStarted: true,
    orchestrationStatus: 'running',
    messages: [{ role: 'user', content: 'go', timestamp: NOW - 300_000 }],
    ...overrides,
  };
}

function renderInbox(
  sessions: OrchestrationSessionSummary[],
  chatState: ChatUIState,
) {
  const chatItems = buildActiveChatTaskItems({
    chats: { [CONVERSATION]: chatState },
    agents: [],
    sessions,
  });
  const items = buildHomeTaskItems({
    chats: {},
    sessions,
    agents: [],
    chatItems,
  });
  return render(
    <ChatDockInboxPanel
      items={items}
      activeChatSessionId={null}
      openChatSessionIds={[CONVERSATION]}
      onFocusChat={vi.fn()}
      onOpenConversation={vi.fn()}
      onOpenSession={vi.fn()}
      onCloseChat={vi.fn()}
      onOpenHistory={vi.fn()}
      now={NOW}
    />,
  );
}

describe('#2309 inbox running state from the conversation record', () => {
  beforeEach(() => {
    localStorage.clear();
    deviceSettingsStore.reloadFromStorage();
  });

  it('a turn in a lineage child renders Running, though the newest row is the idle root', () => {
    renderInbox(rows(OPEN), chat({ conversationActivity: OPEN }));
    const active = screen.getByRole('region', { name: 'Active now' });
    // The in-motion chip ('Running' renders as "Active").
    expect(within(active).getByText('Active')).not.toBeNull();
  });

  it('a finished turn does not render Running, though local status still says sending', () => {
    renderInbox(
      rows(CLOSED),
      chat({ status: 'sending', conversationActivity: CLOSED }),
    );
    // The row is still listed (the chat is open), without the in-motion chip.
    expect(
      screen.getByLabelText('Lineage inbox chat, No project'),
    ).not.toBeNull();
    expect(screen.queryByText('Active')).toBeNull();
  });
});
