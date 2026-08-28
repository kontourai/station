/** @vitest-environment jsdom */

import { agentId } from '@kontourai/station-contracts/agent-identity';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import { useEffect } from 'react';
import { describe, expect, test, vi } from 'vitest';

const fetchCapability = vi.hoisted(() => vi.fn());
const fetchWindow = vi.hoisted(() => vi.fn());
const fetchConversationWindow = vi.hoisted(() => vi.fn());
const transcriptMounts = vi.hoisted(() => vi.fn());
const queueMounts = vi.hoisted(() => vi.fn());
const composerProps = vi.hoisted(() => vi.fn());

vi.mock('@kontourai/station-sdk', () => ({
  fetchSessionEventWindowCapability: (...args: unknown[]) =>
    fetchCapability(...args),
  fetchOrchestrationSessionEventWindow: (...args: unknown[]) =>
    fetchWindow(...args),
  fetchOrchestrationConversationEventWindow: (...args: unknown[]) =>
    fetchConversationWindow(...args),
  claimSessionEventWindowCapabilityRecovery: () => false,
  resetSessionEventWindowCapabilityRecovery: vi.fn(),
  SESSION_EVENT_WINDOW_CAPABILITY_RETRY_MS: 30_000,
  SESSION_EVENT_WINDOW_UNSUPPORTED_RETRY_MS: 60_000,
  // archive#3764: the empty-transcript filler renders `ChatEmptyState`, which
  // reads system status to decide between the guided rescue and the normal copy.
  useSystemStatusForApiBaseQuery: () => ({ data: undefined }),
}));
vi.mock('@kontourai/station-connect', () => ({
  useConnections: () => ({ activeConnection: null }),
}));
vi.mock('../contexts/AgentsContext', () => ({
  useAgents: () => [],
  // archive#3764: the empty-transcript filler renders `ChatEmptyState`.
  useAgentsLoaded: () => true,
}));
vi.mock('../contexts/ApiBaseContext', () => ({
  useApiBase: () => ({ apiBase: 'http://station.test' }),
}));
vi.mock('../contexts/AuthContext', () => ({ useAuth: () => ({ user: null }) }));
vi.mock('../contexts/NavigationContext', () => ({
  useNavigation: () => ({ navigate: vi.fn() }),
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
vi.mock('../hooks/useShareReceiver', () => ({ useShareReceiver: () => {} }));
vi.mock('../hooks/useSTT', () => ({
  useSTT: () => ({ state: 'idle', transcript: '' }),
}));
vi.mock('../hooks/useTTS', () => ({ useTTS: () => ({ speak: vi.fn() }) }));
vi.mock('../components/chat/ChatInputArea', () => ({
  ChatInputArea: (props: unknown) => {
    composerProps(props);
    return null;
  },
}));
const queuedMessagesProps = vi.hoisted(() => vi.fn());
vi.mock('../components/chat/QueuedMessages', () => ({
  QueuedMessages: (props: unknown) => {
    queuedMessagesProps(props);
    return null;
  },
}));
vi.mock('../components/chat/ChatMessageList', () => ({
  ChatMessageList: ({ activeSession }: any) => {
    useEffect(() => {
      transcriptMounts();
    }, []);
    return (
      <div data-testid="transcript">
        {activeSession.messages
          .map((message: any) => message.content)
          .join('\n')}
      </div>
    );
  },
}));
vi.mock('../components/chat/OutboundQueuedMessages', () => ({
  OutboundQueuedMessages: () => {
    useEffect(() => {
      queueMounts();
    }, []);
    return <div data-testid="offline-queue">Offline queue</div>;
  },
}));

import { ChatDockBody } from '../components/chat-dock/ChatDockBody';
import type { ChatSession } from '../types';

const chatInput = {
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

function session(revision: number): ChatSession {
  return {
    id: 'offline-thread',
    agentSlug: agentId('dev-agent'),
    agentName: 'Dev Agent',
    title: 'Offline chat',
    source: 'manual',
    input: '',
    attachments: [],
    queuedMessages: [],
    inputHistory: [],
    hasUnread: false,
    status: 'idle',
    createdAt: 1,
    updatedAt: revision,
    messages: [],
    orchestrationSessionStarted: true,
    orchestrationHistoryRevision: revision,
    outboundQueuedTurns: [
      {
        clientTurnId: 'queued-1',
        content: 'queued while offline',
        createdAt: 1,
        status: 'pending',
      },
    ],
  } as ChatSession;
}

function dock(current: ChatSession) {
  return (
    <QueryClientProvider
      client={
        new QueryClient({ defaultOptions: { queries: { retry: false } } })
      }
    >
      <ChatDockBody
        activeSession={current}
        chatFontSize={14}
        dockHeight={400}
        showStatsPanel={false}
        showReasoning={false}
        showToolDetails={false}
        modelSupportsAttachments={false}
        fileAttachmentsSupported={false}
        availableModels={[]}
        chatInput={chatInput as any}
        setShowStatsPanel={vi.fn()}
      />
    </QueryClientProvider>
  );
}

describe('ChatDockBody offline settling (station#2605)', () => {
  test('derives the composer refusal from the durable queue refusal signal', async () => {
    const refused = session(0);
    refused.outboundQueuedTurns = [
      {
        clientTurnId: 'queued-1',
        content: 'queued while offline',
        createdAt: 1,
        status: 'failed',
        lastError: 'Workspace refusal: original workspace unavailable',
      },
    ];

    render(dock(refused));

    await waitFor(() =>
      expect(composerProps).toHaveBeenLastCalledWith(
        expect.objectContaining({ workspaceRefused: true }),
      ),
    );
  });

  test('dismissing the refused turn returns the composer to normal', async () => {
    // Recovery is the same derivation running over the remaining turns:
    // once the durable refused row is gone, workspaceRefused re-derives
    // false and ordinary Send returns (the transition
    // itself was previously untested).
    const refused = session(0);
    refused.outboundQueuedTurns = [
      {
        clientTurnId: 'queued-1',
        content: 'queued while offline',
        createdAt: 1,
        status: 'failed',
        lastError: 'Workspace refusal: original workspace unavailable',
      },
    ];

    const { rerender } = render(dock(refused));
    await waitFor(() =>
      expect(composerProps).toHaveBeenLastCalledWith(
        expect.objectContaining({ workspaceRefused: true }),
      ),
    );

    const cleared = session(0);
    cleared.outboundQueuedTurns = [];
    rerender(dock(cleared));
    await waitFor(() =>
      expect(composerProps).toHaveBeenLastCalledWith(
        expect.objectContaining({ workspaceRefused: false }),
      ),
    );
  });

  test('keeps loaded transcript and queue components mounted through repeated rejected history reloads', async () => {
    fetchConversationWindow.mockReset();
    fetchCapability.mockResolvedValue(true);
    fetchConversationWindow
      .mockResolvedValueOnce({
        protocolVersion: 1,
        conversationId: 'offline-thread',
        // This fixture is deliberately the one-session legacy/root shape: a
        // later handoff would point this field at the newest child session.
        currentSessionId: 'offline-thread',
        watermark: 1,
        hasMore: false,
        events: [
          {
            sequence: 1,
            event: {
              eventId: 'turn-1',
              method: 'turn.started',
              provider: 'codex',
              threadId: 'offline-thread',
              createdAt: '2026-08-13T00:00:00.000Z',
              prompt: 'Saved transcript',
            },
          },
        ],
      })
      .mockRejectedValue(new Error('Station unreachable'));
    const view = render(dock(session(0)));
    await screen.findByTestId('transcript');
    await screen.findByTestId('offline-queue');
    expect(screen.getByTestId('transcript').textContent).toContain(
      'Saved transcript',
    );
    const firstTranscriptMounts = transcriptMounts.mock.calls.length;
    const firstQueueMounts = queueMounts.mock.calls.length;

    for (const revision of [1, 2, 3]) {
      view.rerender(dock(session(revision)));
      await waitFor(() =>
        expect(fetchConversationWindow).toHaveBeenCalledTimes(revision + 1),
      );
      expect(screen.getByTestId('transcript').textContent).toContain(
        'Saved transcript',
      );
      expect(screen.queryByText('Loading conversation')).toBeNull();
      expect(screen.queryByText('Loading offline messages')).toBeNull();
    }

    expect(transcriptMounts).toHaveBeenCalledTimes(firstTranscriptMounts);
    expect(queueMounts).toHaveBeenCalledTimes(firstQueueMounts);
  });
  test('canSteer derives from capability AND live execution — idle sessions offer no steer', async () => {
    // Server enforcement (typed refusal) is the backstop, but the issue
    // requires the AFFORDANCE to be absent without an active turn: pin the
    // ChatDockBody derivation, not just the row component's prop handling.
    const idle = session(0);
    idle.orchestrationProvider = 'claude';
    idle.queuedMessages = ['queued steer'];
    const view = render(dock(idle));
    // Wait for the ASSERTION, not merely for the first call: the derivation
    // settles across a re-render, so waiting on "has been called" and then
    // asserting on the LAST call reads whichever render happened to land
    // first. Under corpus load that is the pre-settle render, which made this
    // file fail in four consecutive full-regression runs while passing in
    // isolation. Matches the pattern the rest of this file already uses.
    await waitFor(() =>
      expect(queuedMessagesProps).toHaveBeenLastCalledWith(
        expect.objectContaining({ canSteer: false }),
      ),
    );

    queuedMessagesProps.mockClear();
    const active = session(0);
    active.orchestrationProvider = 'claude';
    active.queuedMessages = ['queued steer'];
    active.status = 'sending';
    view.rerender(dock(active));
    await waitFor(() =>
      expect(queuedMessagesProps).toHaveBeenLastCalledWith(
        expect.objectContaining({ canSteer: true }),
      ),
    );
  });
});
