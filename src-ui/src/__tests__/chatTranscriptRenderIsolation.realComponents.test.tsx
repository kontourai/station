/**
 * @vitest-environment jsdom
 *
 * Second variant of chatTranscriptRenderIsolation.test.tsx: that test mocks
 * MessageBubble itself, which proves ChatMessageList's own memo boundary
 * holds but says nothing about MessageBubble's or MessageContent's memo
 * boundaries underneath it. This variant uses the REAL MessageBubble and
 * MessageContent (only react-markdown itself is mocked, as a render-count
 * probe on the single most expensive operation named in the archive#726
 * diagnosis — MessageContent re-parsing markdown on every render) so a
 * regression in either component's memoization/prop-stability shows up
 * here even if ChatMessageList's own boundary is intact.
 *
 * ToolCallDisplay's memo effectiveness is NOT covered here — see the
 * "Not verified" note in the delivery report; crafting an independent,
 * reliable render probe for it (without mocking it away, which would defeat
 * the point) needs more than a swapped dependency mock.
 */

import { agentId } from '@kontourai/station-contracts/agent-identity';
import { act, cleanup, render, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

vi.mock('../contexts/AgentsContext', () => ({
  useAgents: () => [],
  // archive#3764: the empty-transcript filler renders `ChatEmptyState`.
  useAgentsLoaded: () => true,
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
vi.mock('../components/chat/StreamingMessage', () => ({
  StreamingMessage: () => <div data-testid="streaming-message">Streaming</div>,
}));
vi.mock('../components/chat/SessionSummaryCard', () => ({
  SessionSummaryCard: () => null,
}));

// The render-count probe: MessageContent (real, memoized) calls the real
// ReactMarkdown for any message with plain text content. A mocked
// react-markdown lets us count how many times markdown actually gets
// (re-)parsed without needing to mock MessageBubble/MessageContent away.
const markdownRenderProbe = vi.fn();
vi.mock('react-markdown', () => ({
  default: ({ children }: { children?: string }) => {
    markdownRenderProbe(children);
    return <div data-testid="markdown-mock">{children}</div>;
  },
}));
vi.mock('remark-gfm', () => ({ default: () => null }));
// MessageRating pulls in @tanstack/react-query hooks (feedback ratings) —
// an unrelated concern to markdown-render isolation, and not worth wiring a
// QueryClientProvider through just to satisfy it.
vi.mock('../components/chat/message-bubble/MessageRating', () => ({
  MessageRating: () => null,
}));

import { ChatMessageList } from '../components/chat/ChatMessageList';
import type { ChatUIState } from '../contexts/ActiveChatsContext';
import {
  ActiveChatsProvider,
  useActiveChatSelector,
} from '../contexts/ActiveChatsContext';
import { activeChatsStore } from '../contexts/active-chats-store';
import type { ChatSession } from '../types';

const SESSION_ID = 'flash-session-real';

const EMPTY_MESSAGES: ChatSession['messages'] = [];
const EMPTY_ATTACHMENTS: ChatSession['attachments'] = [];
const EMPTY_STRING_LIST: string[] = [];

function selectTranscript(state: ChatUIState | null): ChatSession | null {
  if (!state) return null;
  return {
    id: SESSION_ID,
    agentSlug: agentId(state.agentSlug || 'agent-one'),
    agentName: state.agentName || 'Agent One',
    title: '',
    source: 'manual',
    messages: state.messages || EMPTY_MESSAGES,
    input: '',
    attachments: EMPTY_ATTACHMENTS,
    queuedMessages: EMPTY_STRING_LIST,
    inputHistory: EMPTY_STRING_LIST,
    status: state.status || 'idle',
    error: null,
    createdAt: 0,
    updatedAt: 0,
    hasUnread: false,
  };
}

function TranscriptHarness({ sessionId }: { sessionId: string }) {
  const transcriptSession = useActiveChatSelector(sessionId, selectTranscript);
  const input = useActiveChatSelector(sessionId, (state) => state?.input ?? '');

  if (!transcriptSession) return null;
  return (
    <div>
      <span data-testid="input-echo">{input}</span>
      <ChatMessageList
        activeSession={transcriptSession}
        fontSize={13}
        showReasoning
        showToolDetails
      />
    </div>
  );
}

function clearChats() {
  for (const sessionId of Object.keys(activeChatsStore.getSnapshot())) {
    activeChatsStore.removeChat(sessionId);
  }
}

describe('chat transcript render isolation with real MessageBubble/MessageContent (station#726)', () => {
  beforeEach(() => {
    clearChats();
    activeChatsStore.initChat(SESSION_ID, {
      agentSlug: agentId('agent-one'),
      agentName: 'Agent One',
      title: 'Agent One Chat',
    });
    activeChatsStore.updateChat(SESSION_ID, {
      messages: [{ role: 'assistant', content: 'hello there', timestamp: 1 }],
    });
    markdownRenderProbe.mockClear();
  });

  afterEach(() => {
    cleanup();
    clearChats();
  });

  test('composer keystrokes do not re-parse markdown; a message content change does', async () => {
    const { getByTestId } = render(
      <ActiveChatsProvider>
        <TranscriptHarness sessionId={SESSION_ID} />
      </ActiveChatsProvider>,
    );

    // Markdown is intentionally lazy. Wait for its first loading projection
    // to resolve before measuring the memo boundary.
    await act(async () => {
      await vi.dynamicImportSettled();
    });
    await waitFor(() => expect(markdownRenderProbe).toHaveBeenCalledTimes(1));
    expect(markdownRenderProbe).toHaveBeenCalledWith('hello there');

    act(() => {
      activeChatsStore.updateChat(SESSION_ID, { input: 'h' });
    });
    act(() => {
      activeChatsStore.updateChat(SESSION_ID, { input: 'he' });
    });
    act(() => {
      activeChatsStore.updateChat(SESSION_ID, { input: 'hel' });
    });

    expect(getByTestId('input-echo').textContent).toBe('hel');
    // MessageBubble and MessageContent are the REAL components here — if
    // either lost its memoization or a prop it receives lost referential
    // stability, this would tick up on every keystroke.
    expect(markdownRenderProbe).toHaveBeenCalledTimes(1);

    act(() => {
      activeChatsStore.updateChat(SESSION_ID, {
        messages: [
          { role: 'assistant', content: 'hello there', timestamp: 1 },
          { role: 'assistant', content: 'a second reply', timestamp: 2 },
        ],
      });
    });

    // A genuine content change parses only the new row; the unchanged row's
    // memoized renderer stays out of the work.
    await waitFor(() => expect(markdownRenderProbe).toHaveBeenCalledTimes(2));
    expect(markdownRenderProbe).toHaveBeenCalledWith('a second reply');
  });

  test('one live delta reparses none of 4k completed markdown rows', async () => {
    const settled = Array.from({ length: 4_000 }, (_, index) => ({
      id: `settled-${index}`,
      role: 'assistant' as const,
      content: `completed markdown ${index}`,
      timestamp: index,
    }));
    activeChatsStore.updateChat(SESSION_ID, {
      status: 'sending',
      orchestrationTurnOpen: true,
      openTurnId: 'live-turn',
      messages: settled,
      streamingMessage: { role: 'assistant', content: 'a' },
    });

    render(
      <ActiveChatsProvider>
        <TranscriptHarness sessionId={SESSION_ID} />
      </ActiveChatsProvider>,
    );
    await act(async () => {
      await vi.dynamicImportSettled();
    });
    await waitFor(() =>
      expect(markdownRenderProbe.mock.calls.length).toBeGreaterThan(0),
    );
    const initialMarkdownParses = markdownRenderProbe.mock.calls.length;

    act(() => {
      activeChatsStore.updateChat(SESSION_ID, {
        streamingMessage: { role: 'assistant', content: 'ab' },
      });
    });

    expect(markdownRenderProbe).toHaveBeenCalledTimes(initialMarkdownParses);
    expect(initialMarkdownParses).toBeLessThan(100);
  });
});
