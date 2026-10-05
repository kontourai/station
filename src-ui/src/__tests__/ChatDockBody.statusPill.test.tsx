/**
 * @vitest-environment jsdom
 *
 * The chat pane's composer status pill, at the pane (ChatDockBody): a live
 * chat presents approval, connection and turn activity in ONE composer
 * element, and none of the inline surfaces it replaced (the reconnect
 * banner above the composer, the "Awaiting tool approval" row, the typing
 * dots) render beside it. A replay keeps its inline rows.
 */

import { agentId } from '@kontourai/station-contracts/agent-identity';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, render, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, test, vi } from 'vitest';

const agentsMock = vi.hoisted(() => ({ current: [] as any[] }));

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

vi.mock('../components/chat/ChatInputArea', () => ({
  ChatInputArea: ({ activity }: { activity?: ReactNode }) => (
    <div data-testid="chat-input-area">{activity}</div>
  ),
}));

vi.mock('../components/chat/QueuedMessages', () => ({
  QueuedMessages: () => null,
}));

import { ChatDockBody } from '../components/chat-dock/ChatDockBody';
import {
  getApprovalClaims,
  OPEN_APPROVAL_QUEUE_EVENT,
} from '../components/status/approvalReveal';
import { setStreamConnectionState } from '../hooks/orchestration/streamConnectionState';
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

afterEach(() => {
  vi.useRealTimers();
});

const pill = () => document.querySelector('[data-chat-status-pill]');

describe('ChatDockBody composer status pill', () => {
  test('a pending approval is the pill, and no inline approval row repeats it', async () => {
    renderDock(
      buildSession({
        status: 'sending',
        isThinking: true,
        orchestrationStatus: 'awaiting-approval',
        pendingApprovals: ['req-1'],
        messages: [
          { role: 'user', content: 'Edit it', timestamp: 1 },
          { role: 'assistant', content: 'Editing.', timestamp: 2 },
        ],
      } as Partial<ChatSession>),
    );
    await waitFor(() =>
      expect(pill()?.getAttribute('data-chat-status-pill')).toBe('approval'),
    );
    expect(pill()?.textContent).toContain('Needs approval');
    // The mounted pill owns this chat's approval, so the app-wide pill does
    // not float a duplicate over the pane.
    await waitFor(() =>
      expect(getApprovalClaims().has(buildSession().id)).toBe(true),
    );
    // The transcript (a lazy chunk) has rendered the assistant row…
    await screen.findByText('Editing.');
    // …without the inline status the pill replaces.
    expect(screen.queryByText(/Awaiting tool approval/)).toBeNull();
    expect(document.querySelector('.message__thinking')).toBeNull();
  });

  test('a stream outage is the pill, not a banner above the composer', async () => {
    // The pill's chunk loads on demand; let it land before faking time.
    await import('../components/status/ChatStatusPillView');
    vi.useFakeTimers();
    const apiBase = 'http://localhost:3242';
    setStreamConnectionState(apiBase, 'caught-up');
    renderDock(buildSession());
    await act(async () => {
      await vi.advanceTimersByTimeAsync(50);
    });
    act(() => {
      setStreamConnectionState(apiBase, 'interrupted');
    });
    act(() => {
      vi.advanceTimersByTime(3000);
    });
    expect(pill()?.getAttribute('data-chat-status-pill')).toBe('reconnecting');
    expect(document.querySelector('.chat-stream-status')).toBeNull();
    act(() => {
      setStreamConnectionState(apiBase, 'caught-up');
    });
  });

  test('a live turn shows what it is doing in the pill', async () => {
    renderDock(
      buildSession({
        orchestrationSessionStarted: true,
        orchestrationTurnOpen: true,
        status: 'sending',
        messages: [{ role: 'user', content: 'Go', timestamp: 1 }],
      } as Partial<ChatSession>),
    );
    await waitFor(() =>
      expect(pill()?.getAttribute('data-chat-status-pill')).toBe('working'),
    );
    expect(pill()?.textContent).toContain('Working');
  });

  test('a request the user already answered is no longer an approval in the pill', async () => {
    renderDock(
      buildSession({
        orchestrationSessionStarted: true,
        orchestrationTurnOpen: true,
        status: 'sending',
        // Still open on the server until `request.resolved`, but answered.
        orchestrationStatus: 'awaiting-approval',
        pendingApprovals: ['req-1'],
        answeredApprovals: ['req-1'],
        messages: [{ role: 'user', content: 'Go', timestamp: 1 }],
      } as Partial<ChatSession>),
    );
    await waitFor(() =>
      expect(pill()?.getAttribute('data-chat-status-pill')).toBe('working'),
    );
    expect(getApprovalClaims().has(buildSession().id)).toBe(false);
  });

  test('an approval the pill cannot bring on screen opens the approval queue', async () => {
    renderDock(
      buildSession({
        status: 'sending',
        orchestrationStatus: 'awaiting-approval',
        pendingApprovals: ['req-offscreen'],
      } as Partial<ChatSession>),
    );
    await waitFor(() =>
      expect(pill()?.getAttribute('data-chat-status-pill')).toBe('approval'),
    );
    const opened = vi.fn();
    window.addEventListener(OPEN_APPROVAL_QUEUE_EVENT, opened);
    (pill() as HTMLButtonElement).click();
    await waitFor(() => expect(opened).toHaveBeenCalledTimes(1));
    window.removeEventListener(OPEN_APPROVAL_QUEUE_EVENT, opened);
  });

  test('if the pill cannot load, the inline status comes back and nothing is claimed', async () => {
    vi.resetModules();
    vi.doMock('../components/status/ChatStatusPillView', () => {
      throw new Error('chunk failed to load');
    });
    const { ChatDockBody: FreshDockBody } = await import(
      '../components/chat-dock/ChatDockBody'
    );
    const { getApprovalClaims } = await import(
      '../components/status/approvalReveal'
    );
    agentsMock.current = [
      { slug: agentId('codex'), name: 'Codex', available: true },
    ];
    render(
      <QueryClientProvider client={new QueryClient()}>
        <FreshDockBody
          activeSession={buildSession({
            status: 'sending',
            isThinking: true,
            orchestrationStatus: 'awaiting-approval',
            pendingApprovals: ['req-1'],
            messages: [
              { role: 'user', content: 'Edit it', timestamp: 1 },
              { role: 'assistant', content: 'Editing.', timestamp: 2 },
            ],
          } as Partial<ChatSession>)}
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
    // The transcript's own approval status is back…
    await screen.findByText(/Awaiting tool approval/);
    expect(pill()).toBeNull();
    // …and the app-wide queue still owns this chat's approval.
    expect(getApprovalClaims().size).toBe(0);
    vi.doUnmock('../components/status/ChatStatusPillView');
  });
});
