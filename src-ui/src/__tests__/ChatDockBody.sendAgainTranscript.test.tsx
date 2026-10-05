/**
 * @vitest-environment jsdom
 *
 * #3112. "Send again" on a failure card resends the turn the card belongs to.
 * With the event-window transcript enabled, the rows `ChatMessageList` renders
 * (and the index it hands `renderOverride`) come from that projection, while
 * `activeSession.messages` is the stored conversation — which for a Station
 * agent also holds the model-facing copy of the input, ambient context and
 * all. The retried text must come from the rendered list, so it is exactly
 * what the user typed.
 */

import { agentId } from '@kontourai/station-contracts/agent-identity';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, test, vi } from 'vitest';

vi.mock('@kontourai/station-connect', () => ({
  useConnections: () => ({
    activeConnection: { id: 'test', name: 'Test Station' },
    captureCredentialEvidence: () => undefined,
  }),
}));
vi.mock('../contexts/AgentsContext', () => ({
  useAgents: () => [],
  // archive#3764: the empty-transcript filler renders `ChatEmptyState`.
  useAgentsLoaded: () => true,
}));

vi.mock('../contexts/ApiBaseContext', () => ({
  useApiBase: () => ({ apiBase: 'http://localhost:3242' }),
  useHostRequestAuthorityScope: () => undefined,
}));

vi.mock('../contexts/ToastContext', () => ({
  useToast: () => ({ showToast: vi.fn() }),
}));

vi.mock('../contexts/NavigationContext', () => {
  // NavigationContext publishes two read hooks: `useNavigation` (subscribes to
  // the store, optionally through a selector) and `useNavigationActions` (the
  // memoized actions, no subscription). This mock answers both from one value.
  const navigation = () => ({ navigate: vi.fn() });
  return {
    useNavigation: (
      selector?: (state: ReturnType<typeof navigation>) => unknown,
    ) => (selector ? selector(navigation()) : navigation()),
    useNavigationActions: navigation,
  };
});

vi.mock('../contexts/AuthContext', () => ({
  useAuth: () => ({ user: { alias: 'operator' } }),
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

vi.mock('../components/icons/UserIcon', () => ({
  UserIcon: () => <span aria-hidden="true">U</span>,
}));

const updateChatSpy = vi.hoisted(() => vi.fn());
const clearEphemeralSpy = vi.hoisted(() => vi.fn());
const addEphemeralSpy = vi.hoisted(() => vi.fn());
vi.mock('../contexts/ActiveChatsContext', () => ({
  useActiveChatActions: () => ({
    updateChat: updateChatSpy,
    clearEphemeralMessages: clearEphemeralSpy,
    addEphemeralMessage: addEphemeralSpy,
  }),
}));

vi.mock('../contexts/MessageContextContext', () => ({
  useMessageContextContext: () => ({ getComposedContext: () => '' }),
}));

vi.mock('../hooks/useACPConnections', () => ({
  useACPConnections: () => ({ data: [] }),
}));
vi.mock('../hooks/useShareReceiver', () => ({
  useShareReceiver: () => {},
}));

vi.mock('../hooks/useSTT', () => ({
  useSTT: () => ({
    supported: false,
    state: 'idle',
    transcript: '',
    startListening: vi.fn(),
    stopListening: vi.fn(),
  }),
}));

vi.mock('../hooks/useTTS', () => ({
  useTTS: () => ({
    supported: false,
    speaking: false,
    speak: vi.fn(),
    cancel: vi.fn(),
  }),
}));

vi.mock('../components/chat/ChatInputArea', () => ({
  ChatInputArea: () => <div data-testid="chat-input-area" />,
}));

vi.mock('../components/chat/QueuedMessages', () => ({
  QueuedMessages: () => null,
}));

const PROMPT = 'Summarize the quarterly ledger, please.';
const MARKER =
  '[SYSTEM_EVENT] [CHAT_ERROR] The model provider returned an error (HTTP 500).';

/**
 * The bounded event-window projection for one failed turn: its `turn.started`
 * prompt as the user row, then the stored failure marker adopted onto the
 * turn — the shape `useActiveChatTranscript` hands the dock on a cold open.
 */
const projectedTranscript = vi.hoisted(() => ({ messages: [] as unknown[] }));
vi.mock('../hooks/orchestration/useActiveChatTranscript', () => ({
  useActiveChatTranscript: () => ({
    enabled: true,
    messages: projectedTranscript.messages,
    events: [],
    hasMore: false,
    loading: false,
    settled: true,
    catchingUp: false,
    openTurnProjected: false,
    upgradeRequired: false,
    loadOlder: vi.fn(async () => {}),
    reload: vi.fn(async () => {}),
  }),
}));

import { ChatDockBody } from '../components/chat-dock/ChatDockBody';
import { PreviewProvider } from '../contexts/PreviewContext';
import type { ChatSession } from '../types';

function buildChatInput() {
  return {
    quotes: [],
    quotedDraftText: '',
    removeQuote: vi.fn(),
    input: '',
    attachments: [],
    textareaRef: { current: null },
    currentModel: undefined,
    canModelSelect: false,
    modelQuery: null,
    commandQuery: null,
    slashCommands: [],
    handleInputChange: vi.fn(),
    handleSend: vi.fn(async () => {}),
    handleCancel: vi.fn(),
    handleClearInput: vi.fn(),
    handleAddAttachments: vi.fn(),
    handleRemoveAttachment: vi.fn(),
    handleClearAttachments: vi.fn(),
    handleModelSelect: vi.fn(),
    handleModelReset: vi.fn(),
    handleModelClose: vi.fn(),
    handleModelOpen: vi.fn(),
    handleModelRuntimeOptionChange: vi.fn(),
    handleApprovalModeChange: vi.fn(),
    handleCommandSelect: vi.fn(async () => {}),
    handleCommandClose: vi.fn(),
    handleHistoryUp: vi.fn(),
    handleHistoryDown: vi.fn(),
    updateFromInput: vi.fn(),
    closeAll: vi.fn(),
  };
}

describe('ChatDockBody Send again with the transcript projection (#3112)', () => {
  test('resends the rendered turn, not the stored model-facing copy at the same index', async () => {
    projectedTranscript.messages = [
      {
        id: 'turn-1-user',
        role: 'user',
        content: PROMPT,
        contentParts: [{ type: 'text', content: PROMPT }],
        turnId: 'turn-1',
        timestamp: 1,
      },
      {
        role: 'user',
        content: MARKER,
        turnId: 'turn-1',
        timestamp: 3,
      },
    ];
    // What `GET /agents/:slug/conversations/:id/messages` returns for that
    // failed Station-agent turn: the framework's copy of the composed model
    // input, its empty reply, the typed text the failure path re-persisted,
    // and the marker.
    const session: ChatSession = {
      id: 'send-again-transcript-session',
      agentSlug: agentId('dev-agent'),
      agentName: 'Dev Agent',
      title: 'Send again chat',
      source: 'manual',
      input: '',
      attachments: [],
      queuedMessages: [],
      inputHistory: [],
      hasUnread: false,
      status: 'error',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      orchestrationSessionStarted: true,
      messages: [
        {
          role: 'user',
          content: `[Timezone: Pacific/Chatham]\n${PROMPT}`,
          timestamp: 1,
        },
        { role: 'assistant', content: '', timestamp: 2 },
        { role: 'user', content: PROMPT, timestamp: 2 },
        { role: 'user', content: MARKER, timestamp: 3 },
      ] as ChatSession['messages'],
    };
    const chatInput = buildChatInput();
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    render(
      <QueryClientProvider client={queryClient}>
        <PreviewProvider>
          <ChatDockBody
            activeSession={session}
            chatFontSize={14}
            dockHeight={400}
            showStatsPanel={false}
            showReasoning={false}
            showToolDetails={false}
            modelSupportsAttachments={false}
            fileAttachmentsSupported={false}
            availableModels={[]}
            chatInput={chatInput as any}
            setShowStatsPanel={vi.fn()}
            onNewChat={vi.fn()}
          />
        </PreviewProvider>
      </QueryClientProvider>,
    );

    fireEvent.click(
      await screen.findByRole(
        'button',
        { name: 'Send again' },
        { timeout: 5_000 },
      ),
    );

    await waitFor(() => expect(chatInput.handleSend).toHaveBeenCalledTimes(1));
    expect(chatInput.handleSend).toHaveBeenCalledWith(PROMPT, []);
  });
});
