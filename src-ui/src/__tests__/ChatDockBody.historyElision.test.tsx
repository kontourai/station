/**
 * @vitest-environment jsdom
 *
 * archive#3386. The bounded session-window read has two per-event budgets and
 * both used to fire in silence: a payload over the serialized ceiling comes
 * back as its identity fields alone, and a tool result comes back cut. From
 * the client those are indistinguishable from a turn that never carried a
 * prompt, and from a blob retention reclaimed — which is why a pasted image
 * over ~3 KB lost both its prompt and its chip on restore (archive#3374).
 *
 * The read now labels which budget fired (`elided`). These tests hold the
 * dock to reading that label rather than inferring anything from what is
 * missing, and — the half that makes the notice mean something — to staying
 * quiet about a window the read returned whole.
 */

import { agentId } from '@kontourai/station-contracts/agent-identity';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, test, vi } from 'vitest';

const agentsMock = vi.hoisted(() => ({ current: [] as any[] }));
const transcriptMock = vi.hoisted(() => ({
  events: [] as any[],
  hydrated: false,
  current: true,
  messages: [] as import('../types').ChatMessage[],
}));
const chatInputPropsMock = vi.hoisted(() => ({
  current: null as Record<string, any> | null,
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
  useHostRequestAuthorityScope: () =>
    transcriptMock.hydrated
      ? {
          apiBase: 'http://localhost:3242',
          authorityKey: 'host-authority',
          isCurrent: () => transcriptMock.current,
        }
      : undefined,
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

/**
 * The bounded event window this pane already loads. Mocked so a test can
 * place a real `runtime.error` in it — that is the channel the shared fold
 * prefers, and the only way to prove the dock reads the fold's PREFERRED
 * source rather than just the session record it was handed.
 */
vi.mock('../hooks/orchestration/useActiveChatTranscript', () => ({
  useActiveChatTranscript: () => ({
    enabled: transcriptMock.hydrated,
    settled: transcriptMock.hydrated,
    messages: transcriptMock.messages,
    events: transcriptMock.events,
    hasMore: false,
    loading: false,
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
vi.mock('../components/chat/ChatInputArea', () => ({
  ChatInputArea: (props: Record<string, any>) => {
    chatInputPropsMock.current = props;
    return <div data-testid="chat-input-area" />;
  },
}));

vi.mock('../components/chat/QueuedMessages', () => ({
  QueuedMessages: () => null,
}));

import { ChatDockBody } from '../components/chat-dock/ChatDockBody';
import type { ConversationTranscriptSnapshot } from '../components/conversation/ConversationBody';
import { continuedConversationFromChat } from '../lib/continue-in-project';
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
  transcriptSnapshotRef,
}: {
  orchestrationSession?: any;
  session?: ChatSession;
  events?: any[];
  transcriptSnapshotRef?: { current: ConversationTranscriptSnapshot | null };
} = {}) {
  transcriptMock.events = events;
  agentsMock.current = [{ slug: agentId('codex'), name: 'Codex' }];
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <ChatDockBody
        activeSession={session}
        transcriptSnapshotRef={transcriptSnapshotRef}
        activeOrchestrationSession={orchestrationSession}
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

describe('ChatDockBody bounded-read elision notice (station#3386)', () => {
  beforeEach(() => {
    agentsMock.current = [];
    transcriptMock.events = [];
    chatInputPropsMock.current = null;
  });

  const sequenced = (
    eventId: string,
    sequence: number,
    elided?: 'byte_limit' | 'output_limit',
  ) => ({
    sequence,
    event: {
      eventId,
      provider: 'codex',
      threadId: 'thread-alpha',
      turnId: `turn-${eventId}`,
      createdAt: '2026-08-19T03:00:00.000Z',
      method: elided === 'output_limit' ? 'tool.completed' : 'turn.started',
      ...(elided === 'output_limit'
        ? {
            toolCallId: eventId,
            toolName: 'read_file',
            output: 'Short preview',
          }
        : {}),
    },
    ...(elided ? { elided } : {}),
  });

  /**
   * The reported defect: content withheld, and nothing said about it. And the
   * reason this branch chose a reason code over `truncated: true` — the two
   * budgets take different things, so folding them into one sentence would
   * have thrown the distinction away at the last step.
   */
  test('discloses omitted message content without adding tool-detail noise', () => {
    renderDock({
      events: [
        sequenced('evt-whole', 1),
        sequenced('evt-cut', 2, 'byte_limit'),
        sequenced('evt-shortened', 3, 'output_limit'),
      ],
    });

    const notice = screen.getByTestId('chat-dock-history-elided');
    expect(notice.textContent).toContain(
      '1 recorded event has omitted content in this view. The session record retains the full details.',
    );
    expect(notice.textContent).not.toContain('tool result');
  });

  test('does not put a tool-only truncation notice above the conversation', () => {
    renderDock({ events: [sequenced('tool-result', 1, 'output_limit')] });
    expect(screen.queryByTestId('chat-dock-history-elided')).toBeNull();
  });

  test('a whole payload removed reads differently from a tool result shortened', () => {
    renderDock({
      events: [
        sequenced('evt-a', 1, 'byte_limit'),
        sequenced('evt-b', 2, 'byte_limit'),
      ],
    });
    expect(
      screen.getByTestId('chat-dock-history-elided').textContent,
    ).toContain('2 recorded events have omitted content');
    expect(
      screen.getByTestId('chat-dock-history-elided').textContent,
    ).not.toContain('tool result');
  });

  /**
   * The negative control. A notice that appears whether or not anything was
   * withheld is not a disclosure, it is decoration — and it would teach a
   * reader to ignore the one case that matters.
   */
  test('says nothing about a window the read returned whole', () => {
    renderDock({ events: [sequenced('evt-whole', 1), sequenced('evt-2', 2)] });

    expect(screen.queryByTestId('chat-dock-history-elided')).toBeNull();
  });

  test('says nothing when the window is empty', () => {
    renderDock({ events: [] });

    expect(screen.queryByTestId('chat-dock-history-elided')).toBeNull();
  });
});

test('a reopened dock lends Save to Project its hydrated answer and revokes the snapshot on close', () => {
  transcriptMock.hydrated = true;
  transcriptMock.messages = [
    {
      id: 'completed',
      role: 'assistant',
      content: 'The checks passed.',
      sessionId: 'execution-that-answered',
      turnId: 'completed-turn',
      answerEligible: true,
    },
    {
      id: 'streaming',
      role: 'assistant',
      content: 'Starting another check…',
      sessionId: 'current-execution',
      turnId: 'unfinished-turn',
    },
  ];
  const session = buildSession({
    conversationId: 'reopened-conversation',
    currentSessionId: 'current-execution',
    orchestrationSessionStarted: true,
  });
  const transcriptSnapshotRef: {
    current: ConversationTranscriptSnapshot | null;
  } = {
    current: null,
  };
  const view = renderDock({ session, transcriptSnapshotRef });
  try {
    const snapshot = transcriptSnapshotRef.current;
    expect(snapshot).toMatchObject({
      chatId: session.id,
      conversationId: 'reopened-conversation',
    });
    expect(
      continuedConversationFromChat({
        ...session,
        messages: snapshot?.messages,
      }),
    ).toMatchObject({
      latestAnswer: 'The checks passed.',
      sessionId: 'execution-that-answered',
      latestTurnId: 'completed-turn',
    });
    transcriptMock.current = false;
    expect(snapshot?.requestScope.isCurrent()).toBe(false);
  } finally {
    view.unmount();
    transcriptMock.hydrated = false;
    transcriptMock.current = true;
    transcriptMock.messages = [];
  }
  expect(transcriptSnapshotRef.current).toBeNull();
});
