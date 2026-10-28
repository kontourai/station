/**
 * @vitest-environment jsdom
 *
 * archive#4080: the `[TURN_INTERRUPTED]` tag-strip
 * branch in `ChatDockBody.tsx` was only covered incidentally (indirectly, by
 * the surrounding `ChatDockBody.*` suites staying green). This mounts the
 * REAL `SystemEventMessage` — same convention as
 * `ChatDockBody.terminalSessionMarker.test.tsx` — against a transcript
 * carrying the exact `[SYSTEM_EVENT] [TURN_INTERRUPTED]...` marker the
 * boot-time interrupted-turn consumer writes, and asserts the raw bracket
 * tag never reaches the user while the human-readable text does. It offers
 * no resend; Continue is offered only behind its preview (pinned below).
 */

import { agentId } from '@kontourai/station-contracts/agent-identity';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, test, vi } from 'vitest';

const previews = vi.hoisted(() => ({
  current: [] as Array<{ id: string; enabled: boolean }>,
}));
vi.mock('@kontourai/station-sdk', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@kontourai/station-sdk')>()),
  useFeaturePreviewsQuery: () => ({ data: previews.current }),
}));

vi.mock('@kontourai/station-connect', () => ({
  useConnections: () => ({
    activeConnection: { id: 'test', name: 'Test Station' },
    captureCredentialEvidence: () => undefined,
  }),
}));
vi.mock('../contexts/AgentsContext', () => ({
  useAgents: () => [],
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
  ChatInputArea: () => <div data-testid="chat-input-area" />,
}));

vi.mock('../components/chat/QueuedMessages', () => ({
  QueuedMessages: () => null,
}));

import { ChatDockBody } from '../components/chat-dock/ChatDockBody';
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
    sendComposedMessage: vi.fn(async () => true),
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
    id: 'turn-interrupted-session',
    agentSlug: agentId('dev-agent'),
    agentName: 'Dev Agent',
    title: 'Interrupted turn chat',
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

const BANNER_TEXT =
  'Turn interrupted — the process restarted while this turn was in progress.';

function renderDock(session: ChatSession) {
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

describe('ChatDockBody interrupted-turn marker (station#4080 slice 1)', () => {
  test('strips the raw [TURN_INTERRUPTED] tag and shows the human-readable notice', async () => {
    const session = buildSession({
      messages: [
        {
          role: 'user',
          content: 'do the thing',
          timestamp: 1,
        } as any,
        {
          role: 'user',
          content: `[SYSTEM_EVENT] [TURN_INTERRUPTED] ${BANNER_TEXT}`,
          timestamp: 2,
        } as any,
      ],
    });

    renderDock(session);

    expect(await screen.findByText(BANNER_TEXT)).toBeTruthy();
    // The raw bracket tag must never reach the DOM as visible text.
    expect(screen.queryByText(/\[TURN_INTERRUPTED\]/)).toBeNull();
  });

  test('offers no resend/new-chat action for slice 1 (needs-input-only, no auto-resume)', async () => {
    const session = buildSession({
      messages: [
        {
          role: 'user',
          content: 'do the thing',
          timestamp: 1,
        } as any,
        {
          role: 'user',
          content: `[SYSTEM_EVENT] [TURN_INTERRUPTED] ${BANNER_TEXT}`,
          timestamp: 2,
        } as any,
      ],
    });

    renderDock(session);

    await screen.findByText(BANNER_TEXT);
    expect(screen.queryByRole('button', { name: 'Send again' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'New chat' })).toBeNull();
  });
});

/**
 * #2880: the dock states a recorded-but-unacknowledged decision beside the
 * transcript, where it shows even when a stuck turn has no streaming row.
 * This file already mounts the real `ChatDockBody`, so the notice is pinned
 * here rather than in a copy of its harness.
 */
describe('ChatDockBody unacknowledged-decision notice (#2880)', () => {
  const NOTICE =
    'Your decision is recorded, but the engine has not acknowledged it yet. Station has not re-sent it.';
  const REFUSED =
    'Your decision is recorded, but Station did not send it because the engine would not accept that reply. The engine still needs an answer.';

  function noticeText() {
    const notice = document.querySelector(
      '[data-chat-decision-delivery="turn-interrupted-session"]',
    );
    expect(notice?.getAttribute('role')).toBe('status');
    return [...(notice?.querySelectorAll('span') ?? [])].map((span) =>
      span.textContent?.replace(/\s+/g, ' ').trim(),
    );
  }

  test('shows the not-yet notice while a sent decision is unacknowledged', () => {
    renderDock(
      buildSession({
        unacknowledgedDecisions: [
          { requestId: 'req-1', reason: 'no-acknowledgement' },
        ],
      }),
    );
    expect(noticeText()).toEqual([NOTICE]);
  });

  test('a refused reply says it was never sent, not that it awaits acknowledgement', () => {
    renderDock(
      buildSession({
        unacknowledgedDecisions: [
          { requestId: 'req-1', reason: 'invalid-reply' },
        ],
      }),
    );
    expect(noticeText()).toEqual([REFUSED]);
  });

  test('says nothing once every decision is acknowledged', () => {
    renderDock(buildSession({ unacknowledgedDecisions: [] }));
    expect(document.querySelector('[data-chat-decision-delivery]')).toBeNull();
  });
});

/**
 * Continue after a restart (`continue-interrupted-turn` preview): offered on
 * the restart notice, or on the stopped row that says it in the notice's
 * place, only while that interruption is the conversation's latest state.
 */
describe('ChatDockBody Continue after a restart', () => {
  // Pinned literals, not the shared constants: a drift in either is a
  // change in what the person's tap sends.
  const PROMPT =
    'Station restarted while you were working and your last turn was cut off. Continue from where you stopped; check what already finished before redoing anything.';
  const BOUNDARY = 'turn-boundary:3f1c';
  const banner = {
    role: 'user',
    content: `[SYSTEM_EVENT] [TURN_INTERRUPTED] ${BANNER_TEXT}`,
    interruptedTurnBoundaryId: BOUNDARY,
    timestamp: 2,
  } as any;
  const prompt = { role: 'user', content: 'do the thing', timestamp: 1 } as any;

  function renderWith(
    session: ChatSession,
    sendComposedMessage: (...args: unknown[]) => Promise<unknown> = vi.fn(
      async () => true,
    ),
  ) {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const chatInput = { ...buildChatInput(), sendComposedMessage };
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
          chatInput={chatInput as any}
          setShowStatsPanel={vi.fn()}
        />
      </QueryClientProvider>,
    );
    return chatInput;
  }

  beforeEach(() => {
    previews.current = [{ id: 'continue-interrupted-turn', enabled: true }];
  });

  test('sends the fixed prompt keyed on the interruption, once for a double tap', async () => {
    let finish: () => void = () => {};
    const sendComposed = vi.fn(
      () => new Promise<void>((resolve) => (finish = resolve)),
    );
    const chatInput = renderWith(
      buildSession({ messages: [prompt, banner] }),
      sendComposed,
    );

    const action = await screen.findByRole('button', { name: 'Continue' });
    fireEvent.click(action);
    fireEvent.click(action);
    expect(sendComposed).toHaveBeenCalledTimes(1);
    expect(sendComposed).toHaveBeenCalledWith(
      PROMPT,
      `continue-interrupted:${BOUNDARY}`,
    );
    // Not the composer's send: the person's draft is not part of it.
    expect(chatInput.handleSend).not.toHaveBeenCalled();
    await act(async () => finish());
  });

  test('is offered under the stopped row that took the notice’s place', async () => {
    const sendComposed = renderWith(
      buildSession({
        messages: [
          prompt,
          {
            role: 'assistant',
            content: '',
            turnId: 'turn-1',
            turnEnded: 'aborted',
            turnStoppedBy: 'restart',
            interruptedTurnBoundaryId: BOUNDARY,
            timestamp: 2,
          } as any,
        ],
      }),
    ).sendComposedMessage;

    expect(await screen.findByText('Station restarted mid-turn')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    expect(sendComposed).toHaveBeenCalledWith(
      PROMPT,
      `continue-interrupted:${BOUNDARY}`,
    );
  });

  test('is not offered once a newer message follows the interruption', async () => {
    renderWith(
      buildSession({
        messages: [
          prompt,
          banner,
          { role: 'user', content: 'what now?', timestamp: 3 } as any,
        ],
      }),
    );
    await screen.findByText(BANNER_TEXT);
    expect(screen.queryByRole('button', { name: 'Continue' })).toBeNull();
  });

  test('is not offered while a turn is running', async () => {
    renderWith(buildSession({ messages: [prompt, banner], status: 'sending' }));
    await screen.findByText(BANNER_TEXT);
    expect(screen.queryByRole('button', { name: 'Continue' })).toBeNull();
  });

  test('is not offered while a message waits to send', async () => {
    renderWith(
      buildSession({ messages: [prompt, banner], queuedMessages: ['next'] }),
    );
    await screen.findByText(BANNER_TEXT);
    expect(screen.queryByRole('button', { name: 'Continue' })).toBeNull();
  });

  test('is not offered while the preview is off', async () => {
    previews.current = [{ id: 'continue-interrupted-turn', enabled: false }];
    renderWith(buildSession({ messages: [prompt, banner] }));
    await screen.findByText(BANNER_TEXT);
    expect(screen.queryByRole('button', { name: 'Continue' })).toBeNull();
  });

  test('is not offered for a notice that names no interruption', async () => {
    const { interruptedTurnBoundaryId: _id, ...unnamed } = banner;
    renderWith(buildSession({ messages: [prompt, unnamed] }));
    await screen.findByText(BANNER_TEXT);
    expect(screen.queryByRole('button', { name: 'Continue' })).toBeNull();
  });
});
