/**
 * @vitest-environment jsdom
 *
 * A `busy` open resolution is an authoritative wait on the active turn, and
 * only three things re-prove it: the terminal turn event (turnHandlers), a
 * child change (snapshotHandlers), or a reload (hydrate seeds pending). Miss
 * the terminal — a backgrounded phone across a long turn — and the composer
 * sits draft-only with Send dead: `recoveryOpen` owns Retry + Start new,
 * `resolvingOpen` owns Start new, `busy` owned nothing.
 *
 * Every test here is that stuck shape: a resolved-canContinue-false
 * resolution with no turn in flight locally, the exact state a missed
 * `turn.completed` leaves behind.
 */

import { agentId } from '@kontourai/station-contracts/agent-identity';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, test, vi } from 'vitest';

const agentsMock = vi.hoisted(() => ({ current: [] as any[] }));
const transcriptMock = vi.hoisted(() => ({
  events: [] as any[],
  enabled: false,
  settled: true,
  messages: [] as any[],
}));
const chatInputPropsMock = vi.hoisted(() => ({
  current: null as Record<string, any> | null,
}));
const queuedMessagesPropsMock = vi.hoisted(() => ({
  current: null as Record<string, any> | null,
}));
const realControlsMock = vi.hoisted(() => ({ enabled: false }));
const steerOrchestrationTurnMock = vi.hoisted(() => vi.fn());

vi.mock('@kontourai/station-sdk', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@kontourai/station-sdk')>()),
  steerOrchestrationTurn: (...args: unknown[]) =>
    steerOrchestrationTurnMock(...args),
}));

vi.mock('@kontourai/station-connect', () => ({
  useConnections: () => ({
    activeConnection: { id: 'test', name: 'Test Station' },
    captureCredentialEvidence: () => undefined,
  }),
}));

vi.mock('../contexts/AgentsContext', () => ({
  useAgents: () => agentsMock.current,
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

vi.mock('../contexts/ActiveChatsContext', () => ({
  useActiveChatActions: () => ({
    updateChat: vi.fn(),
    clearEphemeralMessages: vi.fn(),
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

vi.mock('../hooks/orchestration/useActiveChatTranscript', () => ({
  useActiveChatTranscript: () => ({
    enabled: transcriptMock.enabled,
    messages: transcriptMock.messages,
    events: transcriptMock.events,
    hasMore: false,
    loading: false,
    settled: transcriptMock.settled,
    upgradeRequired: false,
    loadOlder: vi.fn(async () => {}),
    reload: vi.fn(async () => {}),
  }),
}));

vi.mock('../components/chat/ChatInputArea', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../components/chat/ChatInputArea')>();
  return {
    ChatInputArea: (props: Record<string, any>) => {
      chatInputPropsMock.current = props;
      const Actual = actual.ChatInputArea;
      return realControlsMock.enabled ? (
        <Actual {...(props as React.ComponentProps<typeof Actual>)} />
      ) : (
        <div data-testid="chat-input-area" />
      );
    },
  };
});

vi.mock('../components/chat/QueuedMessages', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../components/chat/QueuedMessages')>();
  return {
    QueuedMessages: (props: Record<string, any>) => {
      queuedMessagesPropsMock.current = props;
      const Actual = actual.QueuedMessages;
      return realControlsMock.enabled ? (
        <Actual {...(props as React.ComponentProps<typeof Actual>)} />
      ) : (
        <div data-testid="queued-messages" />
      );
    },
  };
});

import { ChatDockBody } from '../components/chat-dock/ChatDockBody';
import type { ChatSession } from '../types';

/** The stale wait: resolved, refused, still naming the finished turn. */
function busyResolution() {
  return {
    status: 'resolved',
    conversation: {
      id: 'thread-busy',
      source: 'runtime',
      agentSlug: 'codex',
      title: 'A chat whose turn finished elsewhere',
      createdAt: '2026-09-26T15:37:35.489Z',
      updatedAt: '2026-09-26T16:05:20.145Z',
      messageCount: 2,
      mutable: false,
      answerability: { answerable: true },
    },
    currentSessionId: 'thread-busy',
    transcript: { available: true, owner: 'runtime', messageCount: 2 },
    canContinue: false,
    continuationPending: true,
    answerability: { answerable: true },
    recoveryActions: [],
  } as any;
}

function buildChatInput() {
  return {
    quotes: [],
    quotedDraftText: '',
    removeQuote: vi.fn(),
    input: 'a drafted follow-up',
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
    id: 'thread-busy',
    agentSlug: agentId('codex'),
    agentName: 'Codex',
    title: 'A chat whose turn finished elsewhere',
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

function renderDock({
  session = buildSession({
    conversationOpenState: busyResolution(),
  }),
  onRetryConversationOpen,
  omitRetry = false,
}: {
  session?: ChatSession;
  onRetryConversationOpen?: () => void;
  omitRetry?: boolean;
} = {}) {
  transcriptMock.events = [];
  agentsMock.current = [{ slug: agentId('codex'), name: 'Codex' }];
  const retryHandler = omitRetry
    ? undefined
    : (onRetryConversationOpen ?? vi.fn());
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <ChatDockBody
        activeSession={session}
        activeOrchestrationSession={null}
        activeOrchestrationSessionRead="absent"
        onRetryOrchestrationSessions={vi.fn()}
        onRetryConversationOpen={retryHandler}
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

describe('ChatDockBody stale busy wait', () => {
  beforeEach(() => {
    agentsMock.current = [];
    transcriptMock.events = [];
    transcriptMock.enabled = false;
    transcriptMock.settled = true;
    transcriptMock.messages = [];
    chatInputPropsMock.current = null;
    queuedMessagesPropsMock.current = null;
    realControlsMock.enabled = false;
    steerOrchestrationTurnMock.mockReset();
  });

  test('the reported shape stays draftable with Send dead', () => {
    renderDock();
    expect(chatInputPropsMock.current?.disabled).toBe(true);
    expect(chatInputPropsMock.current?.allowDraftWhileDisabled).toBe(true);
    // No Stop/Queue takeover: nothing is in flight locally.
    expect(chatInputPropsMock.current?.turnInFlight).toBe(false);
  });

  test('a busy wait with no turn in flight offers Check again', () => {
    const onRetryConversationOpen = vi.fn();
    renderDock({ onRetryConversationOpen });
    expect(screen.getByText(/still waiting on the active turn/i)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Check again' }));
    expect(onRetryConversationOpen).toHaveBeenCalledOnce();
  });

  test('a live wait keeps draft-only with no Check again', () => {
    renderDock({
      session: buildSession({
        status: 'sending',
        conversationOpenState: busyResolution(),
      }),
    });
    expect(chatInputPropsMock.current?.turnInFlight).toBe(true);
    expect(screen.queryByRole('button', { name: 'Check again' })).toBeNull();
  });

  test('no wait notice on a writable chat', () => {
    renderDock({ session: buildSession() });
    expect(screen.queryByRole('button', { name: 'Check again' })).toBeNull();
    expect(chatInputPropsMock.current?.disabled).toBe(false);
  });

  test('no dead control when there is no retry handler', () => {
    renderDock({ omitRetry: true });
    expect(screen.getByText(/still waiting on the active turn/i)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Check again' })).toBeNull();
  });

  test('the stale wait names the way out in the composer', () => {
    realControlsMock.enabled = true;
    renderDock();
    expect(
      screen.getByPlaceholderText(
        'Waiting on this chat — check again above to send…',
      ),
    ).toBeTruthy();
  });

  test('the live wait still promises drafting', () => {
    realControlsMock.enabled = true;
    renderDock({
      session: buildSession({
        status: 'sending',
        conversationOpenState: busyResolution(),
      }),
    });
    expect(
      screen.getByPlaceholderText(
        'Draft a follow-up while this turn finishes…',
      ),
    ).toBeTruthy();
  });
});
