/**
 * @vitest-environment jsdom
 *
 * archive#3299 (defect 1): one stream failure rendered TWICE — once as the
 * turn-adjacent card in the transcript and again as the session failure
 * banner under the composer. Sharing the translation (`translateChatError`)
 * is right; what was missing is arbitration over which surface OWNS the
 * presentation for a given failure.
 *
 * The decided ownership: the transcript surface (the `[CHAT_ERROR]` marker
 * card / the ephemeral failure notice / the projected error row) owns a
 * failure it already carries, because it sits with the turn it belongs to.
 * The banner is the COLD-ARRIVAL surface (archive#3213: a deep link at an
 * already-failed session whose transcript carries nothing) and must keep
 * rendering there — these tests pin both directions.
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
  // archive#3764: the dock's empty-transcript filler renders `ChatEmptyState`,
  // which gates its guided variant on the catalog's loaded state.
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

vi.mock('../components/chat/ChatInputArea', () => ({
  ChatInputArea: () => <div data-testid="chat-input-area" />,
}));

vi.mock('../components/chat/QueuedMessages', () => ({
  QueuedMessages: () => null,
}));

import type { OrchestrationSessionSummary } from '@kontourai/station-sdk';
import { ChatDockBody } from '../components/chat-dock/ChatDockBody';
import type { ChatSession } from '../types';

const RAW_STREAM_ERROR =
  "Failed to execute 'close' on 'ReadableStreamDefaultController': Unexpected end of JSON input";

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
    id: 'failure-ownership-session',
    agentSlug: agentId('dev-agent'),
    agentName: 'Dev Agent',
    title: 'Failure ownership chat',
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

function failedOrchestrationSession(): OrchestrationSessionSummary {
  // archive#1778/archive#3241: no cast. The previous cast was hiding `status:
  // 'errored'`, which the wire shape does not admit (the union spells it
  // `error`), so this fixture described a session that cannot occur.
  return {
    threadId: 'failure-ownership-session',
    provider: 'claude',
    lifecycleState: 'failed',
    status: 'error',
    controlMode: 'station-owned',
    blockedReason: RAW_STREAM_ERROR,
    answerability: { answerable: true },
    isLoaded: true,
    isPersisted: true,
    eventCount: 4,
    createdAt: '2026-08-19T00:00:00.000Z',
    updatedAt: '2026-08-19T00:05:00.000Z',
  };
}

function renderDock(
  session: ChatSession,
  activeOrchestrationSession: OrchestrationSessionSummary | null,
  chatInput: ReturnType<typeof buildChatInput> = buildChatInput(),
) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <ChatDockBody
        activeSession={session}
        activeOrchestrationSession={activeOrchestrationSession}
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
        onNewChat={vi.fn()}
      />
    </QueryClientProvider>,
  );
}

describe('ChatDockBody session-failure ownership (station#3299)', () => {
  test('REPRO: a failure the transcript already carries renders exactly once — the banner defers to the turn-adjacent card', async () => {
    // The live shape: `handleRuntimeErrorEvent` appended the failure marker
    // into this chat's messages when the runtime.error arrived, and the
    // server's session record folded to failed with the same cause mirrored
    // in blockedReason. One failure, one rendering.
    const session = buildSession({
      messages: [
        { role: 'user', content: 'summarize this repo', timestamp: 1 },
        {
          role: 'user',
          content: `[SYSTEM_EVENT] [CHAT_ERROR] ${RAW_STREAM_ERROR}`,
          timestamp: 2,
        },
      ] as ChatSession['messages'],
    });

    renderDock(session, failedOrchestrationSession());

    // The transcript card renders the failure (translated). ChatMessageList
    // mounts through a LazyBoundary, so wait for the card to appear.
    await waitFor(() =>
      expect(document.querySelector('.system-event')).toBeTruthy(),
    );
    // The session banner defers: one failure must not have two surfaces and
    // two dismiss/retry targets in the same frame.
    expect(screen.queryByTestId('chat-dock-session-failure')).toBeNull();
  });

  test('cold arrival at a failed session still renders the banner (station#3213 preserved)', () => {
    // Deep link / tab switch: the transcript carries nothing about the
    // failure — the banner is the only surface that can say it.
    const session = buildSession({
      messages: [
        { role: 'user', content: 'summarize this repo', timestamp: 1 },
      ] as ChatSession['messages'],
    });

    renderDock(session, failedOrchestrationSession());

    expect(screen.getByTestId('chat-dock-session-failure')).toBeTruthy();
  });

  // the exact live shape. `handleRuntimeErrorEvent`
  // writes the cause into the streaming shell AND flips `status` to `error` in
  // the same update, which suppresses that shell — so the text was present in
  // state, ownership stood down for it, and the reader saw a red Failed chip
  // over a transcript that just stopped. Ownership must follow a VISIBLE
  // element, not a string.
  test('REPRO: a failure that only exists in the suppressed streaming shell still gets a visible reason', () => {
    const session = buildSession({
      status: 'error',
      messages: [
        { role: 'user', content: 'summarize this repo', timestamp: 1 },
      ] as ChatSession['messages'],
      streamingMessage: {
        role: 'assistant',
        content: '',
        contentParts: [{ type: 'text', content: RAW_STREAM_ERROR }],
      },
    } as Partial<ChatSession>);

    renderDock(session, failedOrchestrationSession());

    expect(screen.getByTestId('chat-dock-session-failure')).toBeTruthy();
  });

  test.each([
    ['no turnId', undefined],
    ['a turnId', 'turn-1'],
  ])(
    'a mid-turn runtime.error with %s produces exactly one visible reason element',
    async (_name, turnId) => {
      const session = buildSession({
        status: 'error',
        messages: [
          { role: 'user', content: 'summarize this repo', timestamp: 1 },
          {
            role: 'user',
            content: `[SYSTEM_EVENT] [CHAT_ERROR] ${RAW_STREAM_ERROR}`,
            timestamp: 2,
            ...(turnId ? { turnId } : {}),
          },
        ] as ChatSession['messages'],
        streamingMessage: {
          role: 'assistant',
          content: '',
          contentParts: [{ type: 'text', content: RAW_STREAM_ERROR }],
        },
      } as Partial<ChatSession>);

      renderDock(session, failedOrchestrationSession());

      await waitFor(() =>
        expect(document.querySelector('.system-event')).toBeTruthy(),
      );
      expect(document.querySelectorAll('.system-event')).toHaveLength(1);
      expect(screen.queryByTestId('chat-dock-session-failure')).toBeNull();
    },
  );

  /**
   * archive#3769: the DURABLE arrival, beside the live one above. A thread
   * cold-opened from its event window replays `turn.started` →
   * `runtime.error` → `turn.aborted` through
   * `packages/shared/src/runtime-event-projection.ts`, which writes the cause
   * as an ordinary assistant text part carrying `runtimeError: true`. That row
   * renders, so the banner must defer to it exactly as it does to the live
   * `[CHAT_ERROR]` marker — otherwise the reader gets the raw cause under the
   * turn AND a translated banner under that, one incident in two vocabularies.
   *
   * The existing "cold arrival" case above defines itself as a transcript that
   * carries NOTHING about the failure, so this shape — transcript carries it,
   * from events rather than from a marker — was untested.
   */
  test('REPRO: a failure replayed from the durable event window renders once — the banner defers to the projected row', () => {
    const session = buildSession({
      messages: [
        { role: 'user', content: 'summarize this repo', timestamp: 1 },
        {
          role: 'assistant',
          content: '',
          contentParts: [
            {
              type: 'text',
              content: `⚠️ ${RAW_STREAM_ERROR}`,
              runtimeError: true,
            },
          ],
          timestamp: 2,
        },
      ] as ChatSession['messages'],
    });

    renderDock(session, failedOrchestrationSession());

    expect(screen.queryByTestId('chat-dock-session-failure')).toBeNull();
  });

  /**
   * The discriminating half: the SAME visible text with no projection marker
   * on it is not a failure surface. Ownership follows the projection's own
   * flag, so a message that merely quotes the cause cannot silence the banner.
   */
  test('an unmarked row quoting the same cause does not silence the banner', () => {
    const session = buildSession({
      messages: [
        { role: 'user', content: 'summarize this repo', timestamp: 1 },
        {
          role: 'assistant',
          content: '',
          contentParts: [{ type: 'text', content: `⚠️ ${RAW_STREAM_ERROR}` }],
          timestamp: 2,
        },
      ] as ChatSession['messages'],
    });

    renderDock(session, failedOrchestrationSession());

    expect(screen.getByTestId('chat-dock-session-failure')).toBeTruthy();
  });

  test('a healthy session renders no banner at all', () => {
    const session = buildSession({ status: 'idle' });
    renderDock(session, null);
    expect(screen.queryByTestId('chat-dock-session-failure')).toBeNull();
  });
});

// #765 A2/A3: the stall watchdog's `progressSilence` projection, surfaced in
// the chat it is about. Before this the server logged
// `Turn stall detected (observe-only)` and only Home/Sessions rows showed
// it; the affected chat said "Working…" indefinitely with no Stop pointer.
describe('ChatDockBody turn-stall notice (#765)', () => {
  function stalledOrchestrationSession(): OrchestrationSessionSummary {
    return {
      threadId: 'failure-ownership-session',
      provider: 'claude',
      lifecycleState: 'running',
      status: 'running',
      controlMode: 'station-owned',
      hasActiveTurn: true,
      turnProgress: {
        lastProgressEventAt: '2026-08-29T12:00:00.000Z',
        progressSilence: {
          detectedAt: '2026-08-29T12:03:00.000Z',
          windowMs: 180_000,
          silentSinceEventAt: '2026-08-29T12:00:00.000Z',
          provider: 'claude',
        },
      },
      answerability: { answerable: true },
      isLoaded: true,
      isPersisted: true,
      eventCount: 4,
      createdAt: '2026-08-29T11:00:00.000Z',
      updatedAt: '2026-08-29T12:03:00.000Z',
    };
  }

  test('renders the stall notice with a working stop affordance while the turn is in flight', () => {
    const chatInput = buildChatInput();
    // `isTurnInFlight` — status 'sending' is the local in-flight signal.
    const session = buildSession({ status: 'sending' });
    renderDock(session, stalledOrchestrationSession(), chatInput);

    expect(screen.getByTestId('chat-dock-turn-stall-notice')).toBeTruthy();
    expect(screen.getByText(/appears stalled/i)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /stop this turn/i }));
    expect(chatInput.handleCancel).toHaveBeenCalledTimes(1);
  });

  test('renders no stall notice once the turn has settled, even with a stale projection', () => {
    const session = buildSession({ status: 'idle' });
    renderDock(session, stalledOrchestrationSession());
    expect(screen.queryByTestId('chat-dock-turn-stall-notice')).toBeNull();
  });

  test('renders no stall notice for a healthy in-flight turn', () => {
    const summary = stalledOrchestrationSession();
    delete (summary as { turnProgress?: unknown }).turnProgress;
    const session = buildSession({ status: 'sending' });
    renderDock(session, summary);
    expect(screen.queryByTestId('chat-dock-turn-stall-notice')).toBeNull();
  });
});
