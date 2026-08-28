/**
 * @vitest-environment jsdom
 *
 * archive#4080: the `[TURN_INTERRUPTED]` tag-strip
 * branch in `ChatDockBody.tsx` was only covered incidentally (indirectly, by
 * the surrounding `ChatDockBody.*` suites staying green). This mounts the
 * REAL `SystemEventMessage` — same convention as
 * `ChatDockBody.terminalSessionMarker.test.tsx` — against a transcript
 * carrying the exact `[SYSTEM_EVENT] [TURN_INTERRUPTED]...` marker the
 * boot-time interrupted-turn consumer writes, and asserts the raw bracket
 * tag never reaches the user while the human-readable text does. Slice 1 is
 * needs-input-only: no resume/retry affordance is offered for this marker.
 */

import { agentId } from '@kontourai/station-contracts/agent-identity';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import { describe, expect, test, vi } from 'vitest';

vi.mock('@kontourai/station-connect', () => ({
  useConnections: () => ({
    activeConnection: { id: 'test', name: 'Test Station' },
  }),
}));
vi.mock('../contexts/AgentsContext', () => ({
  useAgents: () => [],
  useAgentsLoaded: () => true,
}));

vi.mock('../contexts/ApiBaseContext', () => ({
  useApiBase: () => ({ apiBase: 'http://localhost:3242' }),
}));

vi.mock('../contexts/ToastContext', () => ({
  useToast: () => ({ showToast: vi.fn() }),
}));

vi.mock('../contexts/NavigationContext', () => ({
  useNavigation: () => ({ navigate: vi.fn() }),
}));

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

vi.mock('../contexts/ActiveChatsContext', () => ({
  useActiveChatActions: () => ({
    updateChat: vi.fn(),
    clearEphemeralMessages: vi.fn(),
    addEphemeralMessage: vi.fn(),
  }),
}));

vi.mock('../hooks/useMessageContext', () => ({
  useMessageContext: () => ({ getComposedContext: () => '' }),
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

import { ChatDockBody } from '../components/chat-dock/ChatDockBody';
import type { ChatSession } from '../types';

function buildChatInput() {
  return {
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

function buildSession(overrides: Partial<ChatSession>): ChatSession {
  return {
    id: 'turn-interrupted-session',
    agentSlug: agentId('dev-agent'),
    agentName: 'Dev Agent',
    title: 'Interrupted turn chat',
    source: 'manual',
    input: '',
    attachments: [],
    queuedMessages: [],
    inputHistory: [],
    hasUnread: false,
    status: 'idle',
    createdAt: Date.now(),
    updatedAt: Date.now(),
    messages: [],
    ...overrides,
  };
}

const BANNER_TEXT =
  'Turn interrupted — the process restarted while this turn was in progress.';

function renderDock(session: ChatSession) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
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
        chatInput={buildChatInput() as any}
        setShowStatsPanel={vi.fn()}
      />
    </QueryClientProvider>,
  );
}

describe('ChatDockBody interrupted-turn marker (station#4080 slice 1)', () => {
  test('strips the raw [TURN_INTERRUPTED] tag and shows the human-readable notice', async () => {
    const session = buildSession({
      messages: [
        {
          role: 'user',
          content: 'do the thing',
          timestamp: 1,
        } as any,
        {
          role: 'user',
          content: `[SYSTEM_EVENT] [TURN_INTERRUPTED] ${BANNER_TEXT}`,
          timestamp: 2,
        } as any,
      ],
    });

    renderDock(session);

    expect(await screen.findByText(BANNER_TEXT)).toBeTruthy();
    // The raw bracket tag must never reach the DOM as visible text.
    expect(screen.queryByText(/\[TURN_INTERRUPTED\]/)).toBeNull();
  });

  test('offers no resend/new-chat action for slice 1 (needs-input-only, no auto-resume)', async () => {
    const session = buildSession({
      messages: [
        {
          role: 'user',
          content: 'do the thing',
          timestamp: 1,
        } as any,
        {
          role: 'user',
          content: `[SYSTEM_EVENT] [TURN_INTERRUPTED] ${BANNER_TEXT}`,
          timestamp: 2,
        } as any,
      ],
    });

    renderDock(session);

    await screen.findByText(BANNER_TEXT);
    expect(screen.queryByRole('button', { name: 'Send again' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'New chat' })).toBeNull();
  });
});
