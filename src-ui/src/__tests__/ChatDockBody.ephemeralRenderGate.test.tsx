/**
 * @vitest-environment jsdom
 *
 * archive#1292: `EphemeralMessage.test.tsx` renders the `EphemeralMessage`
 * component directly with hand-built props — it never exercises the actual
 * gate that decides whether a transcript message renders as an ephemeral
 * notice at all. That gate is `ChatDockBody`'s `renderOverride`, which used
 * to check `msg.isEphemeral` — a field nothing in the app ever wrote (the
 * store wrote `ephemeral: true`), so a real ephemeral notice fell through to
 * the plain `MessageBubble` path every time. This mounts the real
 * `ChatDockBody` (through the real `ChatMessageList`) with a session whose
 * messages include one carrying `ephemeral: true` and asserts it renders as
 * an `EphemeralMessage` (dismissible, actioned) rather than a plain bubble.
 */

import { agentId } from '@kontourai/station-contracts/agent-identity';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import { describe, expect, test, vi } from 'vitest';

const listPropsRendered = vi.hoisted(() => vi.fn());
const chatActions = vi.hoisted(() => ({
  updateChat: vi.fn(),
  clearEphemeralMessages: vi.fn(),
  addEphemeralMessage: vi.fn(),
}));
vi.mock('../components/chat/ChatMessageList', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../components/chat/ChatMessageList')>();
  return {
    ...actual,
    ChatMessageList: (props: Parameters<typeof actual.ChatMessageList>[0]) => {
      listPropsRendered(props);
      return <actual.ChatMessageList {...props} />;
    },
  };
});

// --- Same mocks ChatMessageList.test.tsx already uses for its own render path ---
vi.mock('@kontourai/station-connect', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@kontourai/station-connect')>()),
  useConnections: () => ({
    activeConnection: { id: 'test', name: 'Test Station' },
    captureCredentialEvidence: () => undefined,
  }),
}));
vi.mock('../contexts/AgentsContext', () => ({
  useAgents: () => [],
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

// archive#1424: ChatDockBody now reads the local operator identity for the
// "Managed by …" row chip — not under test here, so a fixed resolved user.
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

// --- Additional mocks ChatDockBody itself needs ---
vi.mock('../contexts/ActiveChatsContext', () => ({
  useActiveChatActions: () => chatActions,
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

// Not under test here — mocked out to keep this render focused on the
// transcript/ephemeral gate.
vi.mock('../components/chat/ChatInputArea', () => ({
  ChatInputArea: () => <div data-testid="chat-input-area" />,
}));

vi.mock('../components/chat/QueuedMessages', () => ({
  QueuedMessages: () => null,
}));

vi.mock('../components/chat/SystemEventMessage', () => ({
  SystemEventMessage: () => null,
}));

import { ChatDockBody } from '../components/chat-dock/ChatDockBody';
import { chatDraftsStore } from '../contexts/chat-drafts-store';
import type { ChatSession } from '../types';

function buildChatInput(): Parameters<typeof ChatDockBody>[0]['chatInput'] {
  return {
    quotes: [],
    quotedDraftText: '',
    removeQuote: vi.fn(),
    input: '',
    attachments: [],
    attachmentError: null,
    attachmentStages: [],
    sendBlockedReason: undefined,
    attachmentNotice: undefined,
    attachUnavailableReason: undefined,
    removalUnblocksSend: false,
    modelSelectionReason: undefined,
    modelsStale: false,
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
    selectAttachmentFiles: vi.fn(async () => {}),
    replaceAttachmentFile: vi.fn(async () => {}),
    setAttachmentError: vi.fn(),
    retryAttachmentStage: vi.fn(async () => {}),
    cancelAttachmentStage: vi.fn(async () => {}),
    handleAcpSessionModeChange: vi.fn(async () => {}),
    openModelForExecution: vi.fn(),
    handleRestorePortableDraft: vi.fn(),
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
    id: 'render-gate-session',
    agentSlug: agentId('dev-agent'),
    agentName: 'Dev Agent',
    title: 'Render gate chat',
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

describe('ChatDockBody ephemeral render gate (station#1292)', () => {
  test('composer drafts retain quote and new-chat callbacks and invoke current actions', async () => {
    const session = buildSession({
      messages: [
        {
          id: 'question',
          role: 'user',
          content: 'hello',
          contentParts: [{ type: 'text', content: 'hello' }],
        },
      ],
    });
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const onNewChat = vi.fn();
    const input = buildChatInput();
    const setShowStatsPanel = vi.fn();
    const tree = (draft: string, newChat = onNewChat) => (
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
          chatInput={{ ...input, input: draft }}
          setShowStatsPanel={setShowStatsPanel}
          onNewChat={newChat}
        />
      </QueryClientProvider>
    );
    const view = render(tree(''));
    await waitFor(() => expect(listPropsRendered).toHaveBeenCalled());
    const first = listPropsRendered.mock.lastCall![0];
    view.rerender(tree('typed'));
    const next = listPropsRendered.mock.lastCall![0];
    expect(next.onQuote).toBe(first.onQuote);
    expect(next.onNewChatFromMessage).toBe(first.onNewChatFromMessage);
    const quote = {
      version: 1 as const,
      origin: 'http://station.test',
      sessionId: 'source',
      turnId: 'turn',
      messageId: 'answer',
      revision: 'a'.repeat(64),
      excerpt: 'quoted answer',
    };
    next.onQuote(quote);
    expect(chatDraftsStore.getQuotes(session.id)).toContainEqual(quote);
    next.onNewChatFromMessage('quoted question');
    expect(onNewChat).toHaveBeenCalledWith('quoted question');
    const replacement = vi.fn();
    view.rerender(tree('typed again', replacement));
    listPropsRendered.mock.lastCall![0].onNewChatFromMessage(
      'current question',
    );
    expect(replacement).toHaveBeenCalledWith('current question');
  });

  test('a message carrying `ephemeral: true` renders as a dismissible EphemeralMessage, not a plain bubble', async () => {
    const session = buildSession({
      messages: [
        { role: 'user', content: 'hello', timestamp: 1 } as any,
        { role: 'assistant', content: 'hi there', timestamp: 2 } as any,
        {
          role: 'system',
          content: 'Something went wrong: Retry',
          ephemeral: true,
          id: 'ephemeral-1',
          timestamp: 3,
        } as any,
      ],
    });

    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });

    render(
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
          chatInput={buildChatInput()}
          setShowStatsPanel={vi.fn()}
        />
      </QueryClientProvider>,
    );

    // The notice text renders...
    expect(await screen.findByText('Something went wrong: Retry')).toBeTruthy();
    //.through the real EphemeralMessage component (dismiss button present,
    // ephemeral-message styling class applied) rather than as an ordinary
    // MessageBubble, which has no dismiss affordance at all.
    const notice = screen
      .getByText('Something went wrong: Retry')
      .closest('.ephemeral-message');
    expect(notice).toBeTruthy();
    expect(notice?.querySelector('button[title="Dismiss"]')).toBeTruthy();

    // The real messages still render as ordinary bubbles.
    expect(await screen.findByText('hello')).toBeTruthy();
    expect(await screen.findByText('hi there')).toBeTruthy();

    // archive#1424 ("the unpinned owner hop"):
    // ChatDockBody.tsx resolves `owner` from `useAuth` and threads it into
    // `<ChatMessageList owner={owner} />` — asserted here through this
    // file's real (non-overridden) assistant row so deleting that prop at
    // the ChatDockBody call site fails this test, not just a narrower unit
    // that never exercises ChatDockBody's own wiring.
    expect(await screen.findByText(/via /)).toBeTruthy();
  });
});
