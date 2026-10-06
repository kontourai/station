/**
 * @vitest-environment jsdom
 *
 * archive#3213. The chat dock had NO failure surface. Its only failure
 * rendering was `turnHandlers.ts`'s append of a LIVE `runtime.error` into the
 * streaming bubble, so a user who reached an already-failed session any way
 * other than watching it die — a project deep link, a tab switch, resuming
 * from history, the project page's live-work section — got a chat pane with
 * no indication anything had gone wrong, above a composer that looked fine.
 *
 * Cold-arrival cases reproduce that missing failure surface. Composer cases
 * also exercise live delivery and terminal stream transitions.
 */

import { agentId } from '@kontourai/station-contracts/agent-identity';
import { SERVER_EVENTS } from '@kontourai/station-contracts/runtime-events';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { activeChatsStore } from '../contexts/active-chats-store';

const nativeRaceTransport = vi.hoisted(() => ({
  onMessage: null as
    | null
    | ((frame: { event: string; data: string; id?: string }) => void),
  dispatch: vi.fn(async (_input: Record<string, unknown>) => ({})),
}));
vi.mock('../lib/foregroundMessageDispatch', () => ({
  dispatchForeground: nativeRaceTransport.dispatch,
}));

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
const realQueueControlsMock = vi.hoisted(() => ({ enabled: false }));
const steerOrchestrationTurnMock = vi.hoisted(() => vi.fn());
const inspectOrchestrationSteerInputMock = vi.hoisted(() => vi.fn());

vi.mock('@kontourai/station-sdk', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@kontourai/station-sdk')>()),
  inspectOrchestrationSteerInput: (...args: unknown[]) =>
    inspectOrchestrationSteerInputMock(...args),
  fetchSSE: (
    _url: string,
    options: {
      onMessage: (frame: { event: string; data: string; id?: string }) => void;
    },
  ) => {
    nativeRaceTransport.onMessage = options.onMessage;
    return {
      close: vi.fn(),
      signal: new AbortController().signal,
      completed: new Promise<void>(() => {}),
      retry: vi.fn(),
    };
  },
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
  // archive#3764: the empty-transcript filler renders `ChatEmptyState`.
  useAgentsLoaded: () => true,
}));

vi.mock('../contexts/ApiBaseContext', () => ({
  useApiBase: () => ({ apiBase: 'http://localhost:3242' }),
  useHostRequestAuthorityScope: () => undefined,
}));

vi.mock('../contexts/ToastContext', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../contexts/ToastContext')>()),
  useToast: () => ({ showToast: vi.fn() }),
}));

vi.mock('../contexts/NavigationContext', async (importOriginal) => {
  // NavigationContext publishes two read hooks: `useNavigation` (subscribes to
  // the store, optionally through a selector) and `useNavigationActions` (the
  // memoized actions, no subscription). This mock answers both from one value.
  const navigation = () => ({ navigate: vi.fn() });
  return {
    ...(await importOriginal<typeof import('../contexts/NavigationContext')>()),
    useNavigation: (
      selector?: (state: ReturnType<typeof navigation>) => unknown,
    ) => (selector ? selector(navigation()) : navigation()),
    useNavigationActions: navigation,
  };
});

vi.mock('../contexts/AuthContext', () => ({
  useAuth: () => ({ user: { alias: 'operator' } }),
}));

vi.mock('../contexts/ActiveChatsContext', async () => {
  const { activeChatsStore } = await import('../contexts/active-chats-store');
  return {
    useActiveChatActions: () => ({
      removeQueuedMessage:
        activeChatsStore.removeQueuedMessage.bind(activeChatsStore),
      editQueuedMessage:
        activeChatsStore.editQueuedMessage.bind(activeChatsStore),
      reorderQueuedMessage:
        activeChatsStore.reorderQueuedMessage.bind(activeChatsStore),
      updateChat: vi.fn(),
      clearEphemeralMessages: vi.fn(),
      addEphemeralMessage: vi.fn(),
    }),
  };
});

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

/**
 * The bounded event window this pane already loads. Mocked so a test can
 * place a real `runtime.error` in it — that is the channel the shared fold
 * prefers, and the only way to prove the dock reads the fold's PREFERRED
 * source rather than just the session record it was handed.
 */
vi.mock('../hooks/orchestration/useActiveChatTranscript', () => ({
  useActiveChatTranscript: () => ({
    enabled: transcriptMock.enabled,
    messages: transcriptMock.messages,
    events: transcriptMock.events,
    hasMore: false,
    loading: false,
    // `settled` is the reader's own "has anyone looked yet". The default
    // matches the settled reader every other test in this file assumes.
    settled: transcriptMock.settled,
    upgradeRequired: false,
    loadOlder: vi.fn(async () => {}),
    reload: vi.fn(async () => {}),
  }),
}));

/**
 * Captures the composer's real props. The composer's honesty is a claim about
 * what it is DISABLED for, which no amount of asserting on rendered text can
 * reach.
 */
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
      return realControlsMock.enabled || realQueueControlsMock.enabled ? (
        <Actual {...(props as React.ComponentProps<typeof Actual>)} />
      ) : (
        <div data-testid="queued-messages" />
      );
    },
  };
});

import { ChatDockBody } from '../components/chat-dock/ChatDockBody';
import { ensureOrchestrationEventStream } from '../hooks/orchestration/ensureOrchestrationEventStream';
import type { ChatSession } from '../types';

const LONG_UNBREAKABLE_REASON =
  'Engine transport failed: ECONNREFUSED api.internal.example.com:8443 while resolving /Users/operator/dev/github/kontourai/station-worktrees/fix-3213-dock-failure/node_modules/.bin/claude-code-runner';

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

/** A cold arrival: idle local tab state, no error, nothing streaming. */
function buildSession(overrides: Partial<ChatSession> = {}): ChatSession {
  return {
    id: 'thread-alpha',
    agentSlug: agentId('codex'),
    agentName: 'Codex',
    title: 'A session that already failed',
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

function buildOrchestrationSession(overrides: Record<string, unknown> = {}) {
  return {
    threadId: 'thread-alpha',
    provider: 'codex',
    status: 'failed',
    lifecycleState: 'failed',
    ...overrides,
  } as any;
}

function renderDock({
  orchestrationSession = buildOrchestrationSession(),
  session = buildSession(),
  events = [] as any[],
  read,
  onRetryOrchestrationSessions = vi.fn(),
  onNewChat,
  onRetryConversationOpen,
  loadingEscapeDelayMs = 0,
}: {
  orchestrationSession?: any;
  session?: ChatSession;
  events?: any[];
  read?: 'pending' | 'error' | 'present' | 'absent';
  onRetryOrchestrationSessions?: () => void;
  onNewChat?: (input?: string) => void;
  onRetryConversationOpen?: () => void;
  loadingEscapeDelayMs?: number;
} = {}) {
  const resolvedRead = read ?? (orchestrationSession ? 'present' : 'absent');
  transcriptMock.events = events;
  agentsMock.current = [{ slug: agentId('codex'), name: 'Codex' }];
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <ChatDockBody
        activeSession={session}
        activeOrchestrationSession={orchestrationSession}
        activeOrchestrationSessionRead={resolvedRead}
        onRetryOrchestrationSessions={onRetryOrchestrationSessions}
        onNewChat={onNewChat}
        onRetryConversationOpen={onRetryConversationOpen}
        loadingEscapeDelayMs={loadingEscapeDelayMs}
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

describe('ChatDockBody failed-session banner (station#3213)', () => {
  beforeEach(() => {
    activeChatsStore.removeChat('thread-alpha');
    nativeRaceTransport.dispatch.mockClear();
    agentsMock.current = [];
    transcriptMock.events = [];
    transcriptMock.enabled = false;
    transcriptMock.settled = true;
    transcriptMock.messages = [];
    chatInputPropsMock.current = null;
    queuedMessagesPropsMock.current = null;
    realControlsMock.enabled = false;
    realQueueControlsMock.enabled = false;
    steerOrchestrationTurnMock.mockReset();
    inspectOrchestrationSteerInputMock.mockReset();
    inspectOrchestrationSteerInputMock.mockResolvedValue({
      outcome: 'not-received',
    });
    steerOrchestrationTurnMock.mockResolvedValue({ outcome: 'steered' });
  });

  /** The reported defect, exactly: nothing live, and nothing shown. */
  test('a cold arrival at an already-failed session says so', () => {
    renderDock({
      orchestrationSession: buildOrchestrationSession({
        blockedReason: LONG_UNBREAKABLE_REASON,
      }),
    });

    const banner = screen.getByTestId('chat-dock-session-failure');
    expect(banner.getAttribute('role')).toBe('alert');
    // Same copy shape the session detail uses for the same fact.
    expect(within(banner).getByText('Failed:')).toBeTruthy();
    expect(banner.textContent).toContain(LONG_UNBREAKABLE_REASON);
  });

  test('queued Steer targets the receipted current execution Session', async () => {
    activeChatsStore.initChat('thread-alpha', {
      agentSlug: 'claude',
      agentName: 'Claude',
      title: 'Steering chat',
    });
    activeChatsStore.updateChat('thread-alpha', {
      status: 'sending',
      queuedMessages: ['course correct'],
      queuedMessageMetadata: [{ id: 'queued-steer-id', mode: 'queue' }],
      currentSessionId: 'thread-alpha:session:child-3',
      openTurnId: 'turn-child-3',
    });
    renderDock({
      orchestrationSession: buildOrchestrationSession({
        threadId: 'thread-alpha:session:child-3',
        status: 'running',
        lifecycleState: 'running',
      }),
      session: buildSession({
        status: 'sending',
        queuedMessages: ['course correct'],
        orchestrationProvider: 'claude',
        currentSessionId: 'thread-alpha:session:child-3',
        openTurnId: 'turn-child-3',
      }),
    });

    await waitFor(() =>
      expect(queuedMessagesPropsMock.current?.canSteer).toBe(true),
    );
    await act(async () => {
      await queuedMessagesPropsMock.current?.onSteer(
        'course correct',
        'queued-steer-id',
      );
    });

    expect(steerOrchestrationTurnMock).toHaveBeenCalledWith({
      threadId: 'thread-alpha:session:child-3',
      clientInputId: 'queued-steer-id',
      text: 'course correct',
      turnId: 'turn-child-3',
      apiBase: 'http://localhost:3242',
    });
  });

  test('a held steering retry remains available after completion and uses its original session and turn', async () => {
    const metadata = [
      {
        id: 'held-steer-id',
        mode: 'steer' as const,
        delivery: 'indeterminate' as const,
        steerThreadId: 'original-child',
        steerTurnId: 'original-turn',
      },
    ];
    activeChatsStore.initChat('thread-alpha', {
      agentSlug: 'claude',
      agentName: 'Claude',
      title: 'Steering chat',
    });
    activeChatsStore.updateChat('thread-alpha', {
      status: 'idle',
      queuedMessages: ['held'],
      queuedMessageMetadata: metadata,
      currentSessionId: 'new-child',
    });
    renderDock({
      orchestrationSession: buildOrchestrationSession({
        status: 'completed',
        lifecycleState: 'completed',
      }),
      session: buildSession({
        status: 'idle',
        queuedMessages: ['held'],
        queuedMessageMetadata: metadata,
        orchestrationProvider: 'claude',
        currentSessionId: 'new-child',
      }),
    });
    await waitFor(() =>
      expect(queuedMessagesPropsMock.current?.canSteer).toBe(true),
    );
    await act(async () => {
      await queuedMessagesPropsMock.current?.onSteer('held', 'held-steer-id');
    });
    expect(steerOrchestrationTurnMock).toHaveBeenCalledWith({
      threadId: 'original-child',
      turnId: 'original-turn',
      clientInputId: 'held-steer-id',
      text: 'held',
      apiBase: 'http://localhost:3242',
    });
  });

  test.each([
    'steered',
    'indeterminate',
    'not-received',
    'old-server',
  ] as const)(
    'a mounted uncertain steering retry inspects delivery before any engine action: %s',
    async (inspection) => {
      realQueueControlsMock.enabled = true;
      const metadata = [
        {
          id: 'held-steer-id',
          mode: 'steer' as const,
          delivery: 'indeterminate' as const,
          steerThreadId: 'original-child',
          steerTurnId: 'original-turn',
        },
      ];
      activeChatsStore.initChat('thread-alpha', {
        agentSlug: 'claude',
        agentName: 'Claude',
        title: 'Steering chat',
      });
      activeChatsStore.updateChat('thread-alpha', {
        status: 'idle',
        queuedMessages: ['held'],
        queuedMessageMetadata: metadata,
        currentSessionId: 'new-child',
      });
      if (inspection === 'old-server')
        inspectOrchestrationSteerInputMock.mockRejectedValueOnce(
          new Error('Unknown command'),
        );
      else
        inspectOrchestrationSteerInputMock.mockResolvedValueOnce({
          outcome: inspection,
          threadId: 'original-child',
          clientInputId: 'held-steer-id',
          turnId: 'original-turn',
        });
      renderDock({
        orchestrationSession: buildOrchestrationSession({
          status: 'completed',
          lifecycleState: 'completed',
        }),
        session: buildSession({
          status: 'idle',
          queuedMessages: ['held'],
          queuedMessageMetadata: metadata,
          orchestrationProvider: 'claude',
          currentSessionId: 'new-child',
        }),
      });
      fireEvent.click(
        await screen.findByRole('button', {
          name: '1 pending message, needs review',
        }),
      );
      fireEvent.click(screen.getByRole('button', { name: 'Retry steering' }));
      await waitFor(() =>
        expect(
          inspectOrchestrationSteerInputMock,
        ).toHaveBeenCalledExactlyOnceWith({
          threadId: 'original-child',
          turnId: 'original-turn',
          clientInputId: 'held-steer-id',
          text: 'held',
          apiBase: 'http://localhost:3242',
        }),
      );
      await waitFor(() =>
        expect(
          activeChatsStore.getSnapshot()['thread-alpha'].queueSendNowPending,
        ).toBe(false),
      );
      if (inspection === 'not-received') {
        expect(steerOrchestrationTurnMock).toHaveBeenCalledExactlyOnceWith({
          threadId: 'original-child',
          turnId: 'original-turn',
          clientInputId: 'held-steer-id',
          text: 'held',
          apiBase: 'http://localhost:3242',
        });
      } else expect(steerOrchestrationTurnMock).not.toHaveBeenCalled();
      expect(
        activeChatsStore.getSnapshot()['thread-alpha'].queuedMessages,
      ).toEqual(
        inspection === 'steered' || inspection === 'not-received'
          ? []
          : ['held'],
      );
    },
  );

  test('a mounted queued steer cannot affect the engine when saving its delivery marker fails', async () => {
    realQueueControlsMock.enabled = true;
    const metadata = [{ id: 'queued-protected-id', mode: 'queue' as const }];
    activeChatsStore.initChat('thread-alpha', {
      agentSlug: 'claude',
      agentName: 'Claude',
      title: 'Steering chat',
    });
    activeChatsStore.updateChat('thread-alpha', {
      status: 'sending',
      conversationId: 'confirmed-conversation',
      currentSessionId: 'original-child',
      openTurnId: 'original-turn',
      queuedMessages: ['held'],
      queuedMessageMetadata: metadata,
    });
    activeChatsStore.flushPendingSave();
    renderDock({
      orchestrationSession: buildOrchestrationSession({
        status: 'running',
        lifecycleState: 'running',
      }),
      session: buildSession({
        status: 'sending',
        conversationId: 'confirmed-conversation',
        queuedMessages: ['held'],
        queuedMessageMetadata: metadata,
        orchestrationProvider: 'claude',
        currentSessionId: 'original-child',
        openTurnId: 'original-turn',
      }),
    });
    fireEvent.click(
      await screen.findByRole('button', { name: '1 pending message' }),
    );
    const write = vi
      .spyOn(Storage.prototype, 'setItem')
      .mockImplementation(() => {
        throw new Error('QuotaExceededError');
      });
    try {
      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: 'Send as steer' }));
      });
      expect(steerOrchestrationTurnMock).not.toHaveBeenCalled();
      expect(
        activeChatsStore.getSnapshot()['thread-alpha'].queuedMessages,
      ).toEqual(['held']);
      expect(
        activeChatsStore.getSnapshot()['thread-alpha'].queuedMessageFailure
          ?.code,
      ).toBe('steering-save-failed');
    } finally {
      write.mockRestore();
    }
  });

  test('a rendered legacy row without a delivery identity never uses legacy native steering', async () => {
    realQueueControlsMock.enabled = true;
    activeChatsStore.initChat('thread-alpha', {
      agentSlug: 'claude',
      agentName: 'Claude',
      title: 'Steering chat',
    });
    activeChatsStore.updateChat('thread-alpha', {
      status: 'sending',
      queuedMessages: ['legacy row'],
      currentSessionId: 'original-child',
      openTurnId: 'original-turn',
    });
    renderDock({
      orchestrationSession: buildOrchestrationSession({
        status: 'running',
        lifecycleState: 'running',
      }),
      session: buildSession({
        status: 'sending',
        queuedMessages: ['legacy row'],
        orchestrationProvider: 'claude',
        currentSessionId: 'original-child',
        openTurnId: 'original-turn',
      }),
    });
    fireEvent.click(
      await screen.findByRole('button', { name: '1 pending message' }),
    );
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Send as steer' }));
    });
    expect(steerOrchestrationTurnMock).not.toHaveBeenCalled();
    expect(inspectOrchestrationSteerInputMock).not.toHaveBeenCalled();
    expect(
      activeChatsStore.getSnapshot()['thread-alpha'].queuedMessages,
    ).toEqual(['legacy row']);
  });

  test('an inspection can confirm a held delivery despite unavailable storage and never invokes the engine again', async () => {
    const metadata = [
      {
        id: 'held-steer-id',
        mode: 'steer' as const,
        delivery: 'indeterminate' as const,
        steerThreadId: 'original-child',
      },
    ];
    activeChatsStore.initChat('thread-alpha', {
      agentSlug: 'claude',
      agentName: 'Claude',
      title: 'Steering chat',
    });
    activeChatsStore.updateChat('thread-alpha', {
      status: 'sending',
      queuedMessages: ['held'],
      queuedMessageMetadata: metadata,
      currentSessionId: 'new-child',
      openTurnId: 'new-turn',
    });
    inspectOrchestrationSteerInputMock.mockResolvedValueOnce({
      outcome: 'steered',
      threadId: 'original-child',
      turnId: 'original-turn',
    });
    renderDock({
      orchestrationSession: buildOrchestrationSession({
        status: 'running',
        lifecycleState: 'running',
      }),
      session: buildSession({
        status: 'sending',
        queuedMessages: ['held'],
        queuedMessageMetadata: metadata,
        orchestrationProvider: 'claude',
        currentSessionId: 'new-child',
        openTurnId: 'new-turn',
      }),
    });
    await waitFor(() =>
      expect(queuedMessagesPropsMock.current?.canSteer).toBe(true),
    );
    const write = vi
      .spyOn(Storage.prototype, 'setItem')
      .mockImplementation(() => {
        throw new Error('QuotaExceededError');
      });
    try {
      let confirmed: unknown;
      await act(async () => {
        confirmed = await queuedMessagesPropsMock.current?.onSteer(
          'held',
          'held-steer-id',
        );
      });
      expect(confirmed).toBe(true);
      expect(
        inspectOrchestrationSteerInputMock,
      ).toHaveBeenCalledExactlyOnceWith({
        threadId: 'original-child',
        turnId: undefined,
        clientInputId: 'held-steer-id',
        text: 'held',
        apiBase: 'http://localhost:3242',
      });
      expect(steerOrchestrationTurnMock).not.toHaveBeenCalled();
    } finally {
      write.mockRestore();
    }
  });

  test('a native acknowledgement retires B before a terminal SSE microtask can drain A', async () => {
    realQueueControlsMock.enabled = true;
    const metadata = [
      { id: 'a-race-id', mode: 'queue' as const },
      { id: 'b-race-id', mode: 'queue' as const },
    ];
    activeChatsStore.initChat('thread-alpha', {
      agentSlug: 'claude',
      agentName: 'Claude',
      title: 'Steering race',
      conversationId: 'race-conversation',
    });
    activeChatsStore.updateChat('thread-alpha', {
      status: 'sending',
      currentSessionId: 'race-child',
      openTurnId: 'race-turn',
      conversationOpenPending: false,
      queuedMessages: ['ordinary A', 'confirmed B'],
      queuedMessageMetadata: metadata,
      conversationActivity: {
        conversationId: 'race-conversation',
        asOfSequence: 1,
        openTurn: {
          threadId: 'race-child',
          turnId: 'race-turn',
          startedAt: '2026-10-02T18:00:00.000Z',
        },
      },
    });
    renderDock({
      orchestrationSession: buildOrchestrationSession({
        status: 'running',
        lifecycleState: 'running',
      }),
      session: buildSession({
        status: 'sending',
        conversationId: 'race-conversation',
        currentSessionId: 'race-child',
        openTurnId: 'race-turn',
        queuedMessages: ['ordinary A', 'confirmed B'],
        queuedMessageMetadata: metadata,
        orchestrationProvider: 'claude',
      }),
    });
    fireEvent.click(
      await screen.findByRole('button', { name: '2 pending messages' }),
    );
    ensureOrchestrationEventStream('http://localhost:3242');
    expect(nativeRaceTransport.onMessage).not.toBeNull();
    vi.useFakeTimers();
    let locked = false;
    let delivered = false;
    const unsubscribe = activeChatsStore.subscribe(() => {
      const state = activeChatsStore.getSnapshot()['thread-alpha'];
      if (state?.queueSendNowPending) locked = true;
      if (locked && !state?.queueSendNowPending && !delivered) {
        delivered = true;
        void Promise.resolve().then(() =>
          nativeRaceTransport.onMessage?.({
            event: SERVER_EVENTS.ORCHESTRATION_EVENT,
            id: 'native-race-terminal',
            data: JSON.stringify({
              event: {
                eventId: 'native-race-terminal',
                provider: 'claude',
                threadId: 'race-child',
                turnId: 'race-turn',
                method: 'turn.completed',
                outputText: 'Finished',
                createdAt: '2026-10-02T18:00:10.000Z',
              },
              conversation: {
                conversationId: 'race-conversation',
                currentSessionId: 'race-child',
                activity: {
                  conversationId: 'race-conversation',
                  asOfSequence: 2,
                },
              },
            }),
          }),
        );
      }
    });
    try {
      await act(async () => {
        fireEvent.click(
          screen.getAllByRole('button', { name: 'Send as steer' })[0],
        );
      });
      expect(delivered).toBe(true);
      expect(
        activeChatsStore.getSnapshot()['thread-alpha'].queuedMessages,
      ).toEqual([]);
      expect(
        activeChatsStore.getSnapshot()['thread-alpha'].pendingQueueDispatch
          ?.content,
      ).toBe('ordinary A');
      await act(async () => {
        await vi.advanceTimersByTimeAsync(150);
        await vi.dynamicImportSettled();
      });
      expect(steerOrchestrationTurnMock).toHaveBeenCalledTimes(1);
      expect(nativeRaceTransport.dispatch).toHaveBeenCalledTimes(1);
      expect(nativeRaceTransport.dispatch.mock.calls[0]?.[0]).toMatchObject({
        message: 'ordinary A',
        clientTurnId: 'a-race-id',
      });
    } finally {
      unsubscribe();
      vi.useRealTimers();
    }
  });

  test('background-only work offers neither queued Steer nor turn Stop', async () => {
    realControlsMock.enabled = true;
    renderDock({
      orchestrationSession: buildOrchestrationSession({
        status: 'running',
        lifecycleState: 'completed',
      }),
      session: buildSession({
        status: 'idle',
        queuedMessages: ['next question'],
        orchestrationProvider: 'claude',
        orchestrationStatus: 'running',
        currentSessionId: 'thread-alpha',
        conversationActivity: {
          conversationId: 'thread-alpha',
          asOfSequence: 10,
          runningChildWork: { count: 1, producers: ['engine-subagent'] },
        },
      }),
    });
    await waitFor(() => {
      expect(queuedMessagesPropsMock.current).not.toBeNull();
      expect(chatInputPropsMock.current).not.toBeNull();
    });
    expect(queuedMessagesPropsMock.current?.canSteer).toBe(false);
    expect(screen.queryByRole('button', { name: 'Steer' })).toBeNull();
    expect(
      screen.queryByRole('button', { name: 'Stop the current turn' }),
    ).toBeNull();
  });

  test('a failed session with nothing recorded says so, rather than showing an empty banner', () => {
    renderDock({ orchestrationSession: buildOrchestrationSession() });

    expect(
      screen.getByTestId('chat-dock-session-failure').textContent,
    ).toContain('No failure detail was recorded for this session.');
  });

  /**
   * The reuse claim, in the direction that can actually fail: a second
   * derivation reading only the session record would show the mirror here.
   * The shared fold prefers the feed's own `runtime.error`, so the dock and
   * the detail quote the same sentence for the same session.
   */
  test('the live feed`s runtime.error wins over the server-side mirror, exactly as the detail folds it', () => {
    renderDock({
      orchestrationSession: buildOrchestrationSession({
        blockedReason: 'a stale mirrored reason',
      }),
      events: [
        {
          sequence: 1,
          event: {
            method: 'turn.started',
            provider: 'codex',
            threadId: 'thread-alpha',
            createdAt: '2026-08-18T00:00:00.000Z',
            turnId: 'turn-1',
            prompt: 'go',
          },
        },
        {
          sequence: 2,
          event: {
            method: 'runtime.error',
            provider: 'codex',
            threadId: 'thread-alpha',
            createdAt: '2026-08-18T00:00:02.000Z',
            severity: 'error',
            message: 'ECONNREFUSED api.example.com:443',
          },
        },
      ],
    });

    const banner = screen.getByTestId('chat-dock-session-failure');
    expect(banner.textContent).toContain('ECONNREFUSED api.example.com:443');
    expect(banner.textContent).not.toContain('a stale mirrored reason');
  });

  /**
   * Composer honesty, traced rather than assumed:
   * `SESSION_LIFECYCLE_TRANSITIONS` declares `failed: ['queued', 'running']`
   * and the send path's only terminal gate rejects `completed` alone
   * (`orchestration-service.ts`'s `sendTurn` case), so sending into a failed
   * session really does try to resume it. The banner therefore says the user
   * can continue, and the composer is NOT disabled — disabling it would be a
   * second untruth in the opposite direction.
   */
  test('the banner says the session can be continued, and the composer stays usable', async () => {
    renderDock({
      orchestrationSession: buildOrchestrationSession({
        blockedReason: 'Engine crashed',
      }),
    });

    expect(
      screen.getByTestId('chat-dock-session-failure').textContent,
    ).toContain('You can send a message to try to continue this chat.');
    expect(await screen.findByTestId('chat-input-area')).toBeTruthy();
    await waitFor(() =>
      expect(chatInputPropsMock.current?.disabled).toBe(false),
    );
  });

  test('a running session gets no banner and no continuation claim', () => {
    renderDock({
      orchestrationSession: buildOrchestrationSession({
        lifecycleState: 'running',
        status: 'running',
        blockedReason: 'an old reason from an earlier failure',
      }),
    });

    expect(screen.queryByTestId('chat-dock-session-failure')).toBeNull();
    expect(document.body.textContent).not.toContain(
      'an old reason from an earlier failure',
    );
  });

  /**
   * A chat the serving Station has no session for — a chat before its first
   * send, or the direct `/chat` path. Nothing is known about a failure here,
   * and the honest render of that is silence, not a fabricated one.
   */
  test('a chat with no server session record renders no banner', async () => {
    renderDock({ orchestrationSession: null });

    expect(screen.queryByTestId('chat-dock-session-failure')).toBeNull();
    expect(await screen.findByTestId('chat-input-area')).toBeTruthy();
  });

  // The "Stopped." copy itself is owned by describeStopTurnOutcome's table in
  // useActiveChatSessionMessaging.test.ts; this pins what the dock withholds.
  test('a requested stop shows no missing-record banner, failure state, Retry, or null diagnostic (#898)', () => {
    renderDock({
      orchestrationSession: buildOrchestrationSession({
        status: 'ready',
        lifecycleState: 'canceled',
        terminalAttribution: {
          kind: 'requested_stop',
          detail: 'Stopped by request.',
        },
      }),
      session: buildSession({
        orchestrationSessionStarted: true,
        orchestrationStatus: 'aborted',
      }),
    });

    expect(screen.queryByTestId('chat-dock-session-record-missing')).toBeNull();
    expect(screen.queryByTestId('chat-dock-session-failure')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull();
    expect(document.body.textContent).not.toContain('stop_reason=null');
  });

  test('names a missing record after Station had already recorded the session start', () => {
    renderDock({
      orchestrationSession: null,
      session: buildSession({
        orchestrationSessionStarted: true,
        messages: [{ role: 'user', content: 'finish the release notes' }],
      }),
    });

    const alert = screen.getByTestId('chat-dock-session-record-missing');
    expect(alert.textContent).toContain('Session record missing.');
    expect(alert.textContent).toContain(
      'Last known turn: finish the release notes',
    );
  });

  // `orchestrationSessionStarted` IS rehydrated from
  // storage, and the sessions query's `data` defaults to `[]` until it
  // resolves — so a healthy session claimed "Session record missing" on EVERY
  // reload for about a second. Absence is only established once the read has
  // succeeded.
  test('says nothing about a missing record while the session read is still pending', () => {
    renderDock({
      orchestrationSession: null,
      read: 'pending',
      session: buildSession({ orchestrationSessionStarted: true }),
    });

    expect(screen.queryByTestId('chat-dock-session-record-missing')).toBeNull();
    expect(
      screen.getByRole('status', { name: "Reading this chat's record" }),
    ).toBeTruthy();
  });

  test('reports a failed session read as a failed read, with a retry', () => {
    const onRetryOrchestrationSessions = vi.fn();
    renderDock({
      orchestrationSession: null,
      read: 'error',
      session: buildSession({ orchestrationSessionStarted: true }),
      onRetryOrchestrationSessions,
    });

    expect(screen.queryByTestId('chat-dock-session-record-missing')).toBeNull();
    expect(
      screen.getByText("Could not read this Station's chat records"),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(onRetryOrchestrationSessions).toHaveBeenCalledTimes(1);
  });

  // The transcript is empty exactly when this state is reachable (a cold
  // reload), so the last-known turn needs a source that survives one.
  test('falls back to the last message this client sent when the transcript is empty', () => {
    renderDock({
      orchestrationSession: null,
      read: 'absent',
      session: buildSession({
        orchestrationSessionStarted: true,
        messages: [],
        inputHistory: ['ship the release notes'],
      }),
    });

    expect(
      screen.getByTestId('chat-dock-session-record-missing').textContent,
    ).toContain('Last message you sent: ship the release notes');
  });

  // #1582 E3/B6 changed what this state LOOKS like, not what it permits. The
  // composer stays disabled — a conversation whose continuation is unproven
  // must not be written to — but a reload is the ordinary path, not a failure,
  // so it may not claim one.
  test('#749 keeps the composer disabled while a reloaded conversation is resolving', async () => {
    renderDock({
      session: buildSession({
        conversationId: 'cool',
        conversationOpenPending: true,
      }),
    });

    await waitFor(() =>
      expect(chatInputPropsMock.current?.disabled).toBe(true),
    );
    // The wait is announced by the repo's skeleton vocabulary, not a bespoke
    // sentence, and not by `role="alert"` — `role`/tone are what made this
    // ordinary phase read as a failure.
    const notice = await screen.findByLabelText('Loading chat');
    expect(notice.getAttribute('role')).toBe('status');
    expect(notice.getAttribute('aria-busy')).toBe('true');
    // The conversation-open banner specifically: this suite's default session
    // has already failed, so it carries its own (correct) alert.
    expect(screen.queryByText(/is read-only/)).toBeNull();
  });

  // The three simultaneous claims E3 recorded, each asserted absent by the
  // words the user actually saw.
  test('#1582 E3 a resolving reload shows one state, not three', async () => {
    renderDock({
      // A HEALTHY session reloading: E3 is about the ordinary path, so the
      // fixture must not also be a failed session (this suite's default).
      orchestrationSession: buildOrchestrationSession({
        status: 'idle',
        lifecycleState: 'idle',
      }),
      session: buildSession({
        title: 'A healthy session being reloaded',
        conversationId: 'cool',
        conversationOpenPending: true,
        messages: [],
      }),
    });

    await screen.findByLabelText('Loading chat');
    // 1. no red read-only banner — asserted on the error BOX as well as the
    //    words, because the box is what makes the state read as a failure.
    expect(screen.queryByText(/is read-only/)).toBeNull();
    expect(
      screen.queryByText('Station is resolving its current session.'),
    ).toBeNull();
    expect(document.querySelector('.session-history-error')).toBeNull();
    expect(screen.queryByRole('alert')).toBeNull();
    // 2. no empty-conversation placeholder over a transcript that has not
    //    finished loading — "Start a chat" is a claim that this chat
    //    has none, which nothing has established yet.
    expect(screen.queryByText('Start a chat')).toBeNull();
    // 3. no second sentence under the composer saying the same thing again
    expect(chatInputPropsMock.current?.sendBlockedReason).toBeUndefined();
  });

  // Review L1. The resolving phase disables the composer for up to the SDK's
  // 30s request timeout. Before this, the red banner it replaced at least
  // offered "Start new chat" — so removing the banner removed the only way out
  // of the wait. Retry is deliberately absent: it would re-ask a question the
  // resolver is already asking.
  /**
   * D3 (design round 2026-10): a reopened chat showed a "Loading
   * conversation" skeleton, a "Start new chat" button and a live composer
   * at once. One state at a time: the escape joins the skeleton only once a
   * load has run past `loadingEscapeDelayMs`.
   */
  test('D3 while a conversation loads, the skeleton stands alone until the escape delay passes', () => {
    vi.useFakeTimers();
    try {
      renderDock({
        orchestrationSession: buildOrchestrationSession({
          status: 'idle',
          lifecycleState: 'idle',
        }),
        session: buildSession({
          conversationId: 'cool',
          conversationOpenPending: true,
          messages: [],
        }),
        onNewChat: vi.fn(),
        onRetryConversationOpen: vi.fn(),
        loadingEscapeDelayMs: 1_500,
      });
      expect(screen.getByLabelText('Loading chat')).toBeTruthy();
      expect(
        screen.queryByRole('button', { name: 'Start new chat' }),
      ).toBeNull();
      act(() => {
        vi.advanceTimersByTime(1_500);
      });
      expect(
        screen.getByRole('button', { name: 'Start new chat' }),
      ).toBeTruthy();
    } finally {
      vi.useRealTimers();
    }
  });

  test('#1582 E3 a resolving conversation still offers a way out', async () => {
    const onNewChat = vi.fn();
    renderDock({
      orchestrationSession: buildOrchestrationSession({
        status: 'idle',
        lifecycleState: 'idle',
      }),
      session: buildSession({
        conversationId: 'cool',
        conversationOpenPending: true,
        messages: [],
      }),
      onNewChat,
      // Supplied so the Retry assertion below is a real one: without a handler
      // the notice omits Retry anyway, and the absence proved nothing.
      onRetryConversationOpen: vi.fn(),
    });

    const startNew = await screen.findByRole('button', {
      name: 'Start new chat',
    });
    expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull();
    fireEvent.click(startNew);
    expect(onNewChat).toHaveBeenCalled();
    // The composer stays refused — the way out is a NEW chat, not a write into
    // the one whose continuation is unproven.
    expect(chatInputPropsMock.current?.disabled).toBe(true);
  });

  // Delta-review L1. The two states are not exclusive: a reload whose
  // point-read lands `unavailable` while the transcript's first read is still
  // in flight is BOTH read-only and loading, and both surfaces carry their own
  // "Start new chat".
  test('#1582 E3 a failed open during a transcript read offers ONE way out', async () => {
    transcriptMock.enabled = true;
    transcriptMock.settled = false;
    renderDock({
      orchestrationSession: buildOrchestrationSession({
        status: 'idle',
        lifecycleState: 'idle',
      }),
      session: buildSession({
        conversationId: 'cool',
        conversationOpenFailed: true,
        orchestrationSessionStarted: true,
        messages: [],
      }),
      onNewChat: vi.fn(),
      onRetryConversationOpen: vi.fn(),
    });

    expect(
      await screen.findAllByRole('button', { name: 'Start new chat' }),
    ).toHaveLength(1);
    // ...and it is the recovery notice's, which is the surface that also
    // explains WHY, and offers the Retry this state can actually use. A
    // failed open is a failed check, so it does not claim "read-only" (#2424).
    expect(screen.getByText(/couldn't confirm/)).toBeTruthy();
    expect(screen.queryByText(/is read-only/)).toBeNull();
    expect(screen.getByRole('button', { name: 'Retry' })).toBeTruthy();
  });

  test('#1582 E3 a settled conversation carries no such control', async () => {
    // The mirror: the affordance is scoped to the wait, not permanent chrome.
    transcriptMock.enabled = true;
    transcriptMock.settled = true;
    renderDock({
      orchestrationSession: buildOrchestrationSession({
        status: 'idle',
        lifecycleState: 'idle',
      }),
      session: buildSession({ messages: [] }),
      onNewChat: vi.fn(),
    });

    expect(screen.queryByRole('button', { name: 'Start new chat' })).toBeNull();
  });

  // The other half of the same window, and the one that actually reproduced on
  // a live reload: the conversation-open read had already landed while the
  // TRANSCRIPT read had not, and the empty placeholder claimed the chat had no
  // messages for ~1.7s.
  test('#1582 E3 an unread transcript is not an empty conversation', async () => {
    transcriptMock.enabled = true;
    transcriptMock.settled = false;
    renderDock({
      orchestrationSession: buildOrchestrationSession({
        status: 'idle',
        lifecycleState: 'idle',
      }),
      session: buildSession({
        title: 'A healthy session being reloaded',
        conversationId: 'cool',
        orchestrationSessionStarted: true,
        messages: [],
      }),
    });

    expect(screen.queryByText('Start a chat')).toBeNull();
    expect(await screen.findByLabelText('Loading chat')).toBeTruthy();
    // The composer is NOT disabled by a transcript read: nothing about an
    // unrendered history stops a new message, and disabling it here would be a
    // new refusal wearing the fix's name.
    expect(chatInputPropsMock.current?.disabled).toBe(false);
  });

  test('#1582 E3 a settled empty transcript still says the chat is empty', async () => {
    transcriptMock.enabled = true;
    transcriptMock.settled = true;
    renderDock({
      orchestrationSession: buildOrchestrationSession({
        status: 'idle',
        lifecycleState: 'idle',
      }),
      session: buildSession({
        title: 'A genuinely empty chat',
        orchestrationSessionStarted: true,
        messages: [],
      }),
    });

    expect(await screen.findByText('Start a chat')).toBeTruthy();
    expect(screen.queryByLabelText('Loading chat')).toBeNull();
  });

  // The mirror: once the read lands on a genuine verdict the error chrome is
  // exactly what must appear. Without this, suppressing the banner in the
  // resolving case would be indistinguishable from suppressing it always.
  test('#1582 E3 a failed resolution still gets the red banner and the empty state, without a read-only verdict (#2424)', async () => {
    renderDock({
      orchestrationSession: buildOrchestrationSession({
        status: 'idle',
        lifecycleState: 'idle',
      }),
      session: buildSession({
        title: 'A healthy session being reloaded',
        conversationId: 'cool',
        conversationOpenFailed: true,
        messages: [],
      }),
    });

    expect(
      await screen.findByText(
        "Station couldn't confirm A healthy session being reloaded can continue.",
      ),
    ).toBeTruthy();
    expect(screen.queryByText(/is read-only/)).toBeNull();
    expect(screen.queryByLabelText('Loading chat')).toBeNull();
    expect(chatInputPropsMock.current?.disabled).toBe(true);
    // The notice carries the explanation and the Retry; the composer does not
    // repeat it, and above all does not call the chat read-only.
    expect(chatInputPropsMock.current?.sendBlockedReason).toBeUndefined();
  });

  test('#749 transport failure stays fail-closed (unverified, #2424) and exposes recovery actions', async () => {
    const onRetryConversationOpen = vi.fn();
    const onNewChat = vi.fn();
    render(
      <QueryClientProvider client={new QueryClient()}>
        <ChatDockBody
          activeSession={buildSession({
            conversationId: 'cool',
            conversationOpenFailed: true,
          })}
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
          onRetryConversationOpen={onRetryConversationOpen}
          onNewChat={onNewChat}
        />
      </QueryClientProvider>,
    );
    await waitFor(() =>
      expect(chatInputPropsMock.current?.disabled).toBe(true),
    );
    fireEvent.click(await screen.findByRole('button', { name: 'Retry' }));
    fireEvent.click(
      await screen.findByRole('button', { name: 'Start new chat' }),
    );
    expect(onRetryConversationOpen).toHaveBeenCalledOnce();
    expect(onNewChat).toHaveBeenCalledOnce();
  });

  // A re-read that fails after an earlier one succeeded leaves the earlier
  // resolution on the chat. The failure is what is current, and it is not a
  // verdict — the stale `resolved` must not turn it into "read-only".
  test('#2424 a failed re-read over a stale resolution is not a read-only verdict', async () => {
    renderDock({
      orchestrationSession: buildOrchestrationSession({
        status: 'idle',
        lifecycleState: 'idle',
      }),
      session: buildSession({
        title: 'Rechecked chat',
        conversationId: 'cool',
        conversationOpenFailed: true,
        conversationOpenState: {
          status: 'resolved',
          conversation: {
            id: 'cool',
            source: 'runtime',
            agentSlug: agentId('codex'),
            title: 'Rechecked chat',
            createdAt: '2026-08-01T00:00:00.000Z',
            updatedAt: '2026-08-01T00:01:00.000Z',
            messageCount: 2,
            mutable: false,
            answerability: { answerable: true },
          },
          currentSessionId: 'cool',
          transcript: { available: true, owner: 'runtime', messageCount: 2 },
          canContinue: true,
          answerability: { answerable: true },
          recoveryActions: [],
        },
      }),
    });

    expect(
      await screen.findByText(
        "Station couldn't confirm Rechecked chat can continue.",
      ),
    ).toBeTruthy();
    expect(screen.queryByText(/is read-only/)).toBeNull();
    expect(chatInputPropsMock.current?.disabled).toBe(true);
  });

  test('#2424 a continuation the server denied still reads as read-only', async () => {
    renderDock({
      orchestrationSession: buildOrchestrationSession({
        status: 'idle',
        lifecycleState: 'idle',
      }),
      session: buildSession({
        title: 'Denied chat',
        conversationId: 'cool',
        conversationOpenState: {
          status: 'resolved',
          conversation: {
            id: 'cool',
            source: 'runtime',
            agentSlug: agentId('codex'),
            title: 'Denied chat',
            createdAt: '2026-08-01T00:00:00.000Z',
            updatedAt: '2026-08-01T00:01:00.000Z',
            messageCount: 2,
            mutable: false,
            answerability: { answerable: true },
          },
          currentSessionId: 'cool',
          transcript: { available: true, owner: 'runtime', messageCount: 2 },
          canContinue: false,
          answerability: { answerable: true },
          recoveryActions: [],
        },
      }),
    });

    expect(await screen.findByText('Denied chat is read-only.')).toBeTruthy();
    expect(screen.queryByText(/couldn't confirm/)).toBeNull();
  });

  test('#749 respects canContinue rather than Agent availability', async () => {
    const base = {
      status: 'resolved' as const,
      conversation: {
        id: 'cool',
        source: 'runtime' as const,
        agentSlug: agentId('codex'),
        title: 'Cool',
        createdAt: '2026-08-01T00:00:00.000Z',
        updatedAt: '2026-08-01T00:01:00.000Z',
        messageCount: 2,
        mutable: false,
        answerability: { answerable: true as const },
      },
      currentSessionId: 'cool:child:2',
      transcript: {
        available: true as const,
        owner: 'runtime' as const,
        messageCount: 2,
      },
      answerability: { answerable: true as const },
      recoveryActions: [] as const,
    };
    const { rerender } = renderDock({
      orchestrationSession: null,
      read: 'absent',
      session: buildSession({
        currentSessionId: base.currentSessionId,
        orchestrationSessionStarted: true,
        conversationOpenState: { ...base, canContinue: false },
      }),
    });
    expect(screen.queryByTestId('chat-dock-session-record-missing')).toBeNull();
    await waitFor(() =>
      expect(chatInputPropsMock.current?.disabled).toBe(true),
    );
    // #2424 mirror: a continuation the server DENIED is a derived verdict, and
    // is the case that keeps the read-only wording.
    expect(chatInputPropsMock.current?.sendBlockedReason).toBe(
      'This conversation is available read-only. Retry resolution or start a new chat.',
    );
    rerender(
      <QueryClientProvider client={new QueryClient()}>
        <ChatDockBody
          {...({
            activeSession: buildSession({
              conversationOpenState: { ...base, canContinue: true },
            }),
            chatFontSize: 14,
            dockHeight: 400,
            showStatsPanel: false,
            showReasoning: false,
            showToolDetails: false,
            modelSupportsAttachments: false,
            fileAttachmentsSupported: false,
            availableModels: [],
            chatInput: buildChatInput(),
            setShowStatsPanel: vi.fn(),
          } as any)}
        />
      </QueryClientProvider>,
    );
    await waitFor(() =>
      expect(chatInputPropsMock.current?.disabled).toBe(false),
    );
  });

  test('allows a draft during an authorized active-turn continuation wait', async () => {
    renderDock({
      session: buildSession({
        conversationOpenState: {
          status: 'resolved',
          canContinue: false,
          continuationPending: true,
        } as ChatSession['conversationOpenState'],
      }),
    });
    await waitFor(() =>
      expect(chatInputPropsMock.current?.disabled).toBe(true),
    );
    expect(chatInputPropsMock.current?.allowDraftWhileDisabled).toBe(true);
  });

  // #834: the exact open resolution the server now returns for a STOPPED
  // conversation — continuable through the successor reserve, while the
  // current child's answerability decoration stays `past_resume` (the steady
  // state of every stopped, unloaded session). The composer must key on the
  // server's continuation decision, not re-derive one from answerability.
  test('#834 re-enables the composer for a stopped conversation resolved continuable', async () => {
    const stoppedAnswerability = {
      answerable: false as const,
      qualification: 'past_resume' as const,
      observedBy: 'chat-dock-body-test',
      observedAt: '2026-08-29T00:02:00.000Z',
    };
    renderDock({
      session: buildSession({
        conversationOpenState: {
          status: 'resolved' as const,
          conversation: {
            id: 'stopped',
            source: 'runtime' as const,
            agentSlug: agentId('codex'),
            title: 'Stopped then continued',
            createdAt: '2026-08-01T00:00:00.000Z',
            updatedAt: '2026-08-01T00:01:00.000Z',
            messageCount: 4,
            mutable: false,
            answerability: stoppedAnswerability,
          },
          currentSessionId: 'stopped:session:child-1',
          transcript: {
            available: true as const,
            owner: 'runtime' as const,
            messageCount: 4,
          },
          canContinue: true,
          answerability: stoppedAnswerability,
          recoveryActions: [] as const,
        },
      }),
    });
    await waitFor(() =>
      expect(chatInputPropsMock.current?.disabled).toBe(false),
    );
  });
});
