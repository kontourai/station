/**
 * @vitest-environment jsdom
 *
 * #2423: the full-access notice through the path the dock actually uses —
 * the store's chat state → `useDerivedSessions` (`deriveSession` builds the
 * `ChatSession` field by field) → `ChatMessageList` → the notice. The state
 * is reached through the real orchestration event fold. A field the
 * derivation drops never reaches the dock, however right the fold is.
 */

import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

vi.mock('../contexts/AgentsContext', () => ({
  useAgents: () => STABLE_AGENTS,
  useAgentsLoaded: () => true,
}));
vi.mock('../contexts/ApiBaseContext', () => ({
  useApiBase: () => ({ apiBase: 'http://localhost:3242' }),
}));
vi.mock('../contexts/ToastContext', () => ({
  useToast: () => ({ showToast: vi.fn(), dismissToast: vi.fn() }),
}));
vi.mock('../hooks/useActiveChatSessions', () => ({
  useSendMessage: () => vi.fn(),
}));
vi.mock('../components/chat/SessionSummaryCard', () => ({
  SessionSummaryCard: () => null,
}));
// The empty transcript's own surface (system status) is unrelated here.
vi.mock('../components/chat/ChatEmptyState', () => ({
  ChatEmptyState: () => null,
}));
vi.mock('../hooks/orchestration/useSessionEventWindow', () => ({
  useSessionEventWindow: () => ({
    events: [],
    handoffs: [],
    contextBoundaries: [],
    hasMore: false,
    loadOlder: () => undefined,
    reload: () => undefined,
    upgradeRequired: false,
    loading: false,
    settled: true,
    error: undefined,
  }),
}));

const STABLE_AGENTS = vi.hoisted(() => [
  { slug: 'claude', name: 'Claude Code' },
]);

import { ChatMessageList } from '../components/chat/ChatMessageList';
import { ActiveChatsProvider } from '../contexts/ActiveChatsContext';
import { activeChatsStore } from '../contexts/active-chats-store';
import { handleOrchestrationEvent } from '../hooks/orchestration/eventHandlers';
import { useDerivedSessions } from '../hooks/useDerivedSessions';

const CHAT = 'full-access-notice-chat';
const FRESH = 'full-access-notice-fresh';
const ROOT = 'full-access-root';
const CHILD = 'full-access-child';
const NOTICE = /Full access didn't carry over to this new session/;

let position = 5000;
function fold(threadId: string, event: Record<string, unknown>) {
  handleOrchestrationEvent(
    'http://localhost:3242',
    {
      provider: 'claude',
      threadId,
      createdAt: '2026-09-24T00:00:00.000Z',
      ...event,
    } as Parameters<typeof handleOrchestrationEvent>[1],
    undefined,
    undefined,
    ++position,
  );
}

function DockTranscript({ chatId }: { chatId: string }) {
  const session = useDerivedSessions('', null, null).find(
    (candidate) => candidate.id === chatId,
  );
  if (!session) return null;
  return (
    <ChatMessageList
      activeSession={session}
      fontSize={13}
      showReasoning={false}
      showToolDetails={false}
    />
  );
}

function mount(chatId: string) {
  return render(
    <ActiveChatsProvider>
      <DockTranscript chatId={chatId} />
    </ActiveChatsProvider>,
  );
}

function initClaudeChat(chatId: string) {
  activeChatsStore.initChat(chatId, {
    agentSlug: 'claude',
    agentName: 'Claude Code',
    title: 'Full access notice',
  });
  activeChatsStore.updateChat(chatId, {
    agentConnectionId: 'claude',
    provider: 'claude',
    executionMode: 'external',
  });
}

describe('#2423 full-access notice, mounted through the dock derivation', () => {
  beforeEach(() => {
    for (const id of [CHAT, FRESH]) activeChatsStore.removeChat(id);
  });
  afterEach(() => {
    cleanup();
    for (const id of [CHAT, FRESH]) activeChatsStore.removeChat(id);
  });

  test('never confirmed on the root, then a new session at Ask: the dock shows the notice', () => {
    initClaudeChat(CHAT);
    activeChatsStore.updateChat(CHAT, {
      conversationId: 'full-access-conversation',
      currentSessionId: ROOT,
      orchestrationSessionStarted: true,
      pendingApprovalMode: 'never',
    });
    // The root reports full access applied: the pick is confirmed there.
    fold(ROOT, {
      method: 'turn.started',
      turnId: 'root-1',
      metadata: { approvalMode: 'never' },
    });
    expect(activeChatsStore.getSnapshot()[CHAT]?.approvalModeOverride).toBe(
      'never',
    );
    // The next send is receipted as a new child Session (as the dispatcher
    // records it), which reports Claude's init posture.
    activeChatsStore.updateChat(CHAT, { currentSessionId: CHILD });
    fold(CHILD, {
      method: 'session.configured',
      sessionId: CHILD,
      metadata: { approvalMode: 'ask' },
    });

    mount(CHAT);
    expect(screen.getByText(NOTICE)).toBeTruthy();
  });

  test('a fresh chat with no session and no pick: the dock shows no notice', () => {
    initClaudeChat(FRESH);
    mount(FRESH);
    expect(screen.queryByText(NOTICE)).toBeNull();
  });
});
