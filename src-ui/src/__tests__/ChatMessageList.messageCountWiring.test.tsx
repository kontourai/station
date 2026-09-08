/**
 * @vitest-environment jsdom
 *
 * `MessageBubble` stopped receiving the session and started receiving eight
 * fields, two of which are counts rather than the arrays they came from. A row
 * decides it is the last one with `idx === activeSession.messageCount - 1`,
 * and only the last assistant row draws the live-turn affordances — so if the
 * list handed down a count that was not `messages.length`, those affordances
 * would attach to the wrong row or to none, and every memoisation test would
 * still pass.
 *
 * This renders the REAL `MessageBubble` through the REAL list, so the count is
 * asserted where it is consumed rather than where it is built.
 */

import { agentId } from '@kontourai/station-contracts/agent-identity';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import type { ReactElement } from 'react';
import { describe, expect, test, vi } from 'vitest';

vi.mock('../contexts/AgentsContext', () => ({
  useAgents: () => [{ slug: 'dev-agent', name: 'Dev Agent' }],
}));
vi.mock('../contexts/ApiBaseContext', () => ({
  useApiBase: () => ({ apiBase: 'http://localhost:3242' }),
}));
vi.mock('../contexts/ToastContext', () => ({
  useToast: () => ({ showToast: vi.fn() }),
}));
vi.mock('../hooks/useToolApproval', () => ({
  useToolApproval: () => vi.fn(),
}));
vi.mock('../hooks/useActiveChatSessions', () => ({
  useSendMessage: () => vi.fn(),
}));
vi.mock('../components/icons/UserIcon', () => ({
  UserIcon: () => <span aria-hidden="true">U</span>,
}));
vi.mock('../components/chat/StreamingMessage', () => ({
  StreamingMessage: () => <div data-testid="streaming-message" />,
  SmoothStreamingMessage: () => <div data-testid="streaming-message" />,
}));

import { ChatMessageList } from '../components/chat/ChatMessageList';

function renderWithQueryClient(ui: ReactElement) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>{ui}</QueryClientProvider>,
  );
}

const MESSAGES = [
  {
    role: 'user' as const,
    content: 'the question',
    timestamp: '2026-01-01T00:00:00.000Z',
  },
  {
    role: 'assistant' as const,
    content: 'the answer in progress',
    timestamp: '2026-01-01T00:00:01.000Z',
  },
];

function listFor(messages: typeof MESSAGES) {
  return (
    <ChatMessageList
      activeSession={
        {
          id: 'count-session',
          agentSlug: agentId('dev-agent'),
          agentName: 'Dev Agent',
          title: 'Count chat',
          input: '',
          attachments: [],
          queuedMessages: [],
          inputHistory: [],
          hasUnread: false,
          status: 'idle',
          createdAt: 0,
          updatedAt: 0,
          source: 'manual',
          messages,
          isThinking: true,
          pendingApprovals: [{ id: 'a' }, { id: 'b' }, { id: 'c' }],
          // biome-ignore lint/suspicious/noExplicitAny: the list's prop type is the full ChatSession
        } as any
      }
      fontSize={14}
      showReasoning={false}
      showToolDetails={false}
    />
  );
}

describe('ChatMessageList message-count wiring', () => {
  test('the last assistant row is the one the transcript length names', () => {
    renderWithQueryClient(listFor(MESSAGES));

    // Only the last assistant row renders these, and only `messageCount`
    // decides which row that is.
    expect(screen.getByText(/Awaiting tool approval/)).toBeTruthy();
    expect(screen.getByText(/\(3\)/)).toBeTruthy();
  });

  test('a longer transcript moves the affordance to the new last row', () => {
    const withFollowUp = [
      ...MESSAGES,
      {
        role: 'user' as const,
        content: 'a follow-up',
        timestamp: '2026-01-01T00:00:02.000Z',
      },
    ];
    renderWithQueryClient(listFor(withFollowUp));

    // The last row is now a USER message, which draws no live-turn
    // affordance — so a stale count stuck at 2 would still be rendering one.
    expect(screen.queryByText(/Awaiting tool approval/)).toBeNull();
  });
});
