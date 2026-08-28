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
const transcriptMock = vi.hoisted(() => ({ events: [] as any[] }));
const chatInputPropsMock = vi.hoisted(() => ({
  current: null as Record<string, any> | null,
}));

vi.mock('@kontourai/station-connect', () => ({
  useConnections: () => ({
    activeConnection: { id: 'test', name: 'Test Station' },
  }),
}));

vi.mock('../contexts/AgentsContext', () => ({
  useAgents: () => agentsMock.current,
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

/**
 * The bounded event window this pane already loads. Mocked so a test can
 * place a real `runtime.error` in it — that is the channel the shared fold
 * prefers, and the only way to prove the dock reads the fold's PREFERRED
 * source rather than just the session record it was handed.
 */
vi.mock('../hooks/orchestration/useActiveChatTranscript', () => ({
  useActiveChatTranscript: () => ({
    enabled: false,
    messages: [],
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
}: {
  orchestrationSession?: any;
  session?: ChatSession;
  events?: any[];
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
      method: 'turn.started',
    },
    ...(elided ? { elided } : {}),
  });

  /**
   * The reported defect: content withheld, and nothing said about it. And the
   * reason this branch chose a reason code over `truncated: true` — the two
   * budgets take different things, so folding them into one sentence would
   * have thrown the distinction away at the last step.
   */
  test('keeps the two budgets apart instead of folding them into one count', () => {
    renderDock({
      events: [
        sequenced('evt-whole', 1),
        sequenced('evt-cut', 2, 'byte_limit'),
        sequenced('evt-shortened', 3, 'output_limit'),
      ],
    });

    const notice = screen.getByTestId('chat-dock-history-elided');
    expect(notice.textContent).toBe(
      '1 earlier item is shown without its content, and 1 tool result is shortened — too large to load in full here. The session still holds the complete content.',
    );
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
    ).toContain('2 earlier items are shown without their content');
    expect(
      screen.getByTestId('chat-dock-history-elided').textContent,
    ).not.toContain('tool result');
  });

  test('reads a single withheld event in the singular', () => {
    renderDock({ events: [sequenced('evt-cut', 1, 'byte_limit')] });

    const notice = screen.getByTestId('chat-dock-history-elided');
    expect(notice.textContent).toContain(
      '1 earlier item is shown without its content',
    );
    // The distinction the marker exists for: withheld by a budget, still
    // held by the session — NOT reclaimed, and not absent from the start.
    expect(notice.textContent).toContain(
      'The session still holds the complete content',
    );
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
