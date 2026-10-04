/**
 * @vitest-environment jsdom
 *
 * #3157: the usage-limit banner reaches the real dock. `usageLimitStopped`
 * lives in the active-chats store (set by the live `runtime.error` and by
 * snapshots); the dock reads it off the session `useDerivedSessions` builds
 * and mounts the banner on it. This drives that whole path (store -> real
 * `useDerivedSessions` -> real `ChatDockBody` -> real `UsageLimitBanner` ->
 * real query hook), with only the network stubbed to the server's envelope.
 */

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

const STABLE_AGENTS = [{ slug: 'agent-one', name: 'Agent One' }];

vi.mock('@kontourai/station-connect', () => ({
  useConnections: () => ({
    activeConnection: { id: 'test', name: 'Test Station' },
    captureCredentialEvidence: () => undefined,
  }),
}));
vi.mock('../contexts/AgentsContext', () => ({
  useAgents: () => STABLE_AGENTS,
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
vi.mock('../hooks/useToolApproval', () => ({
  useToolApproval: () => vi.fn(),
}));
vi.mock('../hooks/useActiveChatSessions', () => ({
  useSendMessage: () => vi.fn(),
}));
vi.mock('../components/chat/StreamingMessage', () => ({
  StreamingMessage: () => <div data-testid="streaming-message" />,
}));
vi.mock('../components/icons/UserIcon', () => ({
  UserIcon: () => <span aria-hidden="true">U</span>,
}));
vi.mock('../contexts/ActiveChatsContext', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../contexts/ActiveChatsContext')>();
  const { activeChatsStore } = await import('../contexts/active-chats-store');
  return {
    ...actual,
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
vi.mock('../hooks/useShareReceiver', () => ({ useShareReceiver: () => {} }));
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

import type { CanonicalRuntimeEvent } from '@kontourai/station-contracts/runtime-events';
import { buildOrchestrationSessionSummary } from '../../../src-server/services/orchestration/orchestration-session-state';
import { ChatDockBody } from '../components/chat-dock/ChatDockBody';
import { activeChatsStore } from '../contexts/active-chats-store';
import { useDerivedSessions } from '../hooks/useDerivedSessions';

const SESSION = 'usage-limit-session';

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

/** The dock as ChatDock builds it: its session comes from the derivation hook. */
let summary: Record<string, unknown> | null = null;
function DerivedDock() {
  const session = useDerivedSessions('', null, null).find(
    (s) => s.id === SESSION,
  );
  if (!session) return null;
  return (
    <ChatDockBody
      activeSession={session}
      activeOrchestrationSession={summary as never}
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
  );
}

function clearChats() {
  for (const id of Object.keys(activeChatsStore.getSnapshot())) {
    activeChatsStore.removeChat(id);
  }
}

const USAGE_LIMIT_EVENTS: CanonicalRuntimeEvent[] = [
  {
    eventId: 'e-start',
    provider: 'claude',
    threadId: SESSION,
    turnId: 't1',
    createdAt: '2026-09-24T21:00:00.000Z',
    method: 'turn.started',
    prompt: 'Finish the migration.',
  },
  {
    eventId: 'e-limit',
    provider: 'claude',
    threadId: SESSION,
    turnId: 't1',
    createdAt: '2026-09-24T21:00:01.000Z',
    method: 'runtime.error',
    severity: 'error',
    code: 'engine-turn-failed',
    retriable: false,
    message: "You've hit your usage limit.",
    details: { usageLimit: true, scope: 'account' },
  },
];

/** The summary the server's own producer builds for these events. */
function realSummary(events: CanonicalRuntimeEvent[]) {
  return buildOrchestrationSessionSummary({
    persisted: {
      provider: 'claude',
      threadId: SESSION,
      status: 'ready',
      createdAt: '2026-09-24T21:00:00.000Z',
      updatedAt: '2026-09-24T21:00:01.000Z',
    },
    events,
    answerability: {
      threadAttachment: 'detached',
      providerRegistered: true,
      observedBy: 'test',
      observedAt: '2026-09-24T21:00:02.000Z',
    },
  }) as unknown as Record<string, unknown>;
}

const PROJECTION = {
  failureKind: 'rate-limit',
  scope: 'account',
  decision: 'wait-until-reset',
  outcome: 'armed',
  dueAt: '2099-01-01T23:00:00.000Z',
  attempts: 0,
  maxAttempts: 1,
  usageLimit: true,
  autoResume: false,
  updatedAt: '2026-09-24T21:00:00.000Z',
};
let requested: string[];

describe('ChatDockBody usage-limit banner (#3157)', () => {
  beforeEach(() => {
    clearChats();
    summary = null;
    requested = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        requested.push(String(input instanceof Request ? input.url : input));
        return new Response(
          JSON.stringify({ success: true, data: { recovery: PROJECTION } }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }),
    );
    activeChatsStore.initChat(SESSION, {
      agentSlug: 'agent-one',
      agentName: 'Agent One',
      title: 'Stopped on a usage limit',
    });
  });

  afterEach(() => {
    cleanup();
    clearChats();
    vi.unstubAllGlobals();
  });

  function mountDock() {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    return render(
      <QueryClientProvider client={queryClient}>
        <DerivedDock />
      </QueryClientProvider>,
    );
  }

  test('a conversation the snapshot calls limited shows the banner from the server projection, and a turn starting removes it', async () => {
    mountDock();
    expect(screen.queryByTestId('usage-limit-banner')).toBeNull();
    expect(requested).toEqual([]);

    act(() => {
      activeChatsStore.updateChat(SESSION, { usageLimitStopped: true });
    });
    const banner = await screen.findByTestId('usage-limit-banner');
    expect(banner.textContent).toContain('Usage limit reached · Resets');
    expect(banner.textContent).toContain('Auto-resume is off.');
    expect(requested).toEqual([
      `http://localhost:3242/api/orchestration/sessions/${SESSION}/usage-limit`,
    ]);

    act(() => {
      activeChatsStore.updateChat(SESSION, { usageLimitStopped: undefined });
    });
    expect(screen.queryByTestId('usage-limit-banner')).toBeNull();
  });

  test('a chat opened fresh is limited by the server summary alone, with no hold flag set on it', async () => {
    summary = realSummary(USAGE_LIMIT_EVENTS);
    // The activation reads exactly what the producer writes.
    expect(summary).toMatchObject({
      lastEventMethod: 'runtime.error',
      lastRuntimeErrorUsageLimit: true,
    });
    mountDock();
    const banner = await screen.findByTestId('usage-limit-banner');
    expect(banner.textContent).toContain('Usage limit reached');
    expect(activeChatsStore.getSnapshot()[SESSION]?.usageLimitStopped).toBe(
      undefined,
    );
  });

  test('an ordinary provider error shows no banner and asks the server nothing', async () => {
    summary = realSummary([
      USAGE_LIMIT_EVENTS[0] as CanonicalRuntimeEvent,
      {
        eventId: 'e-error',
        provider: 'claude',
        threadId: SESSION,
        turnId: 't1',
        createdAt: '2026-09-24T21:00:00.000Z',
        method: 'runtime.error',
        severity: 'error',
        code: 'rate_limit',
        retriable: false,
        message: '429 too many requests',
        details: { scope: 'provider', retryAfterMs: 60_000 },
      },
    ]);
    expect(summary).toMatchObject({ lastEventMethod: 'runtime.error' });
    expect(summary).not.toHaveProperty('lastRuntimeErrorUsageLimit');
    mountDock();
    // real-time: negative assertion; the banner must stay absent
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(screen.queryByTestId('usage-limit-banner')).toBeNull();
    expect(requested).toEqual([]);
  });

  test('a summary whose latest event is not a usage-limit error shows nothing and asks nothing', async () => {
    summary = {
      threadId: SESSION,
      lastEventMethod: 'turn.started',
      lastRuntimeErrorUsageLimit: true,
    };
    mountDock();
    // real-time: negative assertion; the banner must stay absent once the read settles
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(screen.queryByTestId('usage-limit-banner')).toBeNull();
    expect(requested).toEqual([]);
  });
});
