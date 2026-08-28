/**
 * @vitest-environment jsdom
 *
 * Reproduces the archive#726 fix contract end-to-end against the real
 * store, the real selector hook, and the real (memoized) ChatMessageList:
 * a composer keystroke — updateChat(sessionId, { input }) — must not
 * re-render the transcript, while a `messages` update must.
 */

import { agentId } from '@kontourai/station-contracts/agent-identity';
import { act, cleanup, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

vi.mock('../contexts/AgentsContext', () => ({
  useAgents: () => [],
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

// A render-count probe for the transcript row: ChatMessageList (the real,
// memoized component under test) is what decides whether this gets called
// at all, so a call count models "did the transcript row re-render".
const rowRenderProbe = vi.fn();
vi.mock('../components/chat/MessageBubble', () => ({
  MessageBubble: (props: { msg: { content: string }; anchorKey?: string }) => {
    rowRenderProbe(props.msg.content);
    return <div data-testid="row" data-chat-message-key={props.anchorKey} />;
  },
}));

import { ChatMessageList } from '../components/chat/ChatMessageList';
import type { ChatUIState } from '../contexts/ActiveChatsContext';
import {
  ActiveChatsProvider,
  useActiveChatSelector,
} from '../contexts/ActiveChatsContext';
import { activeChatsStore } from '../contexts/active-chats-store';
import type { ChatSession } from '../types';

const SESSION_ID = 'flash-session';

// Stable references for fields the transcript never reads. A fresh `[]`
// literal on every selector invocation would itself defeat the selector's
// shallow-equality check (this is the same mistake the fix guards against
// in production — see ACPChatPanel's EMPTY_ATTACHMENTS/EMPTY_STRING_LIST).
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

/**
 * Mirrors ACPChatPanel's shape: a transcript-only selector subscription
 * feeding the memoized ChatMessageList, plus a separate composer-only
 * selector (standing in for useChatInput) that forces *this* harness
 * component to re-render on every keystroke — exactly like the real panel.
 */
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

describe('chat transcript render isolation (station#726)', () => {
  beforeEach(() => {
    clearChats();
    activeChatsStore.initChat(SESSION_ID, {
      agentSlug: agentId('agent-one'),
      agentName: 'Agent One',
      title: 'Agent One Chat',
    });
    activeChatsStore.updateChat(SESSION_ID, {
      messages: [{ role: 'user', content: 'hello', timestamp: 1 }],
    });
    rowRenderProbe.mockClear();
  });

  afterEach(() => {
    cleanup();
    clearChats();
  });

  test('composer keystrokes do not re-render the transcript row; a messages update does', () => {
    const { getByTestId } = render(
      <ActiveChatsProvider>
        <TranscriptHarness sessionId={SESSION_ID} />
      </ActiveChatsProvider>,
    );

    // Mounting renders the one existing row once.
    expect(rowRenderProbe).toHaveBeenCalledTimes(1);

    act(() => {
      activeChatsStore.updateChat(SESSION_ID, { input: 'h' });
    });
    act(() => {
      activeChatsStore.updateChat(SESSION_ID, { input: 'he' });
    });
    act(() => {
      activeChatsStore.updateChat(SESSION_ID, { input: 'hel' });
    });

    // The composer-facing selector still reflects every keystroke...
    expect(getByTestId('input-echo').textContent).toBe('hel');
    //...but none of them re-rendered the memoized transcript row. This is
    // the archive#726 regression: without the selector split + memoization,
    // each of these three keystrokes would re-render (and re-parse markdown
    // for) every transcript row.
    expect(rowRenderProbe).toHaveBeenCalledTimes(1);

    act(() => {
      activeChatsStore.updateChat(SESSION_ID, {
        messages: [
          { role: 'user', content: 'hello', timestamp: 1 },
          { role: 'assistant', content: 'hi there', timestamp: 2 },
        ],
      });
    });

    // A genuine transcript change (a new message) does re-render — 1 more
    // ChatMessageList render over 2 rows = 2 additional probe calls.
    expect(rowRenderProbe).toHaveBeenCalledTimes(3);
    expect(rowRenderProbe).toHaveBeenCalledWith('hi there');
  });
});
