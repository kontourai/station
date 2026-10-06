/**
 * @vitest-environment jsdom
 *
 * The composer repeats ONE line while a short dock hides the transcript: why
 * the last send did not go. ChatDockBody chooses it from the transcript's
 * ephemeral notices, and only a send-failure notice qualifies — slash-command
 * output and status lines are not failures, and a later accepted send clears it.
 */

import { agentId } from '@kontourai/station-contracts/agent-identity';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, test, vi } from 'vitest';

const agentsMock = vi.hoisted(() => ({ current: [] as any[] }));
const clearEphemeralMessagesSpy = vi.hoisted(() => vi.fn());

vi.mock('@kontourai/station-connect', () => ({
  useConnections: () => ({
    activeConnection: { id: 'test', name: 'Test Station' },
    captureCredentialEvidence: () => undefined,
  }),
}));

vi.mock('../contexts/AgentsContext', () => ({
  useAgents: () => agentsMock.current,
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

const navigateSpy = vi.hoisted(() => vi.fn());
vi.mock('../contexts/NavigationContext', () => {
  // NavigationContext publishes two read hooks: `useNavigation` (subscribes to
  // the store, optionally through a selector) and `useNavigationActions` (the
  // memoized actions, no subscription). This mock answers both from one value.
  const navigation = () => ({ navigate: navigateSpy });
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

vi.mock('../contexts/ActiveChatsContext', () => ({
  useActiveChatActions: () => ({
    updateChat: vi.fn(),
    clearEphemeralMessages: clearEphemeralMessagesSpy,
    addEphemeralMessage: vi.fn(),
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

// The composer's own prop is the seam under test here: which notice ChatDockBody
// hands it. ChatInputArea's rendering of that prop has its own test.
vi.mock('../components/chat/ChatInputArea', () => ({
  ChatInputArea: ({
    sendFailureNotice,
    queuedRetryNotice,
  }: {
    sendFailureNotice?: string;
    queuedRetryNotice?: { text: string; onDiscard: () => void };
  }) => (
    <div
      data-testid="chat-input-area"
      data-send-failure={sendFailureNotice}
      data-queued-retry={queuedRetryNotice?.text}
    >
      {queuedRetryNotice && (
        <button type="button" onClick={queuedRetryNotice.onDiscard}>
          Discard
        </button>
      )}
    </div>
  ),
}));

vi.mock('../components/chat/QueuedMessages', () => ({
  QueuedMessages: () => null,
}));

import {
  ChatDockBody,
  ephemeralAfterQueueDiscard,
  latestQueuedRetryNotice,
  latestSendFailureLine,
} from '../components/chat-dock/ChatDockBody';
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

function buildSession(overrides: Partial<ChatSession> = {}): ChatSession {
  return {
    id: 'pill-session',
    agentSlug: agentId('codex'),
    agentName: 'Codex',
    title: 'Unavailable agent chat',
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
  } as ChatSession;
}

function renderDock(session: ChatSession) {
  agentsMock.current = [
    { slug: agentId('codex'), name: 'Codex', available: true },
  ];
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

const notice = () =>
  screen.getByTestId('chat-input-area').getAttribute('data-send-failure');

const failure = (content: string, timestamp: number) => ({
  role: 'system',
  content,
  timestamp,
  ephemeral: true,
  sendFailure: true,
});
const status = (content: string, timestamp: number) => ({
  role: 'system',
  content,
  timestamp,
  ephemeral: true,
});

describe('latestSendFailureLine', () => {
  test('is the newest send-failure notice, as its bold title row', () => {
    expect(
      latestSendFailureLine([
        failure('**Old failure**\n\nbody', 1),
        failure('**Provider unavailable**\n\nTry again.', 2),
      ]),
    ).toBe('Provider unavailable');
  });

  test('ignores slash-command output and status notices newer than the failure', () => {
    expect(
      latestSendFailureLine([
        failure('**Could not send**', 1),
        status('Model changed to **Selected**', 2),
        status('Slash command **/foo** was sent as user message', 3),
      ]),
    ).toBe('Could not send');
  });

  test('is absent when the only notices are not send failures', () => {
    expect(
      latestSendFailureLine([status('Session mode changed to **plan**', 1)]),
    ).toBeUndefined();
  });

  test('a later accepted send clears it, and a later failure replaces that', () => {
    const user = { role: 'user', content: 'Try again', timestamp: 2 };
    expect(
      latestSendFailureLine([failure('**Could not send**', 1), user]),
    ).toBeUndefined();
    expect(
      latestSendFailureLine([
        failure('**Could not send**', 1),
        user,
        failure('**Still failing**', 3),
      ]),
    ).toBe('Still failing');
  });
});

describe('ChatDockBody send-failure notice', () => {
  test('hands the composer the failure, not the newer slash-command output', async () => {
    renderDock(
      buildSession({
        messages: [
          { role: 'user', content: 'hello', timestamp: 1 },
          failure('**Could not send**\n\nThe engine is offline.', 2),
          status('Model changed to **Selected**', 3),
        ],
      } as Partial<ChatSession>),
    );
    await screen.findByTestId('chat-input-area');
    expect(notice()).toBe('Could not send');
  });

  test('hands the composer nothing for a status notice alone', async () => {
    renderDock(
      buildSession({
        messages: [status('Model changed to **Selected**', 1)],
      } as Partial<ChatSession>),
    );
    await screen.findByTestId('chat-input-area');
    expect(notice()).toBeNull();
  });

  test('clears once a later message is sent', async () => {
    const view = renderDock(
      buildSession({
        messages: [failure('**Could not send**', 1)],
      } as Partial<ChatSession>),
    );
    await screen.findByTestId('chat-input-area');
    expect(notice()).toBe('Could not send');
    view.unmount();
    renderDock(
      buildSession({
        messages: [
          failure('**Could not send**', 1),
          { role: 'user', content: 'again', timestamp: 2 },
        ],
      } as Partial<ChatSession>),
    );
    await screen.findByTestId('chat-input-area');
    expect(notice()).toBeNull();
  });
});

const QUEUED_TEXT = "Send wasn't confirmed — queued to retry automatically";
const queuedRetry = (action = { label: 'Discard', handler: vi.fn() }) => ({
  role: 'system',
  content: QUEUED_TEXT,
  timestamp: 2,
  ephemeral: true,
  queuedRetry: true,
  action,
});

describe('latestQueuedRetryNotice', () => {
  test('is the queued notice and its action, only while the chat is queued', () => {
    const notice = queuedRetry();
    expect(latestQueuedRetryNotice([notice], true)).toEqual({
      line: QUEUED_TEXT,
      action: notice.action,
    });
    expect(latestQueuedRetryNotice([notice], false)).toBeUndefined();
  });

  test('a send failure is not a queued notice, and a queued notice is not a send failure', () => {
    expect(
      latestQueuedRetryNotice([failure('**Could not send**', 1)], true),
    ).toBeUndefined();
    expect(latestSendFailureLine([queuedRetry()])).toBeUndefined();
  });

  test('a later accepted send clears it', () => {
    expect(
      latestQueuedRetryNotice(
        [queuedRetry(), { role: 'user', content: 'again', timestamp: 3 }],
        true,
      ),
    ).toBeUndefined();
  });
});

describe('ChatDockBody queued-retry notice', () => {
  test('hands the composer the notice, and Discard runs the transcript action then drops the notice', async () => {
    const handler = vi.fn();
    clearEphemeralMessagesSpy.mockClear();
    renderDock(
      buildSession({
        status: 'queued',
        messages: [
          { role: 'user', content: 'hello', timestamp: 1 },
          queuedRetry({ label: 'Discard', handler }),
        ],
      } as Partial<ChatSession>),
    );
    const area = await screen.findByTestId('chat-input-area');
    expect(area.getAttribute('data-queued-retry')).toBe(QUEUED_TEXT);
    // The transcript renders its own Discard; this is the composer's.
    fireEvent.click(within(area).getByRole('button', { name: 'Discard' }));
    expect(handler).toHaveBeenCalledOnce();
    expect(clearEphemeralMessagesSpy).toHaveBeenCalledWith('pill-session');
  });

  test('hands the composer nothing once the chat is no longer queued', async () => {
    renderDock(
      buildSession({
        status: 'idle',
        messages: [queuedRetry()],
      } as Partial<ChatSession>),
    );
    const area = await screen.findByTestId('chat-input-area');
    expect(area.getAttribute('data-queued-retry')).toBeNull();
  });
});

describe('ephemeralAfterQueueDiscard', () => {
  type Notice = { content: string; queuedRetry?: boolean };
  const retry: Notice = { queuedRetry: true, content: 'Queued to retry' };
  const failure: Notice = { content: 'Could not send' };
  const command: Notice = { content: 'Conversation Statistics' };

  test('keeps everything while a queued turn remains', () => {
    expect(ephemeralAfterQueueDiscard([retry, failure], 1)).toBeUndefined();
  });

  test('drops only the queued-retry notice once none remains', () => {
    expect(ephemeralAfterQueueDiscard([failure, retry, command], 0)).toEqual([
      failure,
      command,
    ]);
  });

  test('changes nothing when there is no queued-retry notice', () => {
    expect(ephemeralAfterQueueDiscard([failure, command], 0)).toBeUndefined();
  });

  test('leaves an empty list when the notice was the only message', () => {
    expect(ephemeralAfterQueueDiscard([retry], 0)).toEqual([]);
  });
});
