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
 * Every test here is a COLD arrival: no live event has been handled, the local
 * `ChatSession` carries no error, and nothing is streaming. That is the state
 * the dock rendered silently.
 */

import { agentId } from '@kontourai/station-contracts/agent-identity';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, within } from '@testing-library/react';
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

const LONG_UNBREAKABLE_REASON =
  'Engine transport failed: ECONNREFUSED api.internal.example.com:8443 while resolving /Users/operator/dev/github/kontourai/station-worktrees/fix-3213-dock-failure/node_modules/.bin/claude-code-runner';

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
  read,
  onRetryOrchestrationSessions = vi.fn(),
}: {
  orchestrationSession?: any;
  session?: ChatSession;
  events?: any[];
  read?: 'pending' | 'error' | 'present' | 'absent';
  onRetryOrchestrationSessions?: () => void;
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
    agentsMock.current = [];
    transcriptMock.events = [];
    chatInputPropsMock.current = null;
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

  test('the banner is announced as an alert, reachable by role', () => {
    renderDock({
      orchestrationSession: buildOrchestrationSession({
        blockedReason: 'Engine crashed',
      }),
    });

    const alerts = screen.getAllByRole('alert');
    expect(
      alerts.some((alert) => alert.textContent?.includes('Engine crashed')),
    ).toBe(true);
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
  test('the banner says the session can be continued, and the composer stays usable', () => {
    renderDock({
      orchestrationSession: buildOrchestrationSession({
        blockedReason: 'Engine crashed',
      }),
    });

    expect(
      screen.getByTestId('chat-dock-session-failure').textContent,
    ).toContain('You can send a message to try to continue this session.');
    expect(screen.getByTestId('chat-input-area')).toBeTruthy();
    expect(chatInputPropsMock.current?.disabled).toBe(false);
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
  test('a chat with no server session record renders no banner', () => {
    renderDock({ orchestrationSession: null });

    expect(screen.queryByTestId('chat-dock-session-failure')).toBeNull();
    expect(screen.getByTestId('chat-input-area')).toBeTruthy();
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
      screen.getByRole('status', { name: "Reading this session's record" }),
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
      screen.getByText("Could not read this Station's session records"),
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

  test('#749 keeps the composer disabled while a reloaded conversation is resolving', () => {
    renderDock({
      session: buildSession({
        conversationId: 'cool',
        conversationOpenPending: true,
      }),
    });

    expect(chatInputPropsMock.current?.disabled).toBe(true);
    expect(
      screen.getByText('Station is resolving its current session.'),
    ).toBeTruthy();
  });

  test('#749 transport failure remains read-only and exposes recovery actions', () => {
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
    expect(chatInputPropsMock.current?.disabled).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    fireEvent.click(screen.getByRole('button', { name: 'Start new chat' }));
    expect(onRetryConversationOpen).toHaveBeenCalledOnce();
    expect(onNewChat).toHaveBeenCalledOnce();
  });

  test('#749 respects canContinue rather than Agent availability', () => {
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
      session: buildSession({
        conversationOpenState: { ...base, canContinue: false },
      }),
    });
    expect(chatInputPropsMock.current?.disabled).toBe(true);
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
    expect(chatInputPropsMock.current?.disabled).toBe(false);
  });
});
