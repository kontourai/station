/**
 * @vitest-environment jsdom
 *
 * archive#1827. `ChatDockBody`'s `[SYSTEM_EVENT] [CHAT_ERROR:code]` marker
 * rendering is the "small UI slice" this ticket asks for: a plain-language
 * headline, the raw engine text behind a disclosure, and a "start fresh
 * session" affordance — reusing the existing `SystemEventMessage` marker +
 * `translateChatError` pattern (archive#191, archive#797) rather than inventing a
 * parallel one. This mounts the REAL `SystemEventMessage` (unlike the
 * sibling render-gate test, which mocks it out) so the rendered action
 * button and disclosure text are asserted for real.
 */

import { agentId } from '@kontourai/station-contracts/agent-identity';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, test, vi } from 'vitest';

vi.mock('@kontourai/station-connect', () => ({
  useConnections: () => ({
    activeConnection: { id: 'test', name: 'Test Station' },
  }),
}));
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

import {
  ChatDockBody,
  findPrecedingUserTurn,
} from '../components/chat-dock/ChatDockBody';
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
    id: 'terminal-session-marker-session',
    agentSlug: agentId('dev-agent'),
    agentName: 'Dev Agent',
    title: 'Terminal session chat',
    source: 'manual',
    input: '',
    attachments: [],
    queuedMessages: [],
    inputHistory: [],
    hasUnread: false,
    status: 'error',
    createdAt: Date.now(),
    updatedAt: Date.now(),
    messages: [],
    ...overrides,
  };
}

const RAW_MESSAGE =
  'No conversation found with session ID: d434e194-cc2e-4edc-8733-d8645c512fab';

function renderDock(session: ChatSession, onNewChat: () => void) {
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
        onNewChat={onNewChat}
      />
    </QueryClientProvider>,
  );
}

describe('ChatDockBody terminal-session marker (station#1827)', () => {
  test('migrates the complete failed turn into a new-chat draft — no "Send again"', async () => {
    const onNewChat = vi.fn();
    const session = buildSession({
      messages: [
        {
          role: 'user',
          content: 'are you still there?',
          timestamp: 1,
        } as any,
        {
          role: 'user',
          content: `[SYSTEM_EVENT] [CHAT_ERROR:engine-session-binding-dead] ${RAW_MESSAGE}`,
          timestamp: 2,
        } as any,
      ],
    });

    renderDock(session, onNewChat);

// Plain-language headline, not the raw prose.
    expect(await screen.findByText(/history is gone/i)).toBeTruthy();
// The raw engine text is present (the disclosure) but not as a heading —
// it renders inside the marker's own body text.
    expect(await screen.findByText(RAW_MESSAGE, { exact: false })).toBeTruthy();

// The recovery affordance is "Start new chat", not "Send again" — a
// dead engine binding cannot be retried into the same thread.
    const actionButton = await screen.findByRole('button', {
      name: 'New chat',
    });
    expect(screen.queryByRole('button', { name: 'Send again' })).toBeNull();

    fireEvent.click(actionButton);
// The recovery is async since archive#3385 — it resolves any attachment
// the failed turn carried before handing the draft on, so that a turn
// whose bytes are gone is refused rather than migrated without them. The
// payload it eventually delivers must still be exactly the old one.
    await waitFor(() =>
      expect(onNewChat).toHaveBeenCalledWith('are you still there?', []),
    );
    expect(onNewChat).toHaveBeenCalledTimes(1);
  });

  test('keeps a terminal turn attachment when deriving its recovery payload', () => {
    const attachment = {
      type: 'file',
      name: 'context.txt',
      mediaType: 'text/plain',
      url: 'data:text/plain;base64,Y29udGV4dA==',
    };

    expect(
      findPrecedingUserTurn(
        [
          {
            role: 'user',
            content: 'continue from this file',
            contentParts: [
              { type: 'text', content: 'continue from this file' },
              attachment,
            ],
          } as any,
          {
            role: 'user',
            content: `[SYSTEM_EVENT] [CHAT_ERROR:engine-session-binding-dead] ${RAW_MESSAGE}`,
          } as any,
        ],
        1,
      ),
    ).toMatchObject({
      text: 'continue from this file',
      attachments: [
        {
          name: attachment.name,
          type: attachment.mediaType,
          data: attachment.url,
        },
      ],
    });
  });

  test('an ordinary [CHAT_ERROR] marker (no code) still offers "Send again" exactly as before', async () => {
    const onNewChat = vi.fn();
    const session = buildSession({
      messages: [
        {
          role: 'user',
          content: 'the message that failed',
          timestamp: 1,
        } as any,
        {
          role: 'user',
          content: '[SYSTEM_EVENT] [CHAT_ERROR] Stream aborted by client',
          timestamp: 2,
        } as any,
      ],
    });

    renderDock(session, onNewChat);

    expect(
      await screen.findByRole('button', { name: 'Send again' }),
    ).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Start new chat' })).toBeNull();
  });

  test('a rejected New chat surfaces its reason instead of dying silently', async () => {
    const { NewChatUnavailableError } = await import(
      '../components/chat-dock/newChatErrors'
    );
    updateChatSpy.mockClear();
    addEphemeralSpy.mockClear();
    const onNewChat = vi
      .fn()
      .mockRejectedValue(
        new NewChatUnavailableError(
          'agent "codex" is not available on this device',
        ),
      );
    const session = buildSession({
      messages: [
        {
          role: 'user',
          content: 'are you still there?',
          timestamp: 1,
        } as any,
        {
          role: 'user',
          content: `[SYSTEM_EVENT] [CHAT_ERROR:engine-session-binding-dead] ${RAW_MESSAGE}`,
          timestamp: 2,
        } as any,
      ],
    });

    renderDock(session, onNewChat);
    fireEvent.click(await screen.findByRole('button', { name: 'New chat' }));

    await waitFor(() =>
      expect(addEphemeralSpy).toHaveBeenCalledWith(session.id, {
        role: 'system',
        content:
          '[SYSTEM_EVENT] Could not start a new chat: agent "codex" is not available on this device',
      }),
    );
  });

  test('a typed new-chat bail routes to the ephemeral message surface, the single error owner', async () => {
    const { NewChatUnavailableError } = await import(
      '../components/chat-dock/newChatErrors'
    );
    addEphemeralSpy.mockClear();
    const onNewChat = vi
      .fn()
      .mockRejectedValue(
        new NewChatUnavailableError(
          'the active conversation has no agent identity to copy from',
        ),
      );
    const session = buildSession({
      messages: [
        {
          role: 'user',
          content: 'are you still there?',
          timestamp: 1,
        } as any,
        {
          role: 'user',
          content: `[SYSTEM_EVENT] [CHAT_ERROR:engine-session-binding-dead] ${RAW_MESSAGE}`,
          timestamp: 2,
        } as any,
      ],
    });
    renderDock(session, onNewChat);
    fireEvent.click(await screen.findByRole('button', { name: 'New chat' }));
    await waitFor(() =>
      expect(addEphemeralSpy).toHaveBeenCalledWith(session.id, {
        role: 'system',
        content:
          '[SYSTEM_EVENT] Could not start a new chat: the active conversation has no agent identity to copy from',
      }),
    );
  });

/**
 * archive#3764: the filler keeps archive#2467's flex fill AND carries the real
* chat empty state. It used to hold a generic `Empty label="No messages
* yet"` — a true sentence that is not the reason nothing can be sent, and
* which made the guided zero-provider rescue unreachable from the dock
* because `ChatMessageList` (the only other renderer of `ChatEmptyState`)
* is mounted only once the transcript already has a message.
*/
  test('an empty conversation renders the flex filler so the composer stays bottom-pinned', () => {
    const session = buildSession({ messages: [] });
    renderDock(session, vi.fn());
    const filler = document.querySelector('.chat-messages--empty');
    expect(filler).toBeTruthy();
    expect(filler?.querySelector('.empty-state')).toBeTruthy();
    expect(screen.getByText('Start a conversation')).toBeTruthy();
    expect(screen.queryByText('No messages yet')).toBeNull();
  });
});
