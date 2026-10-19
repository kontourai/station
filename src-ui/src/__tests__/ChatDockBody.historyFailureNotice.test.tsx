/**
 * @vitest-environment jsdom
 *
 * archive#3427 2. Nothing exercised `ChatDockBody`'s history
 * failure notice before this file — an independent review deleted the
 * notice's whole CSS block and 13 files / 172 tests stayed green. This pins
 * the behavior and markup a class-name assertion can reach (see
 * `session-history-error-css.test.ts` for the CSS-shaped half): the notice
 * renders exactly when the bounded history read failed, names the recorded
 * cause verbatim (or the upgrade copy), carries the shared secondary-button
 * treatment, and Retry re-issues the read.
 */

import { agentId } from '@kontourai/station-contracts/agent-identity';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { ToolCallBatchBoundary } from '../components/chat/ToolCallBatchBoundary';

const batchImport = vi.hoisted(() => ({ loaded: false }));
vi.mock('../components/chat/ToolCallBatch', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../components/chat/ToolCallBatch')>();
  batchImport.loaded = true;
  return actual;
});

const agentsMock = vi.hoisted(() => ({ current: [] as any[] }));
const resyncStream = vi.hoisted(() => vi.fn());

vi.mock(
  '../hooks/orchestration/ensureOrchestrationEventStream',
  async (importOriginal) => ({
    ...(await importOriginal<object>()),
    resyncOrchestrationEventStream: resyncStream,
  }),
);
const transcriptStateMock = vi.hoisted(() => ({
  current: {
    enabled: false,
    messages: [] as any[],
    events: [] as any[],
    hasMore: false,
    loading: false,
    upgradeRequired: false,
    error: null as Error | null,
    loadOlder: vi.fn(async () => {}),
    reload: vi.fn(async () => {}),
  },
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

vi.mock('../contexts/ActiveChatsContext', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../contexts/ActiveChatsContext')>()),
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
  useActiveChatTranscript: vi.fn(),
}));

vi.mock('../components/chat/FileAttachmentInput', () => ({
  FileAttachmentInput: () => null,
}));

vi.mock('../components/chat/QueuedMessages', () => ({
  QueuedMessages: () => null,
}));

import {
  PUBLIC_HANDSHAKE_SCHEMA_VERSION,
  REMOTE_AUTH_PROTOCOL_VERSION,
  STATION_COMPAT_MIN_CLIENT_PROTOCOL,
  STATION_COMPAT_PROTOCOL_VERSION,
} from '@kontourai/station-contracts/environment-security';
import {
  resetSessionEventWindowCapabilityCache,
  setClientCredentialResolver,
} from '@kontourai/station-sdk';
import { ChatDockBody } from '../components/chat-dock/ChatDockBody';
import { setStreamConnectionState } from '../hooks/orchestration/streamConnectionState';
import { useActiveChatTranscript } from '../hooks/orchestration/useActiveChatTranscript';
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
    id: 'thread-alpha',
    agentSlug: agentId('codex'),
    agentName: 'Codex',
    title: 'A session whose history failed to load',
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
    status: 'idle',
    lifecycleState: 'idle',
    ...overrides,
  } as any;
}

function renderDock(session: ChatSession = buildSession()) {
  agentsMock.current = [{ slug: agentId('codex'), name: 'Codex' }];
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const ui = (activeSession: ChatSession) => (
    <QueryClientProvider client={queryClient}>
      <ChatDockBody
        activeSession={activeSession}
        activeOrchestrationSession={buildOrchestrationSession()}
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
    </QueryClientProvider>
  );
  const view = render(ui(session));
  return {
    ...view,
    rerenderSession: (next: ChatSession) => view.rerender(ui(next)),
  };
}

describe('ChatDockBody history-failure notice (station#3427)', () => {
  beforeEach(() => {
    agentsMock.current = [];
    vi.mocked(useActiveChatTranscript).mockImplementation(() => ({
      ...transcriptStateMock.current,
      error: transcriptStateMock.current.error ?? undefined,
      watermark: 0,
      handoffs: [],
      contextBoundaries: [],
      settled: true,
      catchingUp: false,
      openTurnProjected: false,
    }));
    setStreamConnectionState('http://localhost:3242', 'caught-up');
    transcriptStateMock.current = {
      enabled: false,
      messages: [],
      events: [],
      hasMore: false,
      loading: false,
      upgradeRequired: false,
      error: null,
      loadOlder: vi.fn(async () => {}),
      reload: vi.fn(async () => {}),
    };
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    setClientCredentialResolver(undefined);
    resetSessionEventWindowCapabilityCache();
    setStreamConnectionState('http://localhost:3242', 'caught-up');
  });

  test('warms the collapsed tool renderer for a known conversation before any tool row mounts', async () => {
    renderDock(buildSession({ conversationId: 'conversation-alpha' }));
    // Wait on the dock's import, never by rendering a lazy boundary: a
    // render of the cold boundary would itself warm the chunk under test.
    await waitFor(() => expect(batchImport.loaded).toBe(true));
    const markup = renderToStaticMarkup(
      <ToolCallBatchBoundary
        run={{
          type: 'tool-call-run',
          key: 'cold-run',
          calls: ['a', 'b'].map((toolCallId, index) => ({
            index,
            part: {
              type: 'tool-invocation',
              toolCallId,
              toolName: 'Read',
              args: { file_path: `${toolCallId}.ts` },
              state: 'completed',
            },
          })),
        }}
        renderCall={(part) => <div>{part.toolCallId}</div>}
        pending={<p>Pending standalone calls</p>}
      />,
    );
    expect(markup).toContain('tool-call-batch__summary');
    expect(markup).not.toContain('Pending standalone calls');
  });

  test('a stalled real SDK history reload aborts, releases Resync and permits a slow successful retry', async () => {
    const realTranscript = await vi.importActual<
      typeof import('../hooks/orchestration/useActiveChatTranscript')
    >('../hooks/orchestration/useActiveChatTranscript');
    vi.mocked(useActiveChatTranscript).mockImplementation(
      realTranscript.useActiveChatTranscript,
    );
    setClientCredentialResolver(() => ({
      origin: 'http://localhost:3242',
      credential: 'fixture',
    }));
    let reads = 0;
    let stalledSignal: AbortSignal | null | undefined;
    let release!: () => void;
    const fetchMock = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const path = new URL(
          input instanceof Request ? input.url : String(input),
        ).pathname;
        if (path === '/.well-known/station/v1')
          return Response.json({
            schemaVersion: PUBLIC_HANDSHAKE_SCHEMA_VERSION,
            environmentId: 'recovery-test',
            authentication: {
              scheme: 'bearer',
              protocolVersion: REMOTE_AUTH_PROTOCOL_VERSION,
            },
            transports: {
              http: REMOTE_AUTH_PROTOCOL_VERSION,
              sse: REMOTE_AUTH_PROTOCOL_VERSION,
              websocket: REMOTE_AUTH_PROTOCOL_VERSION,
            },
            compatibility: {
              serverVersion: '0.4.1',
              protocolVersion: STATION_COMPAT_PROTOCOL_VERSION,
              minClientProtocol: STATION_COMPAT_MIN_CLIENT_PROTOCOL,
            },
            capabilities: { sessionEventWindow: true },
          });
        if (
          path === '/api/orchestration/conversations/thread-alpha/event-window'
        ) {
          reads++;
          if (reads === 1)
            return Response.json(
              { success: false, error: 'Initial history unavailable' },
              { status: 401 },
            );
          if (reads === 2) {
            stalledSignal = init?.signal;
            // Even a transport that ignores cancellation must not hold the UI guard.
            return new Promise<Response>(() => {});
          }
          await new Promise<void>((resolve) => {
            release = resolve;
          });
          return Response.json({
            success: true,
            data: {
              protocolVersion: 1,
              conversationId: 'thread-alpha',
              events: [],
              watermark: 0,
              hasMore: false,
            },
          });
        }
        throw new Error(`Unexpected recovery request: ${path}`);
      },
    );
    vi.stubGlobal('fetch', fetchMock);
    renderDock(
      buildSession({
        conversationId: 'thread-alpha',
        orchestrationSessionStarted: true,
      }),
    );
    await screen.findByRole('textbox');
    const resync = await screen.findByRole('button', {
      name: 'Status unavailable — resync this conversation',
    });
    expect(reads).toBe(1);
    vi.useFakeTimers();
    await act(async () => {
      fireEvent.click(resync);
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(reads).toBe(2);
    expect(
      screen.getByRole('button', { name: /Resyncing conversation/ }),
    ).toHaveProperty('disabled', true);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(120_000);
    });
    expect(stalledSignal?.aborted).toBe(true);
    expect(
      screen.getByText(/Session history read timed out after 120 seconds/),
    ).toBeTruthy();
    const retry = screen.getByRole('button', {
      name: 'Status unavailable — resync this conversation',
    });
    expect(retry).toHaveProperty('disabled', false);
    await act(async () => {
      fireEvent.click(retry);
      await vi.advanceTimersByTimeAsync(40_000);
    });
    expect(reads).toBe(3);
    expect(
      screen.getByRole('button', { name: /Resyncing conversation/ }),
    ).toHaveProperty('disabled', true);
    await act(async () => {
      release();
      await vi.advanceTimersByTimeAsync(200);
    });
    expect(
      screen.queryByRole('button', { name: /resync this conversation/ }),
    ).toBeNull();
    expect(screen.queryByText(/Session history read timed out/)).toBeNull();
  });

  test.each(['caught-up', 'closed'] as const)(
    'a retained approval cannot hide recovery while the stream is %s',
    async (stream) => {
      transcriptStateMock.current.enabled = true;
      transcriptStateMock.current.error = new Error('History unavailable');
      setStreamConnectionState('http://localhost:3242', stream);
      renderDock(
        buildSession({
          pendingApprovals: ['stale-approval'],
          orchestrationStatus: 'awaiting-approval',
        }),
      );
      expect(
        await screen.findByRole('button', {
          name:
            stream === 'closed'
              ? 'Check connection — repair the connection'
              : 'Status unavailable — resync this conversation',
        }),
      ).toBeTruthy();
      expect(
        screen.queryByRole('button', { name: /Needs approval/ }),
      ).toBeNull();
    },
  );

  test('says nothing when history is enabled and healthy', () => {
    transcriptStateMock.current.enabled = true;
    renderDock();

    expect(screen.queryByRole('alert')).toBeNull();
  });

  test('says nothing when history is simply disabled for this session', () => {
    transcriptStateMock.current.enabled = false;
    transcriptStateMock.current.error = new Error('would be moot');
    renderDock();

    expect(screen.queryByRole('alert')).toBeNull();
  });

  test('renders the recorded cause verbatim, with the shared secondary-button Retry affordance', () => {
    transcriptStateMock.current.enabled = true;
    transcriptStateMock.current.error = new Error('ECONNREFUSED host:8443');
    // The banner (as opposed to the empty-state variant handed to the
    // lazy-loaded message list) renders only once the pane already has
    // history to sit above — a subsequent page failing, not a cold arrival.
    transcriptStateMock.current.messages = [
      { role: 'user', content: 'hi', timestamp: 1 },
    ] as any;
    renderDock();

    const notice = screen.getByRole('alert');
    expect(notice.className).toBe('session-history-error');
    expect(notice.textContent).toBe(
      'Session history is unavailable. ECONNREFUSED host:8443Retry',
    );

    const retry = screen.getByRole('button', { name: 'Retry' });
    // The shared class the rest of this surface's affordances use
    // (`.session-history-controls__more` two rules above in index.css) —
    // not a bespoke, unhovered button.
    expect(retry.className).toContain('button--secondary');

    fireEvent.click(retry);
    expect(transcriptStateMock.current.reload).toHaveBeenCalledOnce();
  });

  test('renders the upgrade copy, not the raw error, when an upgrade is required', () => {
    transcriptStateMock.current.enabled = true;
    transcriptStateMock.current.upgradeRequired = true;
    transcriptStateMock.current.error = new Error('should not print');
    transcriptStateMock.current.messages = [
      { role: 'user', content: 'hi', timestamp: 1 },
    ] as any;
    renderDock();

    const notice = screen.getByRole('alert');
    expect(notice.textContent).toContain(
      'Update Station to use bounded managed-session history.',
    );
    expect(notice.textContent).not.toContain('should not print');
  });

  test.each([
    'orphaned',
    'elsewhere',
    'reconnecting',
    'later-status',
    'dialog',
    'approval-focus',
  ])(
    'Resync coalesces retries and completes recovery with %s focus/status',
    async (scenario) => {
      resyncStream.mockClear();
      let release!: () => void;
      transcriptStateMock.current.enabled = true;
      transcriptStateMock.current.error = new Error(
        'Native request queue is full',
      );
      transcriptStateMock.current.messages = [
        { role: 'user', content: 'hi', timestamp: 1 },
      ];
      transcriptStateMock.current.reload.mockImplementation(
        () =>
          new Promise<void>((resolve) => {
            release = resolve;
          }),
      );
      const view = renderDock();
      const composer = await screen.findByRole('textbox');
      const pill = await screen.findByRole('button', {
        name: 'Status unavailable — resync this conversation',
      });
      try {
        act(() => pill.focus());
        expect(document.activeElement).toBe(pill);
        // Same-tick activations exercise the owner guard before disabled paints.
        act(() => {
          for (let i = 0; i < 5; i++) fireEvent.click(pill);
        });
        const pending = await screen.findByRole('button', {
          name: 'Resyncing conversation — resync this conversation',
        });
        expect(pending).toHaveProperty('disabled', true);
        expect(pending.getAttribute('aria-busy')).toBe('true');
        expect(
          screen
            .getAllByRole('status')
            .some((status) => status.textContent === 'Resyncing conversation'),
        ).toBe(true);
        expect(transcriptStateMock.current.reload).toHaveBeenCalledTimes(1);
        expect(resyncStream).toHaveBeenCalledTimes(1);
        // Model the browser's blur-to-body when a focused control is disabled;
        // jsdom keeps disabled buttons focused and their blur() is a no-op.
        document.body.tabIndex = -1;
        act(() => document.body.focus());
        document.body.removeAttribute('tabindex');
        expect(document.activeElement).toBe(document.body);
        let elsewhere: HTMLElement | undefined;
        if (scenario === 'elsewhere') {
          render(<input aria-label="Another input" />);
          elsewhere = screen.getByRole('textbox', { name: 'Another input' });
          act(() => elsewhere?.focus());
        }
        if (scenario === 'dialog')
          render(<div role="dialog" aria-label="Open dialog" />);
        if (scenario === 'reconnecting' || scenario === 'approval-focus') {
          act(() =>
            setStreamConnectionState(
              'http://localhost:3242',
              'interrupted',
              Date.now() - 3_000,
            ),
          );
          const reconnecting = await screen.findByRole('button', {
            name: 'Reconnecting',
          });
          if (scenario === 'approval-focus') {
            act(() => reconnecting.focus());
            elsewhere = reconnecting;
            view.rerenderSession(
              buildSession({
                pendingApprovals: ['retained-approval'],
                orchestrationStatus: 'awaiting-approval',
              }),
            );
          }
        }
        await act(async () => {
          transcriptStateMock.current.error = null;
          release();
        });
        if (scenario === 'reconnecting' || scenario === 'approval-focus') {
          act(() =>
            setStreamConnectionState('http://localhost:3242', 'receiving'),
          );
          await screen.findByRole('button', {
            name: 'Catching up',
          });
          act(() =>
            setStreamConnectionState('http://localhost:3242', 'caught-up'),
          );
          if (scenario === 'approval-focus')
            await screen.findByRole('button', { name: /Needs approval/ });
          else await screen.findByText('Connected');
        }
        await waitFor(() => expect(screen.queryByRole('alert')).toBeNull());
        expect(document.activeElement).toBe(
          scenario === 'elsewhere' || scenario === 'approval-focus'
            ? elsewhere
            : scenario === 'dialog'
              ? document.body
              : composer,
        );
        expect(
          screen
            .getAllByRole('status')
            .some((status) =>
              status.textContent?.startsWith('Conversation resynced.'),
            ),
        ).toBe(true);
        expect(
          screen.queryByRole('button', { name: /resync this conversation/ }),
        ).toBeNull();
        if (scenario === 'later-status') {
          view.rerenderSession(
            buildSession({
              orchestrationSessionStarted: true,
              orchestrationTurnOpen: true,
              status: 'sending',
            }),
          );
          await screen.findAllByText('Working', { exact: true });
          expect(
            screen
              .getAllByRole('status')
              .some((status) => status.textContent?.includes('resynced')),
          ).toBe(false);
        }
      } finally {
        release?.();
      }
    },
  );

  test('background work the record last reported is shown as last known, not as current, while history is unavailable', async () => {
    transcriptStateMock.current.enabled = true;
    transcriptStateMock.current.error = new Error(
      'Native request queue is full',
    );
    transcriptStateMock.current.messages = [
      { role: 'user', content: 'hi', timestamp: 1 },
    ] as any;
    renderDock(
      buildSession({
        conversationActivity: {
          conversationId: 'thread-alpha',
          asOfSequence: 3,
          runningChildWork: { count: 1, producers: ['engine-subagent'] },
        },
      } as Partial<ChatSession>),
    );

    expect(
      await screen.findByText(
        'Last known: background agent working (status unavailable)',
      ),
    ).toBeTruthy();
    expect(screen.queryByText('Background agent working')).toBeNull();
  });

  test('a resync that ends in blocked repair does not complete on a later reconnect', async () => {
    transcriptStateMock.current.enabled = true;
    transcriptStateMock.current.error = new Error('History unavailable');
    transcriptStateMock.current.messages = [
      { role: 'user', content: 'hi', timestamp: 1 },
    ] as any;
    let release!: () => void;
    transcriptStateMock.current.reload.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    renderDock(buildSession());
    await screen.findByRole('textbox');
    fireEvent.click(
      await screen.findByRole('button', {
        name: /Status unavailable — resync/,
      }),
    );
    await screen.findByRole('button', { name: /Resyncing conversation/ });
    document.body.tabIndex = -1;
    act(() => document.body.focus());
    document.body.removeAttribute('tabindex');

    act(() =>
      setStreamConnectionState(
        'http://localhost:3242',
        'interrupted',
        Date.now() - 3000,
      ),
    );
    await screen.findByRole('button', { name: 'Reconnecting' });
    act(() => setStreamConnectionState('http://localhost:3242', 'closed'));
    await screen.findByRole('button', { name: /Check connection/ });
    await act(async () => {
      transcriptStateMock.current.error = null;
      release();
    });
    // A later, unrelated reconnect is not completion of the failed recovery.
    act(() => setStreamConnectionState('http://localhost:3242', 'caught-up'));
    await waitFor(() =>
      expect(
        screen.queryByRole('button', { name: /Check connection/ }),
      ).toBeNull(),
    );
    expect(screen.queryByText(/Conversation resynced/)).toBeNull();
    expect(document.activeElement).toBe(document.body);
  });
});
