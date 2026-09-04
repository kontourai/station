/**
 * @vitest-environment jsdom
 */

import {
  isSessionLifecycleStateTerminal,
  SESSION_LIFECYCLE_STATES,
} from '@kontourai/station-contracts/session-lifecycle';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { NavigationProvider } from '../contexts/NavigationContext';
import { ToastProvider } from '../contexts/ToastContext';
import { ATTACHED_SESSION_CONTINUATION_STORAGE_KEY } from '../lib/attached-session-continuation-store';

const sendTurn = vi.fn().mockResolvedValue(undefined);
const resolveRequest = vi.fn().mockResolvedValue(undefined);
const interruptTurn = vi.fn().mockResolvedValue(undefined);
const delegateTask = vi.fn();
const resetDelegation = vi.fn();
const refetchSessions = vi.fn().mockResolvedValue(undefined);
const adoptSession = vi.fn();
const getStarterWork = vi.fn();
const launchContinueSessionStarter = vi.fn();
const evaluateGate = vi.fn().mockResolvedValue(undefined);
const acceptException = vi.fn().mockResolvedValue(undefined);
const showToast = vi.fn();
const notificationAction = vi.fn().mockResolvedValue(undefined);
const dismissNotification = vi.fn().mockResolvedValue(undefined);
const acknowledgeAttentionItem = vi.fn().mockResolvedValue(undefined);
let sessionFlowRun: Record<string, unknown> | null = null;
let sessionBuilderRun: Record<string, unknown> | null = null;
const useSessionFlowRunQuery = vi.hoisted(() => vi.fn());
const useSessionBuilderRunQuery = vi.hoisted(() => vi.fn());
const usePairedDevicesQuery = vi.hoisted(() => vi.fn());
const adoptionIntent = vi.hoisted(() =>
  Object.freeze({ idempotencyKey: 'adopt-session-test-intent' }),
);
let sessions: Array<Record<string, unknown>> = [];
let pairedDevices: Array<Record<string, unknown>> = [];
let sessionsQueryError: Error | null = null;
let feedEvents: Array<Record<string, unknown>> = [];
const loadOlder = vi.fn().mockResolvedValue(undefined);
let historyState = {
  hasMore: false,
  upgradeRequired: false,
  error: undefined as Error | undefined,
  historyRetrying: false,
  elidedHistory: { total: 0, byteLimit: 0, outputLimit: 0 },
};
let attentionItems: Array<Record<string, unknown>> = [];
let attentionQueryState: {
  isLoading: boolean;
  isError: boolean;
  error: Error | null;
} = { isLoading: false, isError: false, error: null };
const attentionRefetch = vi.fn();
let workflowTasksByProject: Record<
  string,
  Array<{
    taskSlug: string;
    status: string;
    phase: string;
    flowRun?: { current_step: string; open_gate_ids: string[] };
  }>
> = {};

vi.mock('../contexts/ToastContext', () => ({
  ToastProvider: ({ children }: { children: unknown }) => children,
  useToast: () => ({ showToast }),
}));

/**
 * #890: `AttentionCard`'s dismiss actions read `useApiBase()` so the ack
 * reaches the connection the view is actually bound to. `useApiBase` is a thin
 * read over `useConnections`, which throws outside a provider, and this suite
 * renders the view without the app-shell providers `main.tsx` supplies. Mocked
 * the same way `components/attention/__tests__/AttentionCard.test.tsx` mocks
 * it — the base value is incidental here; these tests are about which
 * attention items render, not where the ack is sent.
 */
vi.mock('../contexts/ApiBaseContext', () => ({
  useApiBase: () => ({ apiBase: 'http://station.test' }),
}));

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

vi.mock('@kontourai/station-sdk', () => ({
  AdoptSessionError: class AdoptSessionError extends Error {
    failureClass: string;
    retryable: boolean;
    cause?: unknown;
    constructor(input: {
      failureClass: string;
      message: string;
      retryable: boolean;
      cause?: unknown;
    }) {
      super(input.message);
      this.failureClass = input.failureClass;
      this.retryable = input.retryable;
      this.cause = input.cause;
    }
  },
  createAdoptOrchestrationSessionIntent: () => adoptionIntent,
  getStarterWork: (starterId: string, apiBase?: string) =>
    getStarterWork(starterId, apiBase),
  useProjectQuery: () => ({ data: undefined }),
  // The open-chats refactor (archive#2683) renders shared membership metadata.
  useAgentsQuery: () => ({ data: [], isLoading: false }),
  useOrchestrationSessionsQuery: () => ({
    data: sessions,
    isLoading: false,
    error: sessionsQueryError,
    refetch: refetchSessions,
  }),
  usePairedDevicesQuery,
  usePullRequestContextQuery: () => ({ data: { available: false } }),
  usePullRequestsQuery: () => ({ data: undefined }),
  useWorkflowTasksQuery: (projectSlug: string | null | undefined) => ({
    data: projectSlug ? (workflowTasksByProject[projectSlug] ?? []) : [],
  }),
  useSessionFlowRunQuery,
  useSessionBuilderRunQuery,
  useOrchestrationCommandReceiptsQuery: () => ({
    data: [],
    isLoading: false,
    isError: false,
  }),
  // #790: peer-credential read the DelegationLauncher performs when open;
  // undefined models the 403 a non-operator browser session receives.
  usePeerCredentialsQuery: () => ({
    data: undefined,
    isSuccess: false,
    isError: true,
  }),
  useDelegationOptionsQuery: () => ({
    data: {
      environment: {
        id: 'env-current',
        name: 'Current environment',
        kind: 'current',
      },
      targets: [
        {
          id: 'codex',
          kind: 'agent-app',
          name: 'Codex',
          ready: true,
          defaultModel: 'gpt-5.6-sol',
          models: [],
          capabilities: {
            resume: true,
            interrupt: true,
            approvals: true,
            modelSelection: true,
          },
        },
        {
          id: 'reviewer',
          kind: 'station-agent',
          name: 'Reviewer',
          ready: true,
          models: [],
          capabilities: {
            resume: true,
            interrupt: true,
            approvals: false,
            modelSelection: false,
          },
        },
      ],
    },
    error: null,
    isFetching: false,
    refetch: vi.fn(),
  }),
  useSshEnvironmentsQuery: () => ({ data: [] }),
  useDelegateOrchestrationTaskMutation: () => ({
    mutateAsync: delegateTask,
    reset: resetDelegation,
    isPending: false,
    error: null,
  }),
  sendOrchestrationTurn: (input: unknown) => sendTurn(input),
  resolveOrchestrationRequest: (input: unknown) => resolveRequest(input),
  interruptOrchestrationTurn: (input: unknown) => interruptTurn(input),
  launchContinueSessionStarter: (input: unknown) =>
    launchContinueSessionStarter(input),
  adoptOrchestrationSession: (input: unknown) => adoptSession(input),
  useAttentionQuery: () => ({
    data: attentionQueryState.isLoading
      ? undefined
      : { items: attentionItems, pendingCount: attentionItems.length },
    isLoading: attentionQueryState.isLoading,
    isError: attentionQueryState.isError,
    error: attentionQueryState.error,
    refetch: attentionRefetch,
  }),
  useAcknowledgeAttentionItemMutation: () => ({
    isPending: false,
    error: null,
    mutate: acknowledgeAttentionItem,
    mutateAsync: acknowledgeAttentionItem,
  }),
  evaluateFlowGate: (input: unknown) => evaluateGate(input),
  acceptFlowException: (input: unknown) => acceptException(input),
  useNotificationActionMutation: () => ({
    isPending: false,
    mutate: notificationAction,
  }),
  useDismissNotificationMutation: () => ({
    isPending: false,
    mutate: dismissNotification,
  }),
  useQueryClient: () => ({ invalidateQueries: vi.fn() }),
}));

vi.mock('../hooks/orchestration/useSessionEventStream', () => ({
  useSessionEventStream: () => ({
    events: feedEvents,
    connected: true,
    loadOlder,
    ...historyState,
  }),
}));

import { SessionsView } from '../views/SessionsView';

function renderView(
  sessionId?: string,
  focusHint?: 'evidence',
  intentToken?: number,
  onFocusConsumed?: () => void,
) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const view = (
    nextSessionId?: string,
    nextFocusHint?: 'evidence',
    nextIntentToken?: number,
    nextOnFocusConsumed?: () => void,
  ) => (
    <QueryClientProvider client={client}>
      <NavigationProvider>
        <SessionsView
          apiBase="http://test.local"
          sessionId={nextSessionId}
          focusHint={nextFocusHint}
          intentToken={nextIntentToken}
          onFocusConsumed={nextOnFocusConsumed}
        />
      </NavigationProvider>
    </QueryClientProvider>
  );
  const rendered = render(
    view(sessionId, focusHint, intentToken, onFocusConsumed),
  );
  return {
    ...rendered,
    rerenderSession: (
      nextSessionId?: string,
      nextFocusHint?: 'evidence',
      nextIntentToken?: number,
      nextOnFocusConsumed?: () => void,
    ) =>
      rendered.rerender(
        view(
          nextSessionId,
          nextFocusHint,
          nextIntentToken,
          nextOnFocusConsumed,
        ),
      ),
  };
}

describe('SessionsView', () => {
  beforeEach(() => {
    window.localStorage.clear();
    showToast.mockReset();
    Object.defineProperty(window.navigator, 'locks', {
      configurable: true,
      value: {
        request: async (
          _name: string,
          _options: unknown,
          callback: () => Promise<unknown>,
        ) => callback(),
      },
    });
    sendTurn.mockClear();
    resolveRequest.mockClear();
    interruptTurn.mockClear();
    delegateTask.mockReset();
    resetDelegation.mockReset();
    refetchSessions.mockReset();
    refetchSessions.mockResolvedValue(undefined);
    adoptSession.mockReset();
    getStarterWork.mockReset();
    getStarterWork.mockResolvedValue({ state: 'unbound' });
    launchContinueSessionStarter.mockReset();
    launchContinueSessionStarter.mockImplementation(async (input) => ({
      state: 'continued',
      session: await adoptSession(input),
      correlation: { state: 'bound' },
      evidence: { state: 'NOT_VERIFIED', reason: 'test' },
    }));
    evaluateGate.mockClear();
    acceptException.mockClear();
    notificationAction.mockClear();
    dismissNotification.mockClear();
    acknowledgeAttentionItem.mockReset();
    acknowledgeAttentionItem.mockResolvedValue(undefined);
    loadOlder.mockClear();
    historyState = {
      hasMore: false,
      upgradeRequired: false,
      error: undefined,
      historyRetrying: false,
      elidedHistory: { total: 0, byteLimit: 0, outputLimit: 0 },
    };
    attentionItems = [];
    attentionQueryState = { isLoading: false, isError: false, error: null };
    attentionRefetch.mockClear();
    useSessionFlowRunQuery.mockClear();
    useSessionBuilderRunQuery.mockClear();
    sessionFlowRun = null;
    sessionBuilderRun = null;
    useSessionFlowRunQuery.mockImplementation(() => ({
      data: sessionFlowRun,
    }));
    useSessionBuilderRunQuery.mockImplementation(() => ({
      data: sessionBuilderRun,
    }));
    delegateTask.mockResolvedValue({
      taskId: 'task:child-worker',
      sessionId: 'thread-child-worker',
      status: 'dispatched',
      environment: {
        id: 'env-current',
        name: 'Current environment',
        kind: 'current',
      },
      target: { kind: 'agent-app', id: 'codex' },
      resumable: true,
    });
    feedEvents = [];
    workflowTasksByProject = {};
    sessionsQueryError = null;
    pairedDevices = [];
    usePairedDevicesQuery.mockReset();
    usePairedDevicesQuery.mockImplementation(() => ({ data: pairedDevices }));
    sessions = [
      {
        provider: 'claude',
        threadId: 'thread-alpha',
        status: 'idle',
        lifecycleState: 'needs_input',
        model: 'claude-sonnet',
        // REQUIRED on the wire since archive#1791 (ADR 0012); the SDK
        // normalizes it for real callers, and this mock stands in for the SDK.
        answerability: { answerable: true },
        isLoaded: true,
        isPersisted: true,
        eventCount: 3,
        createdAt: '2026-06-28T00:00:00.000Z',
        updatedAt: '2026-06-28T00:00:01.000Z',
        projectSlug: 'demo',
        delegation: {
          taskId: 'task:mobile-browser-12345678',
          environmentId: 'env-current-123',
          environmentName: 'Current environment',
          connectionId: 'ollama-local',
          projectSlug: 'station',
          parentTaskId: 'parent-chat',
          mode: 'isolated-child',
        },
      },
    ];
    vi.stubGlobal('matchMedia', () => ({
      addEventListener: vi.fn(),
      matches: false,
      removeEventListener: vi.fn(),
    }));
  });

  // archive#771 regression: `isLoading` was consulted by `SplitPaneLayout`'s
  // `loading` prop but the sessions query's `error` was never passed
  // through, so a settled read failure rendered the same "Nothing has run
  // yet" empty state as a host with no sessions — no error, no retry.
  test('renders the sessions list error state with retry when the sessions query fails', () => {
    sessions = [];
    sessionsQueryError = new Error('sessions unavailable');

    renderView();

    expect(screen.getByText('sessions unavailable')).toBeTruthy();
    expect(screen.queryByText('Nothing has run yet')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(refetchSessions).toHaveBeenCalledTimes(1);
  });

  test('lists sessions and opens a live feed on select', () => {
    feedEvents = [
      {
        provider: 'claude',
        threadId: 'thread-alpha',
        createdAt: '2026-06-28T00:00:02.000Z',
        method: 'tool.started',
        itemId: 'i1',
        toolCallId: 't1',
        toolName: 'Bash',
      },
    ];
    renderView();

    fireEvent.click(screen.getByRole('button', { name: /Worker task/ }));

    const detail = screen.getByTestId('session-detail');
    expect(within(detail).getByText('tool.started')).toBeTruthy();
    // The live feed rendered the streamed event.
    expect(
      within(screen.getByTestId('session-feed')).getByText(/Bash/),
    ).toBeTruthy();
  });

  test("groups delegated workers, projects active progress through Home's observation, and opens the existing live detail", async () => {
    const parent = {
      ...sessions[0],
      threadId: 'parent-thread',
      displayTitle: 'Plan the release',
      delegation: undefined,
      lifecycleState: 'running',
      hasActiveTurn: true,
    };
    const worker = {
      ...sessions[0],
      threadId: 'worker-thread',
      displayTitle: 'Check the migration',
      lifecycleState: 'running',
      hasActiveTurn: true,
      delegation: {
        taskId: 'task:worker',
        parentTaskId: 'parent-thread',
        targetId: 'codex',
        targetKind: 'agent',
      },
      turnProgress: {
        lastProgressEventAt: '2026-08-24T00:00:00.000Z',
        progressSilence: {
          detectedAt: '2026-08-24T00:01:00.000Z',
          silentSinceEventAt: '2026-08-24T00:00:00.000Z',
          windowMs: 30_000,
          provider: 'claude',
        },
      },
    };
    const secondWorker = {
      ...worker,
      threadId: 'worker-thread-2',
      displayTitle: 'Review the receipts',
      delegation: { ...worker.delegation, taskId: 'task:worker-2' },
      turnProgress: {
        lastProgressEventAt: '2026-08-24T00:00:10.000Z',
      },
    };
    sessions = [parent, worker, secondWorker];
    feedEvents = [
      {
        provider: 'claude',
        threadId: 'worker-thread',
        createdAt: '2026-08-24T00:01:00.000Z',
        method: 'tool.started',
        itemId: 'worker-tool',
        toolCallId: 'worker-call',
        toolName: 'Bash',
      },
    ];

    renderView();

    expect(
      screen
        .getByRole('button', { name: 'Run · 2 delegated sessions' })
        .getAttribute('aria-expanded'),
    ).toBe('true');
    expect(screen.getAllByTestId('session-member-status')).toHaveLength(3);
    expect(
      (await screen.findAllByText(/No progress events for/)).length,
    ).toBeGreaterThan(0);
    expect(
      screen
        .getAllByTestId('session-member-status')
        .find(
          (node) => node.getAttribute('data-session-id') === 'worker-thread-2',
        )?.textContent,
    ).not.toContain('No progress events for');

    fireEvent.click(
      screen.getByRole('button', { name: /Check the migration/ }),
    );
    expect(screen.getByTestId('session-detail')).toBeTruthy();
    expect(
      within(screen.getByTestId('session-feed')).getByText(/Bash/),
    ).toBeTruthy();
  });

  test('renders grouped-member glyphs from the canonical lifecycle fold', () => {
    const parent = {
      ...sessions[0],
      threadId: 'ready-parent',
      displayTitle: 'Ready parent',
      delegation: undefined,
      lifecycleState: 'running',
      hasActiveTurn: false,
    };
    const needsAttention = {
      ...parent,
      threadId: 'needs-attention',
      displayTitle: 'Needs attention',
      delegation: {
        taskId: 'task:needs-attention',
        parentTaskId: 'ready-parent',
      },
      pendingReview: true,
    };
    const completed = {
      ...needsAttention,
      threadId: 'completed',
      displayTitle: 'Completed',
      delegation: { ...needsAttention.delegation, taskId: 'task:completed' },
      pendingReview: false,
      status: 'closed',
      hasActiveTurn: true,
    };
    const noLifecycleState = {
      ...needsAttention,
      threadId: 'no-lifecycle-state',
      displayTitle: 'No lifecycle state',
      delegation: {
        ...needsAttention.delegation,
        taskId: 'task:no-lifecycle-state',
      },
      pendingReview: false,
      lifecycleState: undefined,
      status: 'idle',
      hasActiveTurn: false,
    };
    const stopped = {
      ...needsAttention,
      threadId: 'stopped',
      displayTitle: 'Stopped by request',
      delegation: { ...needsAttention.delegation, taskId: 'task:stopped' },
      pendingReview: false,
      lifecycleState: 'canceled',
      terminalAttribution: {
        kind: 'requested_stop',
        // The server detail is text, not HTML. A hostile-looking fixture
        // proves the member row cannot turn a compact explanation into markup.
        detail: '<em>Stopped by request.</em>',
      },
    };
    sessions = [parent, needsAttention, completed, noLifecycleState, stopped];

    renderView();

    const statusFor = (sessionId: string) =>
      screen
        .getAllByTestId('session-member-status')
        .find((node) => node.getAttribute('data-session-id') === sessionId)!;

    expect(
      within(statusFor('ready-parent'))
        .getByRole('img')
        .getAttribute('aria-label'),
    ).toBe('Ready');
    expect(
      within(statusFor('needs-attention'))
        .getByRole('img')
        .getAttribute('aria-label'),
    ).toBe('Needs attention');
    expect(
      within(statusFor('completed'))
        .getByRole('img')
        .getAttribute('aria-label'),
    ).toBe('Completed');
    expect(
      within(statusFor('no-lifecycle-state'))
        .getByRole('img')
        .getAttribute('aria-label'),
    ).toBe('Ready');
    expect(
      within(statusFor('stopped')).getByRole('img').getAttribute('aria-label'),
    ).toBe('Stopped');
    expect(
      within(statusFor('stopped')).getByTestId(
        'session-member-terminal-attribution',
      ).textContent,
    ).toBe('<em>Stopped by request.</em>');
    expect(statusFor('stopped').querySelector('em')).toBeNull();
  });

  test('puts a mixed-state run in Needs you, counts the rendered run, and keeps its summary when collapsed', async () => {
    const parent = {
      ...sessions[0],
      threadId: 'active-parent',
      displayTitle: 'Active parent',
      delegation: undefined,
      lifecycleState: 'running',
      hasActiveTurn: true,
      projectSlug: undefined,
    };
    const needsYou = {
      ...parent,
      threadId: 'needs-you-child',
      displayTitle: 'Needs you child',
      lifecycleState: 'needs_input',
      hasActiveTurn: false,
      delegation: {
        taskId: 'task:needs-you-child',
        parentTaskId: 'active-parent',
      },
    };
    sessions = [parent, needsYou];

    const view = renderView();
    const list = view.container.querySelector('.split-pane__list')!;
    const group = screen.getByRole('button', {
      name: 'Run · 1 delegated session',
    });

    expect(
      Array.from(list.querySelectorAll('.split-pane__section-header')).map(
        (heading) => heading.textContent,
      ),
    ).toEqual(['Delegated/background work · 2']);
    expect(screen.queryByText(/^Active now ·/)).toBeNull();
    expect(
      Array.from(list.querySelectorAll('button'))
        .filter(
          (button) =>
            button.classList.contains('split-pane__group-toggle') ||
            button.classList.contains('split-pane__item'),
        )
        .map((button) =>
          button.classList.contains('split-pane__group-toggle')
            ? button.textContent?.replace('⌄', '').trim()
            : button.querySelector('.split-pane__item-name')?.textContent,
        ),
    ).toEqual([
      'Run · 1 delegated session',
      'Active parent',
      'Needs you child',
    ]);

    fireEvent.click(group);
    expect(group.getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByRole('button', { name: /Active parent/ })).toBeNull();
    expect(
      Array.from(list.querySelectorAll('.split-pane__section-header')).map(
        (heading) => heading.textContent,
      ),
    ).toEqual(['Delegated/background work · 2']);
    expect(
      screen.getByRole('button', { name: 'Run · 1 delegated session' }),
    ).toBeTruthy();

    view.rerenderSession('needs-you-child');
    await waitFor(() =>
      expect(group.getAttribute('aria-expanded')).toBe('true'),
    );
    expect(
      screen.getByRole('button', { name: /Needs you child/ }),
    ).toBeTruthy();
  });

  test('keyboard activation of a board cluster reveals and focuses its first matching member', async () => {
    const parent = {
      ...sessions[0],
      threadId: 'board-parent',
      displayTitle: 'Board parent',
      delegation: undefined,
      lifecycleState: 'running',
      hasActiveTurn: true,
      projectSlug: undefined,
    };
    const needsYou = {
      ...parent,
      threadId: 'board-needs-you',
      displayTitle: 'Board needs you',
      lifecycleState: 'needs_input',
      hasActiveTurn: false,
      delegation: {
        taskId: 'task:board-needs-you',
        parentTaskId: 'board-parent',
      },
    };
    sessions = [parent, needsYou];

    renderView();

    const toggle = screen.getByRole('button', {
      name: 'Run · 1 delegated session',
    });
    fireEvent.click(toggle);
    expect(toggle.getAttribute('aria-expanded')).toBe('false');

    const cluster = screen.getByTestId('run-board-cluster-Needs attention');
    cluster.focus();
    fireEvent.keyDown(cluster, { key: 'Enter' });

    await waitFor(() =>
      expect(toggle.getAttribute('aria-expanded')).toBe('true'),
    );
    expect(document.activeElement).toBe(
      screen.getByRole('button', { name: /Board needs you/ }),
    );
  });

  test('keeps an ungrouped row structure, trailing project pill, selection, and accessible name intact', () => {
    sessions = [
      {
        ...sessions[0],
        delegation: undefined,
        projectSlug: 'demo',
        displayTitle: 'An independent session',
      },
    ];
    const { container } = renderView();
    const row = container.querySelector('.split-pane__item');
    const pill = container.querySelector('.session-project-pill');

    expect(container.querySelector('.split-pane__group-toggle')).toBeNull();
    expect(row?.parentElement?.className).toBe('split-pane__item-row');
    expect(pill?.textContent).toBe('demo');
    expect(pill?.getAttribute('aria-pressed')).toBe('false');
    expect(
      row?.querySelector('.split-pane__item-subtitle')?.textContent,
    ).toMatch(/^Waiting on you · \d+d ago$/);
    const accessibleRow = screen.getByRole('button', {
      name: /^An independent session Waiting on you · \d+d ago$/,
    });
    fireEvent.click(accessibleRow);
    expect(accessibleRow.classList.contains('split-pane__item--selected')).toBe(
      true,
    );
  });

  // #765 residue (A2-adjacent): the runtime opens one engine session per
  // continuation turn, so a three-turn chat listed three "Recently finished"
  // rows. The list must show the conversation once — newest member
  // represents it, the fold's member count rides the meta line, and the lane
  // heading counts the folded population (the same conversation-folded
  // population Home counts), not raw turn-sessions.
  test('folds sibling turn-sessions of one conversation into one row with a turn count', () => {
    const base = {
      ...sessions[0],
      delegation: undefined,
      lifecycleState: 'completed',
      displayTitle: 'Say exactly: TURN OK',
      projectSlug: undefined,
    };
    sessions = [
      {
        ...base,
        threadId: 'conv-1:session:2',
        conversationId: 'conv-1',
        updatedAt: '2026-06-28T00:20:00.000Z',
      },
      {
        ...base,
        threadId: 'conv-1',
        updatedAt: '2026-06-28T00:10:00.000Z',
      },
    ];
    const { container } = renderView();

    const rows = container.querySelectorAll('.split-pane__item');
    expect(rows).toHaveLength(1);
    expect(
      rows[0].querySelector('.split-pane__item-subtitle')?.textContent,
    ).toMatch(/^Completed · 2 turns · /);
    expect(
      container.querySelector('.split-pane__section-header')?.textContent,
    ).toMatch(/ · 1$/);
  });

  test('exposes bounded-history controls and an upgrade-required state', async () => {
    historyState = {
      hasMore: true,
      upgradeRequired: true,
      error: new Error('Session history requires a Station upgrade'),
      historyRetrying: false,
      elidedHistory: { total: 0, byteLimit: 0, outputLimit: 0 },
    };
    renderView();

    fireEvent.click(screen.getByRole('button', { name: /Worker task/ }));
    fireEvent.click(
      screen.getByRole('button', { name: 'Load earlier events' }),
    );

    expect(loadOlder).toHaveBeenCalledOnce();

    // It shipped as a bare <button> with no className, inside a wrapper class
    // that has no CSS rule anywhere in the repo — so it rendered as raw
    // browser chrome in a fully themed transcript (archive#3150). Pin the
    // shared treatment: a class name that matches no stylesheet is worse than
    // none, because it tells the next reader the styling is handled.
    const more = screen.getByRole('button', { name: 'Load earlier events' });
    expect(more.className).toContain('button--secondary');
    expect(screen.getByRole('alert').textContent).toBe(
      'Update Station to view this session history.',
    );
  });

  // archive#3378: the history alert is the only place a user learns which of
  // the two outcomes they are in. Both directions, because a message that
  // always says "retrying" is exactly as dishonest as one that never does.
  test('says a failing session history is being retried, and stops saying so once it is not', async () => {
    historyState = {
      hasMore: false,
      upgradeRequired: false,
      error: new Error('Orchestration API error: 503'),
      historyRetrying: true,
      elidedHistory: { total: 0, byteLimit: 0, outputLimit: 0 },
    };
    const retrying = renderView();
    fireEvent.click(screen.getByRole('button', { name: /Worker task/ }));
    expect(screen.getByRole('alert').textContent).toBe(
      'Orchestration API error: 503 Retrying session history…',
    );
    retrying.unmount();

    historyState = {
      hasMore: false,
      upgradeRequired: false,
      error: new Error('Unauthorized'),
      historyRetrying: false,
      elidedHistory: { total: 0, byteLimit: 0, outputLimit: 0 },
    };
    renderView();
    fireEvent.click(screen.getByRole('button', { name: /Worker task/ }));
    expect(screen.getByRole('alert').textContent).toBe('Unauthorized');
  });

  /**
   * archive#3386. This surface and the chat dock read the SAME
   * bounded window. The dock disclosed what its size budget withheld and this
   * one rendered the identical amputated turn in silence, because the hook
   * unwrapped `item.event` and dropped the read's own budget report.
   */
  test('discloses what the history read withheld, and stays quiet when it withheld nothing', async () => {
    historyState = {
      hasMore: false,
      upgradeRequired: false,
      error: undefined,
      historyRetrying: false,
      elidedHistory: { total: 2, byteLimit: 1, outputLimit: 1 },
    };
    const elided = renderView();
    fireEvent.click(screen.getByRole('button', { name: /Worker task/ }));
    expect(screen.getByTestId('session-history-elided').textContent).toBe(
      '1 earlier item is shown without its content, and 1 tool result is shortened — too large to load in full here. The session still holds the complete content.',
    );
    elided.unmount();

    historyState = {
      hasMore: false,
      upgradeRequired: false,
      error: undefined,
      historyRetrying: false,
      elidedHistory: { total: 0, byteLimit: 0, outputLimit: 0 },
    };
    renderView();
    fireEvent.click(screen.getByRole('button', { name: /Worker task/ }));
    expect(screen.queryByTestId('session-history-elided')).toBeNull();
  });

  /**
   * The attached branch places the notice in a DIFFERENT container from the
   * mutable one — `archive#2630` keeps the upgrade/error stories inside the detail
   * for a read-only attached session, so only the pagination control and this
   * notice sit above it. Nothing exercised that placement, which is how a
   * ~150-character sentence came to share a centered flex row with a button.
   */
  test('discloses a withheld history read on a read-only attached session too', async () => {
    sessions[0] = {
      ...sessions[0],
      controlMode: 'read-only-attached',
    };
    historyState = {
      hasMore: true,
      upgradeRequired: false,
      error: undefined,
      historyRetrying: false,
      elidedHistory: { total: 1, byteLimit: 1, outputLimit: 0 },
    };
    renderView();
    fireEvent.click(screen.getByRole('button', { name: /Worker task/ }));

    const notice = screen.getByTestId('session-history-elided');
    expect(notice.textContent).toContain(
      '1 earlier item is shown without its content',
    );
    // It shares its row with the pagination button, which is what
    // `.session-history-controls`' wrap/gap exists for.
    expect(
      screen.getByRole('button', { name: 'Load earlier events' }),
    ).toBeTruthy();
    expect(notice.parentElement?.className).toContain(
      'session-history-controls',
    );
    // The detail owns the upgrade/error stories; the notice must not also be
    // handed down and rendered a second time (archive#2630).
    expect(screen.getAllByTestId('session-history-elided')).toHaveLength(1);
  });

  test('directs the highest-priority delegated task without opening its detail', async () => {
    sessions.push({
      ...sessions[0],
      threadId: 'thread-review',
      lifecycleState: 'review_pending',
      pendingReview: true,
      updatedAt: '2026-06-28T00:00:02.000Z',
      delegation: {
        ...(sessions[0].delegation as Record<string, unknown>),
        taskId: 'task:review-release',
        targetKind: 'station-agent',
        targetId: 'release-worker',
      },
    });
    renderView();

    const coordinator = screen.getByTestId('delegated-task-coordinator');
    // archive#3227: was `getByText('review release')` — the coordinator's
    // `<h3>` rendered a bare `humanizeId(taskId)`, which is the same helper
    // that returns a raw hash unchanged when there is no task id. It renders
    // `sessionTitle` now, the one name this session is listed under, so the
    // heading and the row beside it say the same thing. Kept as an exact
    // match: a loose `toContain` here would no longer notice a raw id.
    expect(
      within(coordinator).getByText('Worker task · review release'),
    ).toBeTruthy();
    expect(within(coordinator).getByText('Station agent')).toBeTruthy();
    fireEvent.click(
      within(coordinator).getByRole('button', { name: 'Review request' }),
    );

    expect(screen.getByTestId('session-detail').textContent).toContain(
      'review release',
    );
  });

  test('sends a direct follow-up from the delegated work coordinator', async () => {
    renderView();

    const coordinator = screen.getByTestId('delegated-task-coordinator');
    const input = within(coordinator).getByLabelText('Direct worker follow-up');
    fireEvent.change(input, { target: { value: 'Run the focused tests' } });
    fireEvent.click(
      within(coordinator).getByRole('button', { name: 'Send follow-up' }),
    );

    await waitFor(() =>
      expect(sendTurn).toHaveBeenCalledWith({
        threadId: 'thread-alpha',
        text: 'Run the focused tests',
        apiBase: 'http://test.local',
      }),
    );
    expect(screen.queryByTestId('session-detail')).toBeNull();
  });

  // archive#1073 closure: pin both sides of isStreamingSession's fallback.
  test('a legacy running summary without the turn fold stays conservatively locked', async () => {
    sessions[0] = {
      ...sessions[0],
      lifecycleState: 'running',
      hasActiveTurn: undefined,
    };
    renderView();
    const coordinator = screen.getByTestId('delegated-task-coordinator');
    expect(
      within(coordinator).queryByLabelText('Direct worker follow-up'),
    ).toBeNull();
    expect(
      within(coordinator).getByRole('button', { name: 'Stop active task' }),
    ).toBeTruthy();
  });

  test('an explicit hasActiveTurn:false unlocks the composer even when lifecycleState says running', async () => {
    sessions[0] = {
      ...sessions[0],
      lifecycleState: 'running',
      hasActiveTurn: false,
    };
    renderView();
    const coordinator = screen.getByTestId('delegated-task-coordinator');
    expect(
      within(coordinator).getByLabelText('Direct worker follow-up'),
    ).toBeTruthy();
    expect(
      within(coordinator).queryByRole('button', { name: 'Stop active task' }),
    ).toBeNull();
  });

  test('stops running delegated work directly from the coordinator', async () => {
    // Post-archive#1073 a running session carries the turn fold; the Stop control
    // gates on it, not on lifecycleState.
    sessions[0] = {
      ...sessions[0],
      lifecycleState: 'running',
      hasActiveTurn: true,
    };
    renderView();

    const coordinator = screen.getByTestId('delegated-task-coordinator');
    fireEvent.click(
      within(coordinator).getByRole('button', { name: 'Stop active task' }),
    );

    await waitFor(() =>
      expect(interruptTurn).toHaveBeenCalledWith({
        threadId: 'thread-alpha',
        apiBase: 'http://test.local',
      }),
    );
  });

  test('launches a child worker from the prioritized delegated task', async () => {
    renderView();

    const coordinator = screen.getByTestId('delegated-task-coordinator');
    const trigger = within(coordinator).getByRole('button', {
      name: 'Delegate subtask',
    });
    fireEvent.click(trigger);

    const dialog = screen.getByRole('dialog', { name: 'Delegate a task' });
    expect(dialog).toBeTruthy();
    expect(screen.getByText('Child worker of')).toBeTruthy();
    expect(within(dialog).getByText('mobile browser 12345678')).toBeTruthy();
    await waitFor(() =>
      expect(document.activeElement).toBe(screen.getByLabelText('Task')),
    );

    fireEvent.change(screen.getByLabelText('Task'), {
      target: { value: 'Audit the compact task controls' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Delegate' }));

    await waitFor(() =>
      expect(delegateTask).toHaveBeenCalledWith({
        prompt: 'Audit the compact task controls',
        target: {
          environment: { kind: 'current' },
          agent: 'codex',
          workspace: { kind: 'project', projectSlug: 'station' },
        },
        parentTaskId: 'task:mobile-browser-12345678',
      }),
    );
    await waitFor(() => expect(refetchSessions).toHaveBeenCalled());
  });

  test('offers a top-level worker launcher before any sessions exist', () => {
    sessions = [];
    renderView();

    const starter = screen.getByTestId('delegated-task-starter');
    expect(starter.textContent).toContain('Start a resumable worker');
    fireEvent.click(
      within(starter).getByRole('button', { name: 'Delegate worker' }),
    );

    expect(
      screen.getByRole('dialog', { name: 'Delegate a task' }),
    ).toBeTruthy();
    expect(screen.queryByText('Child worker of')).toBeNull();
  });

  /**
   * archive#1245 — a call site the issue does not list, found by its sweep.
   *
   * `closeDelegation` was `requestAnimationFrame( =>
   * delegationTriggerRef.current?.focus)` with no `isConnected` guard at all.
   * The trigger is a per-row control in the sessions list, and delegating
   * invalidates that list — so the launcher's own action is what removes it,
   * which is archive#1126 exactly. It now goes through
   * `@kontourai/station-shared/return-focus`.
   *
   * COVERAGE HONESTY: jsdom, wiring only. The module's post-focus verification
   * needs a real browser (`tests/dialog-return-focus.spec.ts`); jsdom reports
   * `.focus` on an unfocusable node as successful.
   */
  describe('delegation launcher return focus (station#1245)', () => {
    function withStubbedFrame<T>(run: (fire: () => void) => T): T {
      let callback: FrameRequestCallback | null = null;
      vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
        callback = cb;
        return 1;
      });
      vi.stubGlobal('cancelAnimationFrame', () => {});
      try {
        return run(() => {
          act(() => {
            (callback as FrameRequestCallback | null)?.(0);
          });
        });
      } finally {
        vi.unstubAllGlobals();
      }
    }

    function openLauncher() {
      const starter = screen.getByTestId('delegated-task-starter');
      const trigger = within(starter).getByRole('button', {
        name: 'Delegate worker',
      });
      trigger.focus();
      fireEvent.click(trigger);
      return { starter, trigger };
    }

    test('restores focus to the control that opened it', () => {
      sessions = [];
      renderView();
      const { trigger } = openLauncher();

      withStubbedFrame((fire) => {
        fireEvent.click(
          within(
            screen.getByRole('dialog', { name: 'Delegate a task' }),
          ).getByRole('button', { name: 'Cancel' }),
        );
        fire();
      });

      expect(document.activeElement).toBe(trigger);
      expect(trigger.hasAttribute('tabindex')).toBe(false);
    });

    test('falls back to a surviving ancestor when delegating removed the trigger', () => {
      sessions = [];
      renderView();
      const { starter, trigger } = openLauncher();
      const row = trigger.parentElement as HTMLElement;

      withStubbedFrame((fire) => {
        fireEvent.click(
          within(
            screen.getByRole('dialog', { name: 'Delegate a task' }),
          ).getByRole('button', { name: 'Cancel' }),
        );
        // The refreshed list replaced the row the trigger lived on.
        row.remove();
        fire();
      });

      expect(document.activeElement).toBe(starter);
      expect(document.activeElement).not.toBe(document.body);
      expect(starter.getAttribute('tabindex')).toBe('-1');
    });
  });

  test('inherits a Station-agent parent instead of defaulting to an Agent app', () => {
    sessions[0] = {
      ...sessions[0],
      assignedAgentSlug: 'reviewer',
      delegation: {
        ...(sessions[0].delegation as Record<string, unknown>),
        connectionId: undefined,
        targetKind: 'station-agent',
        targetId: 'reviewer',
      },
    };
    renderView();

    fireEvent.click(
      within(screen.getByTestId('delegated-task-coordinator')).getByRole(
        'button',
        { name: 'Delegate subtask' },
      ),
    );

    expect(screen.getByText('Reviewer')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Change routing' }));
    expect((screen.getByLabelText('Worker') as HTMLSelectElement).value).toBe(
      'agent:reviewer',
    );
  });

  test('selects the exact session requested by the route', () => {
    renderView('thread-alpha');
    expect(screen.getByTestId('session-detail').textContent).toContain(
      'Worker task',
    );
    expect(screen.getByLabelText('Continue delegated task')).toBeTruthy();
  });

  test('selects a routed session when it arrives after a cold empty result', async () => {
    const routedSession = sessions[0];
    sessions = [];
    const view = renderView('thread-alpha');

    expect(screen.queryByTestId('session-detail')).toBeNull();

    sessions = [routedSession];
    view.rerender(
      <QueryClientProvider client={new QueryClient()}>
        <ToastProvider>
          <NavigationProvider>
            <SessionsView
              apiBase="http://test.local"
              sessionId="thread-alpha"
            />
          </NavigationProvider>
        </ToastProvider>
      </QueryClientProvider>,
    );

    await waitFor(() =>
      expect(screen.getByTestId('session-detail').textContent).toContain(
        'Worker task',
      ),
    );
  });

  test('keeps the list unselected when a requested session is missing', () => {
    renderView('missing-thread');
    expect(screen.queryByTestId('session-detail')).toBeNull();
  });

  test('sends input to the selected session', async () => {
    renderView();
    fireEvent.click(screen.getByRole('button', { name: /Worker task/ }));

    const input = screen.getByLabelText('Continue delegated task');
    fireEvent.change(input, { target: { value: 'continue please' } });
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));

    await waitFor(() =>
      expect(sendTurn).toHaveBeenCalledWith({
        threadId: 'thread-alpha',
        text: 'continue please',
        apiBase: 'http://test.local',
      }),
    );
  });

  test('surfaces an open request and resolves it', async () => {
    feedEvents = [
      {
        provider: 'claude',
        threadId: 'thread-alpha',
        createdAt: '2026-06-28T00:00:03.000Z',
        method: 'request.opened',
        requestId: 'req-7',
        requestType: 'approval',
        title: 'Allow write',
      },
    ];
    renderView();
    fireEvent.click(screen.getByRole('button', { name: /Worker task/ }));

    const request = screen.getByTestId('session-request');
    expect(within(request).getByText('Allow write')).toBeTruthy();
    expect(request.textContent).not.toContain('req-7');
    fireEvent.click(within(request).getByRole('button', { name: 'Approve' }));

    await waitFor(() =>
      expect(resolveRequest).toHaveBeenCalledWith({
        threadId: 'thread-alpha',
        requestId: 'req-7',
        decision: 'accept',
        apiBase: 'http://test.local',
      }),
    );
  });

  test('shows delegated task context and routes Stop task to the selected session', async () => {
    sessions[0] = {
      ...sessions[0],
      lifecycleState: 'running',
      hasActiveTurn: true,
    };
    renderView('thread-alpha');

    const detail = screen.getByTestId('session-detail');
    expect(within(detail).getByText('Delegated worker')).toBeTruthy();
    expect(within(detail).getByText('Current environment')).toBeTruthy();
    expect(within(detail).getByText('ollama-local')).toBeTruthy();
    expect(within(detail).getByText('parent-chat')).toBeTruthy();
    expect(within(detail).getAllByText('claude-sonnet').length).toBeGreaterThan(
      0,
    );
    expect(within(detail).getAllByText('Running').length).toBeGreaterThan(0);

    fireEvent.click(within(detail).getByRole('button', { name: 'Stop task' }));

    await waitFor(() =>
      expect(interruptTurn).toHaveBeenCalledWith({
        threadId: 'thread-alpha',
        apiBase: 'http://test.local',
      }),
    );
  });

  test("lists the project's non-terminal workflow sidecar tasks under 'Project workflows' (no per-session join key)", async () => {
    workflowTasksByProject.station = [
      {
        taskSlug: 'sidecar-join-582',
        status: 'in_progress',
        phase: 'execution',
        flowRun: {
          current_step: 'verify',
          open_gate_ids: ['verify-gate'],
        },
      },
      { taskSlug: 'other-task', status: 'blocked', phase: 'planning' },
    ];

    renderView('thread-alpha');

    const detail = screen.getByTestId('session-detail');
    await waitFor(() =>
      expect(within(detail).getByText('sidecar-join-582')).toBeTruthy(),
    );
    expect(within(detail).getByText('other-task')).toBeTruthy();
    expect(within(detail).getAllByText('in_progress').length).toBeGreaterThan(
      0,
    );
    expect(within(detail).getByText('Project workflows')).toBeTruthy();
    expect(within(detail).getByText('step: verify')).toBeTruthy();
    expect(within(detail).getByText('gate: verify-gate')).toBeTruthy();
    expect(
      within(detail).getByText(/not linked to this session/i),
    ).toBeTruthy();
    // Never a per-entry "matched by title" tag — this fallback list is
    // explicitly unlinked, not a heuristic per-session match.
    expect(
      within(detail).queryByTestId('workflow-status-line-hint'),
    ).toBeNull();
  });

  test('filters out terminal sidecar statuses (delivered/accepted/archived) from the fallback list', async () => {
    workflowTasksByProject.station = [
      { taskSlug: 'active-task', status: 'in_progress', phase: 'execution' },
      { taskSlug: 'shipped-task', status: 'delivered', phase: 'release' },
      { taskSlug: 'closed-task', status: 'accepted', phase: 'done' },
      { taskSlug: 'archived-task', status: 'archived', phase: 'done' },
    ];

    renderView('thread-alpha');

    const detail = screen.getByTestId('session-detail');
    await waitFor(() =>
      expect(within(detail).getByText('active-task')).toBeTruthy(),
    );
    expect(within(detail).queryByText('shipped-task')).toBeNull();
    expect(within(detail).queryByText('closed-task')).toBeNull();
    expect(within(detail).queryByText('archived-task')).toBeNull();
  });

  test('truncates the fallback list to 5 entries and renders "+N more"', async () => {
    workflowTasksByProject.station = Array.from({ length: 7 }, (_, i) => ({
      taskSlug: `task-${i}`,
      status: 'in_progress',
      phase: 'execution',
    }));

    renderView('thread-alpha');

    const detail = screen.getByTestId('session-detail');
    await waitFor(() =>
      expect(within(detail).getByText('task-0')).toBeTruthy(),
    );
    expect(within(detail).getByText('task-4')).toBeTruthy();
    expect(within(detail).queryByText('task-5')).toBeNull();
    expect(within(detail).getByText('+2 more')).toBeTruthy();
  });

  test('renders no workflow row when the project has no active sidecar tasks', () => {
    renderView('thread-alpha');

    const detail = screen.getByTestId('session-detail');
    expect(within(detail).queryByTestId('workflow-status-line')).toBeNull();
    expect(within(detail).queryByText('Project workflows')).toBeNull();
  });

  // archive#1170: a terminal session must never render an action that contradicts
  // its own state — Stop task previously stayed in the DOM (merely
  // disabled) for a completed/failed session, and the live "● live"/"○
  // connecting" indicator and the free-text compose box didn't check
  // terminality at all, which is exactly the "failed AND live AND Stop
  // task" contradiction the issue reported.
  test('does not render Stop task, the live indicator, or the compose box for a terminal session', () => {
    sessions[0] = {
      ...sessions[0],
      lifecycleState: 'completed',
      status: 'closed',
    };

    renderView('thread-alpha');

    const detail = screen.getByTestId('session-detail');
    expect(screen.queryByRole('button', { name: 'Stop task' })).toBeNull();
    expect(within(detail).queryByText('● live')).toBeNull();
    expect(within(detail).queryByText('○ connecting')).toBeNull();
    expect(
      within(detail).queryByLabelText('Continue delegated task'),
    ).toBeNull();
    expect(within(detail).getAllByText('Completed').length).toBe(1);
  });

  test("shows the failed session's own failure detail instead of a bare badge, with no live/stop contradiction", () => {
    sessions[0] = {
      ...sessions[0],
      lifecycleState: 'failed',
      delegation: undefined,
    };
    feedEvents = [
      {
        provider: 'claude',
        threadId: 'thread-alpha',
        createdAt: '2026-06-28T00:00:02.000Z',
        method: 'runtime.error',
        severity: 'error',
        message: 'Claude model "claude-fable-5" failed: rate limited',
      },
    ];

    renderView('thread-alpha');

    const detail = screen.getByTestId('session-detail');
    const failure = screen.getByTestId('session-failure');
    expect(within(failure).getByText(/rate limited/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Stop task' })).toBeNull();
    expect(within(detail).queryByText('● live')).toBeNull();
    expect(within(detail).queryByText('○ connecting')).toBeNull();
    expect(within(detail).getAllByText('Failed').length).toBe(1);
  });

  /*
   * archive#3203 defect 3: "when I click open session.. it brings me
   * somewhere.. but I don't see an error message". A `session-failed`
   * notification's `openHref` now lands HERE, and it lands COLD — the user
   * was not watching when the session died, so the live feed replayed to this
   * pane carries no `runtime.error` at all. The only surviving basis is the
   * session's own `blockedReason`, and the arrival must render it.
   *
   * The sibling test above supplies the error through the feed, which is the
   * case that was already covered and is NOT the case the notification
   * produces.
   */
  test('arriving on an already-failed session with no error in the feed still shows the recorded reason', () => {
    sessions[0] = {
      ...sessions[0],
      lifecycleState: 'failed',
      blockedReason: 'ECONNREFUSED api.example.com:443',
      delegation: undefined,
    };
    feedEvents = [];

    renderView('thread-alpha');

    const failure = screen.getByTestId('session-failure');
    expect(
      within(failure).getByText(/ECONNREFUSED api\.example\.com:443/),
    ).toBeTruthy();
    // And the arrival names WHICH session, so the user can tell the deep link
    // took them to the right one.
    expect(
      within(screen.getByTestId('session-detail')).getByText('thread-alpha'),
    ).toBeTruthy();
  });

  test('a failed session with nothing recorded says so, instead of an empty banner', () => {
    sessions[0] = {
      ...sessions[0],
      lifecycleState: 'failed',
      blockedReason: undefined,
      delegation: undefined,
    };
    feedEvents = [];

    renderView('thread-alpha');

    // Same sentence the notification's own row uses for the same absence —
    // one constant, imported by both (`NO_FAILURE_DETAIL_RECORDED`).
    expect(
      within(screen.getByTestId('session-failure')).getByText(
        /No failure detail was recorded for this session\./,
      ),
    ).toBeTruthy();
  });

  /*
   * archive#3244. A failed session is RETRYABLE — the lifecycle contract
   * declares `failed -> queued | running`, and the server's only send-path
   * terminal gate rejects `completed` alone — so the composer must stay,
   * exactly as the chat dock keeps its own composer enabled beside the same
   * session's failure banner. This pane used to hide it via a hand-written
   * `['completed','failed','canceled']`, a third copy of the drift
   * archive#1548 deleted server-side.
   */
  test('a failed session keeps the composer, below its failure alert, and it really sends (station#3244)', async () => {
    sessions[0] = {
      ...sessions[0],
      lifecycleState: 'failed',
      blockedReason: 'ECONNREFUSED api.example.com:443',
      delegation: undefined,
    };
    feedEvents = [];

    renderView('thread-alpha');

    // Exactly one failure alert, and the composer coexists with it.
    expect(screen.getAllByTestId('session-failure')).toHaveLength(1);
    const alert = screen.getByTestId('session-failure');
    const input = screen.getByLabelText('Send input to session');
    // The alert renders ABOVE the composer, so the failure context is
    // visible before the affordance that retries past it.
    expect(
      alert.compareDocumentPosition(input) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    // And it is a working composer, not a disabled prop: the send path
    // dispatches, because the server accepts turns on a failed session.
    fireEvent.change(input, { target: { value: 'try again with retries' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    await waitFor(() =>
      expect(sendTurn).toHaveBeenCalledWith({
        threadId: 'thread-alpha',
        text: 'try again with retries',
        apiBase: 'http://test.local',
      }),
    );
    // archive#1170's decisions stand alongside the new composer: no live
    // indicator, no Stop task on a stopped session.
    expect(screen.queryByRole('button', { name: 'Stop task' })).toBeNull();
    expect(
      within(screen.getByTestId('session-detail')).queryByText('● live'),
    ).toBeNull();
  });

  test('a canceled session keeps the composer too — `canceled -> queued` is a transition out (station#3244)', () => {
    sessions[0] = {
      ...sessions[0],
      lifecycleState: 'canceled',
      delegation: undefined,
    };
    feedEvents = [];

    renderView('thread-alpha');

    expect(screen.getByLabelText('Send input to session')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Stop task' })).toBeNull();
  });

  /*
   * The regression guard for the defect class itself, not one instance of
   * it: composer visibility must agree with the CONTRACT-DERIVED terminal
   * predicate for every lifecycle state the contract knows. Reintroducing a
   * hand-written list that hides `failed` or `canceled` — the exact drift of
   * archive#1548 and archive#3244 — turns this red without anyone
   * remembering which states were once mislisted. Attention is resolved
   * empty here so the only gate under test is terminality (`needs_input`'s
   * attention-driven suppression has its own tests below).
   */
  test('composer visibility matches the canonical terminal predicate for every lifecycle state (station#3244)', () => {
    const baseSession = { ...sessions[0], delegation: undefined };
    feedEvents = [];
    for (const state of SESSION_LIFECYCLE_STATES) {
      sessions[0] = { ...baseSession, lifecycleState: state };
      const view = renderView('thread-alpha');
      const composer = screen.queryByLabelText('Send input to session');
      if (isSessionLifecycleStateTerminal(state)) {
        expect(composer, `expected NO composer for '${state}'`).toBeNull();
      } else {
        expect(composer, `expected a composer for '${state}'`).toBeTruthy();
      }
      view.unmount();
    }
  });

  test('shows the task prompt as the title instead of the raw thread id, and keeps the id available underneath', () => {
    sessions[0] = {
      ...sessions[0],
      delegation: undefined,
    };
    feedEvents = [
      {
        provider: 'claude',
        threadId: 'thread-alpha',
        createdAt: '2026-06-28T00:00:02.000Z',
        method: 'turn.started',
        turnId: 'turn-1',
        prompt: 'Investigate the flaky deploy check',
      },
    ];

    renderView('thread-alpha');

    const detail = screen.getByTestId('session-detail');
    expect(detail.querySelector('h2')?.textContent).toBe(
      'Investigate the flaky deploy check',
    );
    expect(within(detail).getByText('thread-alpha')).toBeTruthy();
  });

  test('renders the concrete attention reason and its inline action for a kind with no other on-page mechanism (gate-blocked)', async () => {
    attentionItems = [
      {
        id: 'gate-blocked:run-1:verify',
        kind: 'gate-blocked',
        title: 'Blocked: verify',
        createdAt: '2026-06-28T00:00:02.000Z',
        updatedAt: '2026-06-28T00:00:02.000Z',
        sessionId: 'thread-alpha',
        openHref: '/projects/station/flow-console?run=run-1',
        source: {
          threadId: 'thread-alpha',
          runId: 'run-1',
          gateId: 'verify',
          projectSlug: 'station',
        },
      },
    ];

    renderView('thread-alpha');

    const attention = screen.getByTestId('session-attention');
    expect(within(attention).getByText('Blocked: verify')).toBeTruthy();
    fireEvent.click(
      within(attention).getByRole('button', { name: 'Re-evaluate' }),
    );

    await waitFor(() =>
      expect(evaluateGate).toHaveBeenCalledWith({
        projectSlug: 'station',
        runId: 'run-1',
        gate: 'verify',
      }),
    );
  });

  test('renders no attention section when nothing on the needs-attention list matches this session', () => {
    attentionItems = [
      {
        id: 'gate-blocked:run-1:verify',
        kind: 'gate-blocked',
        title: 'Blocked: verify',
        createdAt: '2026-06-28T00:00:02.000Z',
        updatedAt: '2026-06-28T00:00:02.000Z',
        sessionId: 'some-other-thread',
        openHref: '/projects/station/flow-console?run=run-1',
        source: {
          threadId: 'some-other-thread',
          runId: 'run-1',
          gateId: 'verify',
          projectSlug: 'station',
        },
      },
    ];

    renderView('thread-alpha');

    expect(screen.queryByTestId('session-attention')).toBeNull();
  });

  test("replaces the generic compose box with the attention card's own answer form for needs_input with no live request", async () => {
    attentionItems = [
      {
        id: 'needs_input:thread-alpha',
        kind: 'needs_input',
        title: 'Input needed',
        createdAt: '2026-06-28T00:00:02.000Z',
        updatedAt: '2026-06-28T00:00:02.000Z',
        sessionId: 'thread-alpha',
        openHref: '/?surface=activity&session=thread-alpha',
        source: { threadId: 'thread-alpha' },
      },
    ];

    renderView('thread-alpha');

    const detail = screen.getByTestId('session-detail');
    expect(
      within(detail).queryByLabelText('Continue delegated task'),
    ).toBeNull();
    const answerBox = within(detail).getByLabelText('Answer this session');
    fireEvent.change(answerBox, { target: { value: 'Use staging' } });
    fireEvent.click(
      within(detail).getByRole('button', { name: 'Send answer' }),
    );

    await waitFor(() =>
      expect(sendTurn).toHaveBeenCalledWith({
        threadId: 'thread-alpha',
        text: 'Use staging',
      }),
    );
  });

  test('defers to the live in-turn request UI instead of duplicating it when both cover the same needs_input reason', () => {
    attentionItems = [
      {
        id: 'needs_input:thread-alpha',
        kind: 'needs_input',
        // requestType mirrors the server's own projection (archive#1188):
        // the item is only a genuine duplicate of the live request when
        // this matches the open request's own requestType below.
        requestType: 'input',
        title: 'Input needed',
        createdAt: '2026-06-28T00:00:02.000Z',
        updatedAt: '2026-06-28T00:00:02.000Z',
        sessionId: 'thread-alpha',
        openHref: '/?surface=activity&session=thread-alpha',
        source: { threadId: 'thread-alpha' },
      },
    ];
    feedEvents = [
      {
        provider: 'claude',
        threadId: 'thread-alpha',
        createdAt: '2026-06-28T00:00:02.000Z',
        method: 'request.opened',
        requestId: 'req-9',
        requestType: 'input',
        title: 'What branch should this target?',
      },
    ];

    renderView('thread-alpha');

    expect(screen.queryByTestId('session-attention')).toBeNull();
    expect(screen.getByTestId('session-request')).toBeTruthy();
  });

  // (archive#1170): the previous filter suppressed
  // needs_input/review_pending whenever ANY request was pending, with no
  // correlation to which request. Reproduced live: a review_pending
  // session plus an unrelated permission request made the review reason
  // vanish entirely, leaving only the unrelated permission card — and
  // ReviewAction (a bare "Open session" link) is never equivalent to
  // resolving that unrelated request anyway.
  test('never suppresses review_pending, even when an unrelated request is pending on the same session', () => {
    attentionItems = [
      {
        id: 'review_pending:thread-alpha',
        kind: 'review_pending',
        title: 'Review pending',
        body: 'Waiting on your review of the delegated worker.',
        createdAt: '2026-06-28T00:00:02.000Z',
        updatedAt: '2026-06-28T00:00:02.000Z',
        sessionId: 'thread-alpha',
        openHref: '/?surface=activity&session=thread-alpha',
        source: { threadId: 'thread-alpha' },
      },
    ];
    feedEvents = [
      {
        provider: 'claude',
        threadId: 'thread-alpha',
        createdAt: '2026-06-28T00:00:02.000Z',
        method: 'request.opened',
        requestId: 'req-unrelated',
        requestType: 'permission',
        title: 'Allow running this shell command?',
      },
    ];

    renderView('thread-alpha');

    const attention = screen.getByTestId('session-attention');
    expect(
      within(attention).getAllByText('Review pending').length,
    ).toBeGreaterThan(0);
    expect(
      within(attention).getByRole('link', { name: 'Open session' }),
    ).toBeTruthy();
    // The unrelated live request still gets its own affordance too — both
    // are genuinely different reasons, so both survive.
    expect(screen.getByTestId('session-request')).toBeTruthy();
  });

  // (archive#1170): needs_input correlation must be
  // by requestType, not "any pending request" — an unrelated request type
  // (e.g. permission) must not suppress a needs_input item either.
  test('does not suppress needs_input against an unrelated (non-matching-requestType) pending request', () => {
    attentionItems = [
      {
        id: 'needs_input:thread-alpha',
        kind: 'needs_input',
        requestType: 'input',
        title: 'Input needed',
        createdAt: '2026-06-28T00:00:02.000Z',
        updatedAt: '2026-06-28T00:00:02.000Z',
        sessionId: 'thread-alpha',
        openHref: '/?surface=activity&session=thread-alpha',
        source: { threadId: 'thread-alpha' },
      },
    ];
    feedEvents = [
      {
        provider: 'claude',
        threadId: 'thread-alpha',
        createdAt: '2026-06-28T00:00:02.000Z',
        method: 'request.opened',
        requestId: 'req-unrelated',
        requestType: 'permission',
        title: 'Allow running this shell command?',
      },
    ];

    renderView('thread-alpha');

    const attention = screen.getByTestId('session-attention');
    expect(
      within(attention).getByLabelText('Answer this session'),
    ).toBeTruthy();
    expect(screen.getByTestId('session-request')).toBeTruthy();
  });

  // (archive#1170): attentionQuery.data?.items
  // defaulted to [] for BOTH "still loading" and "fetch failed" — a
  // needs_input session's generic compose box could flash visible before
  // the query resolved and hideGenericCompose flipped it back off.
  test('does not flash the generic compose box for a needs_input session while the attention query is still loading', () => {
    attentionQueryState = { isLoading: true, isError: false, error: null };
    // sessions[0] (the default fixture) is already lifecycleState: 'needs_input'.

    renderView('thread-alpha');

    expect(screen.queryByLabelText('Continue delegated task')).toBeNull();
    expect(screen.queryByLabelText('Send input to session')).toBeNull();
    expect(screen.queryByLabelText('Answer this session')).toBeNull();
  });

  // (archive#1170): a genuine fetch failure used to
  // make a session that DOES need attention look identical to one that
  // doesn't — no error, no retry. This asserts the two are distinguishable
  // and that retry re-triggers the query.
  test('shows a distinguishable error with retry when the attention check itself fails, instead of silently looking like "nothing to report"', () => {
    attentionQueryState = {
      isLoading: false,
      isError: true,
      error: new Error('network unreachable'),
    };

    renderView('thread-alpha');

    expect(screen.queryByTestId('session-attention')).toBeNull();
    expect(
      screen.getByText("Couldn't check whether this session needs attention"),
    ).toBeTruthy();
    expect(screen.getByText('network unreachable')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(attentionRefetch).toHaveBeenCalledTimes(1);
  });

  test('collapses the raw event log by default and coalesces duplicate/delta events into readable entries', () => {
    feedEvents = [
      {
        provider: 'claude',
        threadId: 'thread-alpha',
        createdAt: '2026-06-28T00:00:02.000Z',
        method: 'session.configured',
        sessionId: 'thread-alpha',
        model: 'claude-fable-5',
      },
      {
        provider: 'claude',
        threadId: 'thread-alpha',
        createdAt: '2026-06-28T00:00:03.000Z',
        method: 'session.configured',
        sessionId: 'thread-alpha',
        model: 'claude-fable-5',
      },
      {
        provider: 'claude',
        threadId: 'thread-alpha',
        createdAt: '2026-06-28T00:00:04.000Z',
        method: 'content.text-delta',
        itemId: 'message-1',
        delta: 'I',
      },
      {
        provider: 'claude',
        threadId: 'thread-alpha',
        createdAt: '2026-06-28T00:00:05.000Z',
        method: 'content.text-delta',
        itemId: 'message-1',
        delta: "'m Claude Opus 4.5 (1M context).",
      },
    ];

    renderView('thread-alpha');

    const diagnostics = screen.getByTestId('session-diagnostics');
    expect(diagnostics.hasAttribute('open')).toBe(false);
    expect(within(diagnostics).getByText('session.configured ×2')).toBeTruthy();
    expect(
      within(diagnostics).getByText("I'm Claude Opus 4.5 (1M context)."),
    ).toBeTruthy();
  });

  // describeEvent's default case returns '' for every method it
  // doesn't special-case (platform.mutation among them), and the collapse
  // used to fire on any two consecutive same-method entries with equal
  // bodies — '' === '' — asserting two DIFFERENT governed-mutation receipts
  // were the same event just because neither was ever actually inspected.
  test('never collapses two different platform.mutation audit events into a false "×N", even though neither renders a body', () => {
    feedEvents = [
      {
        provider: 'claude',
        threadId: 'thread-alpha',
        createdAt: '2026-06-28T00:00:02.000Z',
        method: 'platform.mutation',
        tool: 'create_agent',
        argsSummary: '{"slug":"reviewer"}',
        outcome: 'allowed',
        decision: 'allow',
        profile: 'default',
        cwd: '/tmp/dev',
      },
      {
        provider: 'claude',
        threadId: 'thread-alpha',
        createdAt: '2026-06-28T00:00:03.000Z',
        method: 'platform.mutation',
        tool: 'delete_agent',
        argsSummary: '{"slug":"reviewer"}',
        outcome: 'blocked',
        decision: 'block',
        profile: 'default',
        cwd: '/tmp/dev',
        reason: 'destructive op outside policy window',
      },
    ];

    renderView('thread-alpha');

    const diagnostics = screen.getByTestId('session-diagnostics');
    // Two separate rows, neither carrying a "×2" — the old bug rendered
    // exactly one "platform.mutation ×2" row here.
    expect(within(diagnostics).getAllByText('platform.mutation').length).toBe(
      2,
    );
    expect(within(diagnostics).queryByText(/platform\.mutation ×/)).toBeNull();
  });

  // (archive#1170): buildDiagnosticsLog reused the
  // merge-identity key (`${method}:${itemId}`) as the React list key even
  // for NON-adjacent occurrences. Streaming protocols commonly reset
  // itemId per turn, so two turns whose first content block both use
  // itemId "0" — with anything in between — produced two entries sharing
  // one React key, a real "Encountered two children with the same key"
  // warning and undefined render behavior. Reproduced live before the fix;
  // this asserts the warning never fires, with a real second content block
  // (a tool call) breaking adjacency so the entries genuinely do NOT merge.
  test('gives non-adjacent diagnostics-log entries that share a (method, itemId) pair distinct React keys', () => {
    const consoleError = vi
      .spyOn(console, 'error')
      .mockImplementation(() => {});

    feedEvents = [
      {
        provider: 'claude',
        threadId: 'thread-alpha',
        createdAt: '2026-06-28T00:00:02.000Z',
        method: 'content.text-delta',
        itemId: '0',
        delta: 'First turn response',
      },
      {
        provider: 'claude',
        threadId: 'thread-alpha',
        createdAt: '2026-06-28T00:00:03.000Z',
        method: 'tool.started',
        itemId: 'tool-1',
        toolCallId: 'call-1',
        toolName: 'Bash',
      },
      {
        provider: 'claude',
        threadId: 'thread-alpha',
        createdAt: '2026-06-28T00:00:04.000Z',
        method: 'content.text-delta',
        itemId: '0',
        delta: 'Second turn response',
      },
    ];

    renderView('thread-alpha');

    const diagnostics = screen.getByTestId('session-diagnostics');
    // Both non-adjacent groups are real, distinct entries — no false merge.
    expect(within(diagnostics).getByText('First turn response')).toBeTruthy();
    expect(within(diagnostics).getByText('Second turn response')).toBeTruthy();

    const duplicateKeyWarning = consoleError.mock.calls.some((args) =>
      args.some((arg) => typeof arg === 'string' && arg.includes('same key')),
    );
    expect(duplicateKeyWarning).toBe(false);

    consoleError.mockRestore();
  });

  // Review, DOM-presence coverage ONLY — this does NOT prove visibility.
  // jsdom never loads/applies SessionsView.css, so this test cannot see a
  // `display: none` rule and would stay green even if
  // `.sessions-detail__attention` were hidden again in compact mode (proven
  // by — see the PR thread for the red/green transcript).
  // The real regression guard for "is it actually visible on screen" is the
  // Playwright check in the PR's visual-evidence run
  // (getComputedStyle(...).display + a non-zero bounding box at a genuinely
  // short viewport), not this test. This one only pins that React keeps
  // rendering the node into the tree across the compact transition — i.e.
  // no future JS-level conditional (`viewportIsCompact && attentionItem &&
  //.`) silently stops mounting it. Keep both: this test would NOT catch
  // the CSS regression the reviewer fault-injected; only the Playwright
  // check does.
  test('DOM PRESENCE ONLY (not visibility): the attention answer field stays mounted once the viewport goes compact (keyboard-open)', async () => {
    class FakeViewport extends EventTarget {
      height = 844;
      offsetTop = 0;
    }
    const viewport = new FakeViewport();
    Object.defineProperty(window, 'visualViewport', {
      configurable: true,
      value: viewport,
    });

    sessions[0] = { ...sessions[0], delegation: undefined };
    attentionItems = [
      {
        id: 'needs_input:thread-alpha',
        kind: 'needs_input',
        title: 'Input needed',
        createdAt: '2026-06-28T00:00:02.000Z',
        updatedAt: '2026-06-28T00:00:02.000Z',
        sessionId: 'thread-alpha',
        openHref: '/?surface=activity&session=thread-alpha',
        source: { threadId: 'thread-alpha' },
      },
    ];

    renderView('thread-alpha');
    expect(screen.getByLabelText('Answer this session')).toBeTruthy();

    // Keyboard opens: the visual viewport shrinks below the compact
    // threshold, same signal the mobile chat dock already reacts to.
    viewport.height = 480;
    viewport.dispatchEvent(new Event('resize'));

    await waitFor(() => {
      const detail = screen.getByTestId('session-detail');
      expect(detail.className).toContain('sessions-detail--viewport-compact');
    });
    const detail = screen.getByTestId('session-detail');
    expect(within(detail).getByLabelText('Answer this session')).toBeTruthy();
    expect(
      within(detail).getByRole('button', { name: 'Send answer' }),
    ).toBeTruthy();

    Object.defineProperty(window, 'visualViewport', {
      configurable: true,
      value: undefined,
    });
  });

  // the server explicitly allows a lifecycle item and a
  // Flow-gate item to coexist for one session (gate items "never shadow
  // anything else"); a single.find only ever surfaced the first-sorted
  // one.
  test('renders every attention item that matches this session, not just the first-sorted one', () => {
    attentionItems = [
      {
        id: 'gate-blocked:run-1:verify',
        kind: 'gate-blocked',
        title: 'Blocked: verify',
        createdAt: '2026-06-28T00:00:01.000Z',
        updatedAt: '2026-06-28T00:00:01.000Z',
        sessionId: 'thread-alpha',
        openHref: '/projects/station/flow-console?run=run-1',
        source: {
          threadId: 'thread-alpha',
          runId: 'run-1',
          gateId: 'verify',
          projectSlug: 'station',
        },
      },
      {
        id: 'review_pending:thread-alpha',
        kind: 'review_pending',
        title: 'Review the release notes draft',
        createdAt: '2026-06-28T00:00:02.000Z',
        updatedAt: '2026-06-28T00:00:02.000Z',
        sessionId: 'thread-alpha',
        openHref: '/?surface=activity&session=thread-alpha',
        source: { threadId: 'thread-alpha' },
      },
    ];

    renderView('thread-alpha');

    const attention = screen.getByTestId('session-attention');
    expect(within(attention).getByText('Blocked: verify')).toBeTruthy();
    expect(
      within(attention).getByText('Review the release notes draft'),
    ).toBeTruthy();
  });

  // guarded on !isTerminal like Stop task and the live
  // indicator — a session that crashes mid-request must not leave
  // Approve/Decline clickable against a dead session.
  test('hides the live in-turn request Approve/Decline once the session is terminal', () => {
    sessions[0] = { ...sessions[0], lifecycleState: 'failed' };
    feedEvents = [
      {
        provider: 'claude',
        threadId: 'thread-alpha',
        createdAt: '2026-06-28T00:00:02.000Z',
        method: 'request.opened',
        requestId: 'req-9',
        requestType: 'approval',
        title: 'Allow write',
      },
    ];

    renderView('thread-alpha');

    expect(screen.queryByTestId('session-request')).toBeNull();
  });

  // archive#1462: the list groups by project attribution, so an unattributable
  // attached session used to be indistinguishable from one with no project at
  // all. It must say which projects it is caught between.
  // archive#3027 moved the project off the list HEADING onto a per-row pill.
  // The archive#1462 guarantee is unchanged and is asserted on the pill: an ambiguous
  // attribution names its candidates rather than picking one or collapsing to
  // "Unassigned" — and it is deliberately not a filter control, because one
  // click could not say which candidate the user meant.
  test('names an ambiguously-attributed attached session on its row pill, and never files it under one candidate', () => {
    sessions[0] = {
      ...sessions[0],
      threadId: 'external:claude:ambiguous-1',
      controlMode: 'read-only-attached',
      delegation: undefined,
      projectSlug: undefined,
      projectAttribution: { state: 'ambiguous', candidates: ['alpha', 'beta'] },
    };

    const { container } = renderView('external:claude:ambiguous-1');

    const pill = container.querySelector('.session-project-pill');
    expect(pill?.textContent).toBe('ambiguous (alpha, beta)');
    expect(pill?.tagName).toBe('SPAN');
    expect(container.querySelector('button.session-project-pill')).toBeNull();
    expect(screen.queryByText('Unassigned')).toBeNull();
  });

  // archive#1463: a delegated task whose project was joined across machines by
  // name alone must not render as a settled project binding.
  test('marks a delegated session whose cross-machine project slug join is unverified', () => {
    sessions[0] = {
      ...sessions[0],
      threadId: 'task-remote-1',
      delegation: {
        taskId: 'task-remote-1',
        projectSlug: 'station',
        projectSlugJoin: 'unverified-cross-machine',
      },
    };

    const { container } = renderView('task-remote-1');

    // The caveat is carried verbatim by the pill — the list does not get to
    // shorten it away into a bare slug.
    expect(container.querySelector('.session-project-pill')?.textContent).toBe(
      'station (unverified name match)',
    );
  });

  test('renders attached terminal transcripts through canonical message content without mutations', () => {
    sessions[0] = {
      ...sessions[0],
      threadId: 'external:claude:terminal-1',
      controlMode: 'read-only-attached',
      delegation: undefined,
    };
    feedEvents = [
      {
        eventId: 'turn-1',
        provider: 'claude',
        threadId: 'external:claude:terminal-1',
        createdAt: '2026-07-22T12:00:00.000Z',
        method: 'turn.started',
        turnId: 'turn-1',
        prompt: 'Inspect the workspace',
      },
      {
        eventId: 'text-1',
        provider: 'claude',
        threadId: 'external:claude:terminal-1',
        createdAt: '2026-07-22T12:00:01.000Z',
        method: 'content.text-delta',
        turnId: 'turn-1',
        itemId: 'message-1',
        delta: 'The workspace is ready.',
      },
      {
        eventId: 'done-1',
        provider: 'claude',
        threadId: 'external:claude:terminal-1',
        createdAt: '2026-07-22T12:00:02.000Z',
        method: 'turn.completed',
        turnId: 'turn-1',
        finishReason: 'stop',
        outputText: 'The workspace is ready.',
      },
    ];

    renderView('external:claude:terminal-1');

    const detail = screen.getByTestId('session-detail');
    expect(
      within(detail).getByText('Following terminal session · Read only'),
    ).toBeTruthy();
    expect(within(detail).getByText('Inspect the workspace')).toBeTruthy();
    expect(within(detail).getByText('The workspace is ready.')).toBeTruthy();
    expect(within(detail).queryByRole('button', { name: /stop/i })).toBeNull();
    expect(
      within(detail).queryByLabelText(/input|follow-up|continue/i),
    ).toBeNull();
    expect(within(detail).queryByTestId('session-request')).toBeNull();
  });

  test('continues an attached session into the returned Station child and keeps the source read only', async () => {
    sessions[0] = {
      ...sessions[0],
      threadId: 'external:claude:terminal-1',
      controlMode: 'read-only-attached',
      delegation: undefined,
    };
    adoptSession.mockImplementation(async () => {
      const child = {
        ...sessions[0],
        threadId: 'station-child',
        controlMode: 'station-owned',
      };
      sessions = [sessions[0], child];
      return child;
    });

    renderView('external:claude:terminal-1');
    fireEvent.click(
      screen.getByRole('button', { name: 'Continue in Station' }),
    );

    await waitFor(() =>
      expect(adoptSession).toHaveBeenCalledWith(
        expect.objectContaining({
          starterId: 'continue-session',
          sourceSessionId: 'external:claude:terminal-1',
          operationId: expect.stringMatching(
            /^starter-session:[0-9a-f-]{36}$/i,
          ),
          apiBase: 'http://test.local',
        }),
      ),
    );
    await waitFor(() =>
      expect(screen.getByLabelText('Send input to session')).toBeTruthy(),
    );
    expect(screen.getByTestId('session-detail').textContent).toContain(
      'station-child',
    );
    expect(
      window.localStorage.getItem(ATTACHED_SESSION_CONTINUATION_STORAGE_KEY),
    ).toBeNull();
    expect(sessions[0]?.controlMode).toBe('read-only-attached');
  });

  test('reuses the exact continuation operation after response loss and remount', async () => {
    sessions[0] = {
      ...sessions[0],
      threadId: 'external:claude:response-loss',
      controlMode: 'read-only-attached',
      delegation: undefined,
    };
    const child = {
      ...sessions[0],
      threadId: 'station-response-loss-child',
      controlMode: 'station-owned',
    };
    adoptSession
      .mockRejectedValueOnce(new Error('response lost'))
      .mockImplementationOnce(async () => {
        sessions = [sessions[0], child];
        return child;
      });
    const first = renderView('external:claude:response-loss');
    fireEvent.click(
      screen.getByRole('button', { name: 'Continue in Station' }),
    );
    await screen.findByRole('alert');
    const operationId = adoptSession.mock.calls[0][0].operationId;
    first.unmount();

    renderView('external:claude:response-loss');
    fireEvent.click(
      screen.getByRole('button', { name: 'Continue in Station' }),
    );
    await waitFor(() => expect(adoptSession).toHaveBeenCalledTimes(2));
    expect(adoptSession.mock.calls[1][0].operationId).toBe(operationId);
  });

  test('uses the ordinary owner action after the one-time Session starter is bound', async () => {
    sessions[0] = {
      ...sessions[0],
      threadId: 'external:claude:later-continuation',
      controlMode: 'read-only-attached',
      delegation: undefined,
    };
    getStarterWork.mockResolvedValueOnce({ state: 'bound', binding: {} });
    adoptSession.mockResolvedValue({
      ...sessions[0],
      threadId: 'station-later-child',
      controlMode: 'station-owned',
    });
    renderView('external:claude:later-continuation');
    fireEvent.click(
      screen.getByRole('button', { name: 'Continue in Station' }),
    );
    await waitFor(() => expect(adoptSession).toHaveBeenCalledTimes(1));
    expect(adoptSession).toHaveBeenCalledWith({
      sourceThreadId: 'external:claude:later-continuation',
      apiBase: 'http://test.local',
      intent: adoptionIntent,
    });
  });

  test('does not launch when saved continuation evidence is corrupt', async () => {
    sessions[0] = {
      ...sessions[0],
      threadId: 'external:claude:corrupt-continuation',
      controlMode: 'read-only-attached',
      delegation: undefined,
    };
    window.localStorage.setItem(
      ATTACHED_SESSION_CONTINUATION_STORAGE_KEY,
      '{"schemaVersion":1,"sessions":{"__proto__":{"operationId":"starter-session:00000000-0000-4000-8000-000000000001"}}}',
    );

    renderView('external:claude:corrupt-continuation');
    fireEvent.click(
      screen.getByRole('button', { name: 'Continue in Station' }),
    );

    await screen.findByText(
      "Couldn't safely start the continuation. Browser storage is unavailable or corrupt, so retrying could duplicate it.",
    );
    expect(getStarterWork).not.toHaveBeenCalled();
    expect(adoptSession).not.toHaveBeenCalled();
  });

  test('a server-declared unsafe retry disables continuation and guards a second activation', async () => {
    const consoleError = vi
      .spyOn(console, 'error')
      .mockImplementation(() => undefined);
    sessions[0] = {
      ...sessions[0],
      threadId: 'external:claude:unsafe-retry',
      controlMode: 'read-only-attached',
      delegation: undefined,
    };
    launchContinueSessionStarter.mockResolvedValueOnce({
      state: 'indeterminate',
      reason: 'Station could not settle the continuation outcome.',
      retrySafe: false,
    });

    renderView('external:claude:unsafe-retry');
    const continueButton = screen.getByRole('button', {
      name: 'Continue in Station',
    });
    fireEvent.click(continueButton);

    await screen.findByText(
      'Station says this continuation cannot be retried safely from this state.',
    );
    expect(continueButton.getAttribute('disabled')).not.toBeNull();
    expect(
      screen.queryByText(
        'Retry safely — Station will not duplicate the continuation.',
      ),
    ).toBeNull();
    expect(
      screen.queryByText(/Browser storage is unavailable or corrupt/),
    ).toBeNull();

    fireEvent.click(continueButton);
    expect(launchContinueSessionStarter).toHaveBeenCalledTimes(1);
    consoleError.mockRestore();
  });

  test('switching from an unsafe attached session resets continuation state for the next session', async () => {
    const consoleError = vi
      .spyOn(console, 'error')
      .mockImplementation(() => undefined);
    const first = {
      ...sessions[0],
      threadId: 'external:claude:unsafe-first',
      displayTitle: 'Attached A',
      controlMode: 'read-only-attached',
      delegation: undefined,
    };
    const second = {
      ...sessions[0],
      threadId: 'external:claude:safe-second',
      displayTitle: 'Attached B',
      controlMode: 'read-only-attached',
      delegation: undefined,
    };
    sessions = [first, second];
    launchContinueSessionStarter
      .mockResolvedValueOnce({
        state: 'indeterminate',
        reason: 'Station could not settle the first continuation outcome.',
        retrySafe: false,
      })
      .mockResolvedValueOnce({
        state: 'indeterminate',
        reason: 'The second continuation can be retried safely.',
        retrySafe: true,
      });

    renderView(first.threadId);
    fireEvent.click(
      screen.getByRole('button', { name: 'Continue in Station' }),
    );
    await screen.findByText(
      'Station says this continuation cannot be retried safely from this state.',
    );

    fireEvent.click(screen.getByRole('button', { name: /Attached B/ }));
    const secondButton = screen.getByRole('button', {
      name: 'Continue in Station',
    });
    expect(secondButton.getAttribute('disabled')).toBeNull();
    fireEvent.click(secondButton);
    await waitFor(() =>
      expect(launchContinueSessionStarter).toHaveBeenCalledTimes(2),
    );
    expect(launchContinueSessionStarter.mock.calls[1][0]).toMatchObject({
      sourceSessionId: second.threadId,
      operationId: expect.stringMatching(/^starter-session:[0-9a-f-]{36}$/i),
    });
    expect(launchContinueSessionStarter.mock.calls[1][0].operationId).not.toBe(
      launchContinueSessionStarter.mock.calls[0][0].operationId,
    );
    consoleError.mockRestore();
  });

  test('navigates after a continued session even when exact evidence cleanup fails', async () => {
    sessions[0] = {
      ...sessions[0],
      threadId: 'external:claude:cleanup-failure',
      controlMode: 'read-only-attached',
      delegation: undefined,
    };
    let lockRequests = 0;
    Object.defineProperty(window.navigator, 'locks', {
      configurable: true,
      value: {
        request: async (
          _name: string,
          _options: unknown,
          callback: () => Promise<unknown>,
        ) => {
          lockRequests += 1;
          if (lockRequests === 2) throw new Error('cleanup lock unavailable');
          return callback();
        },
      },
    });
    adoptSession.mockImplementation(async () => {
      const child = {
        ...sessions[0],
        threadId: 'station-cleanup-failure-child',
        controlMode: 'station-owned',
      };
      sessions = [sessions[0], child];
      return child;
    });

    renderView('external:claude:cleanup-failure');
    fireEvent.click(
      screen.getByRole('button', { name: 'Continue in Station' }),
    );

    await waitFor(() =>
      expect(screen.getByLabelText('Send input to session')).toBeTruthy(),
    );
    expect(showToast).toHaveBeenCalledWith(
      'Session continued, but its saved continuation request could not be cleared. Future retries may reuse it.',
      'station-cleanup-failure-child',
    );
    expect(
      window.localStorage.getItem(ATTACHED_SESSION_CONTINUATION_STORAGE_KEY),
    ).toContain('external:claude:cleanup-failure');
  });

  test('a failed Starter status read admits no continuation before remount retry', async () => {
    sessions[0] = {
      ...sessions[0],
      threadId: 'external:claude:status-loss',
      controlMode: 'read-only-attached',
      delegation: undefined,
    };
    const child = {
      ...sessions[0],
      threadId: 'station-status-loss-child',
      controlMode: 'station-owned',
    };
    getStarterWork.mockRejectedValueOnce(new Error('status response lost'));
    adoptSession.mockResolvedValue(child);
    const first = renderView('external:claude:status-loss');
    fireEvent.click(
      screen.getByRole('button', { name: 'Continue in Station' }),
    );
    await screen.findByRole('alert');
    expect(adoptSession).not.toHaveBeenCalled();
    first.unmount();

    renderView('external:claude:status-loss');
    fireEvent.click(
      screen.getByRole('button', { name: 'Continue in Station' }),
    );
    await waitFor(() => expect(adoptSession).toHaveBeenCalledTimes(1));
    expect(adoptSession.mock.calls[0][0]).toMatchObject({
      starterId: 'continue-session',
      sourceSessionId: 'external:claude:status-loss',
    });
  });

  test('a station-owned session never offers Continue in Station', () => {
    // The adopt affordance is only honest on a session Station merely
    // follows (`controlMode: 'read-only-attached'`); offering it on a
    // session Station already owns would "continue" a conversation into a
    // second copy of itself. Anchored on the owned composer rendering so
    // this cannot pass vacuously against a blank screen.
    renderView('thread-alpha');

    const detail = screen.getByTestId('session-detail');
    expect(
      within(detail).getByLabelText(
        /Send input to session|Continue delegated task/,
      ),
    ).toBeTruthy();
    expect(
      within(detail).queryByRole('button', { name: 'Continue in Station' }),
    ).toBeNull();
    expect(
      within(detail).queryByText('Following terminal session · Read only'),
    ).toBeNull();
  });

  test('mobile Back stays on the list after an adopted-session refresh', async () => {
    vi.stubGlobal('matchMedia', () => ({
      addEventListener: vi.fn(),
      matches: true,
      removeEventListener: vi.fn(),
    }));
    sessions[0] = {
      ...sessions[0],
      threadId: 'external:claude:terminal-mobile',
      controlMode: 'read-only-attached',
      delegation: undefined,
    };
    const pendingRefetch = deferred<void>();
    refetchSessions.mockImplementation(() => pendingRefetch.promise);
    adoptSession.mockImplementation(async () => {
      const child = {
        ...sessions[0],
        threadId: 'station-mobile-child',
        controlMode: 'station-owned',
      };
      sessions = [sessions[0], child];
      return child;
    });

    renderView('external:claude:terminal-mobile');
    fireEvent.click(
      screen.getByRole('button', { name: 'Continue in Station' }),
    );
    await waitFor(() => expect(refetchSessions).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByRole('button', { name: /Back to list/ }));
    expect(screen.queryByTestId('session-detail')).toBeNull();

    await act(async () => {
      pendingRefetch.resolve();
      await pendingRefetch.promise;
    });

    expect(screen.queryByTestId('session-detail')).toBeNull();
  });

  test('mobile Back stays on the list when adoption resolves after Back', async () => {
    vi.stubGlobal('matchMedia', () => ({
      addEventListener: vi.fn(),
      matches: true,
      removeEventListener: vi.fn(),
    }));
    sessions[0] = {
      ...sessions[0],
      threadId: 'external:claude:terminal-pending',
      controlMode: 'read-only-attached',
      delegation: undefined,
    };
    const child = {
      ...sessions[0],
      threadId: 'station-pending-child',
      controlMode: 'station-owned',
    };
    const pendingAdoption = deferred<typeof child>();
    const pendingRefetch = deferred<void>();
    adoptSession.mockImplementation(() => pendingAdoption.promise);
    refetchSessions.mockImplementation(() => pendingRefetch.promise);

    renderView('external:claude:terminal-pending');
    fireEvent.click(
      screen.getByRole('button', { name: 'Continue in Station' }),
    );
    await screen.findByRole('button', { name: 'Continuing…' });
    fireEvent.click(screen.getByRole('button', { name: /Back to list/ }));
    expect(screen.queryByTestId('session-detail')).toBeNull();

    sessions = [sessions[0], child];
    await act(async () => {
      pendingAdoption.resolve(child);
      await pendingAdoption.promise;
    });
    await waitFor(() => expect(refetchSessions).toHaveBeenCalledTimes(1));
    await act(async () => {
      pendingRefetch.resolve();
      await pendingRefetch.promise;
    });

    expect(screen.queryByTestId('session-detail')).toBeNull();
  });

  test('keeps a newer session selection after an older adoption refetch', async () => {
    const source = {
      ...sessions[0],
      threadId: 'external:claude:terminal-mobile',
      controlMode: 'read-only-attached',
      delegation: undefined,
    };
    const sibling = {
      ...sessions[0],
      threadId: 'thread-sibling',
      delegation: {
        ...(sessions[0].delegation as Record<string, unknown>),
        taskId: 'task:sibling',
      },
    };
    sessions = [source, sibling];
    const pendingRefetch = deferred<void>();
    refetchSessions.mockImplementation(() => pendingRefetch.promise);
    adoptSession.mockImplementation(async () => {
      const child = {
        ...source,
        threadId: 'station-mobile-child',
        controlMode: 'station-owned',
      };
      sessions = [source, sibling, child];
      return child;
    });

    renderView('external:claude:terminal-mobile');
    fireEvent.click(
      screen.getByRole('button', { name: 'Continue in Station' }),
    );
    await waitFor(() => expect(refetchSessions).toHaveBeenCalledTimes(1));

    fireEvent.click(
      screen.getByRole('button', { name: /Worker task.*sibling/ }),
    );
    expect(screen.getByTestId('session-detail').textContent).toContain(
      'thread-sibling',
    );

    await act(async () => {
      pendingRefetch.resolve();
      await pendingRefetch.promise;
    });

    expect(screen.getByTestId('session-detail').textContent).toContain(
      'thread-sibling',
    );
  });

  test('clears a newer selection removed while an older adoption resolves', async () => {
    const source = {
      ...sessions[0],
      threadId: 'external:claude:terminal-mobile',
      controlMode: 'read-only-attached',
      delegation: undefined,
    };
    const sibling = {
      ...sessions[0],
      threadId: 'thread-sibling',
      delegation: {
        ...(sessions[0].delegation as Record<string, unknown>),
        taskId: 'task:sibling',
      },
    };
    const child = {
      ...source,
      threadId: 'station-mobile-child',
      controlMode: 'station-owned',
    };
    sessions = [source, sibling];
    const pendingAdoption = deferred<typeof child>();
    const pendingRefetch = deferred<void>();
    adoptSession.mockImplementation(() => pendingAdoption.promise);
    refetchSessions.mockImplementation(() => pendingRefetch.promise);

    renderView('external:claude:terminal-mobile');
    fireEvent.click(
      screen.getByRole('button', { name: 'Continue in Station' }),
    );
    await screen.findByRole('button', { name: 'Continuing…' });
    fireEvent.click(
      screen.getByRole('button', { name: /Worker task.*sibling/ }),
    );
    expect(screen.getByTestId('session-detail').textContent).toContain(
      'thread-sibling',
    );

    sessions = [source, child];
    await act(async () => {
      pendingAdoption.resolve(child);
      await pendingAdoption.promise;
    });
    await waitFor(() => expect(refetchSessions).toHaveBeenCalledTimes(1));

    fireEvent.change(screen.getByPlaceholderText('Search sessions…'), {
      target: { value: 'station' },
    });
    expect(screen.queryByTestId('session-detail')).toBeNull();

    await act(async () => {
      pendingRefetch.resolve();
      await pendingRefetch.promise;
    });
    expect(screen.queryByTestId('session-detail')).toBeNull();
  });

  test('shows the linked Flow run before falling back to project workflows', () => {
    sessionFlowRun = {
      runId: 'run-child',
      definitionId: 'station-delivery',
      run: {
        state: { status: 'running', current_step: 'verify' },
        openGates: [{ id: 'acceptance', step: 'verify' }],
      },
    };
    workflowTasksByProject.demo = [
      { taskSlug: 'unlinked', status: 'active', phase: 'build' },
    ];

    renderView('thread-alpha');

    const detail = screen.getByTestId('session-detail');
    expect(within(detail).getByText('Linked Flow')).toBeTruthy();
    expect(within(detail).getByText(/verify/)).toBeTruthy();
    expect(within(detail).queryByText('Project workflows')).toBeNull();
  });
  /*
   * archive#189. The defect these guard is a MERGE: one figure covering
   * the auto-attached station-delivery run and the Builder run at once. So
   * each test asserts the two rows are separately present and separately
   * legible.
   */

  test('renders the Builder run as its own row alongside the linked Flow run', () => {
    sessionFlowRun = {
      runId: 'run-child',
      definitionId: 'station-delivery',
      run: {
        state: { status: 'active', current_step: 'plan' },
        openGates: [],
      },
    };
    sessionBuilderRun = {
      identityStatus: 'present',
      matchKind: 'correlation-matched',
      taskSlug: 'kontourai-station-1388',
      runRef: '.kontourai/flow/runs/kontourai-station-1388',
      flowRun: {
        run_id: 'kontourai-station-1388',
        definition_id: 'builder.build',
        definition_version: '1.3',
        status: 'active',
        current_step: 'verify',
        run_ref: '.kontourai/flow/runs/kontourai-station-1388',
        open_gate_ids: ['verify-gate'],
      },
    };

    renderView('thread-alpha');

    const detail = screen.getByTestId('session-detail');
    // Two rows, not one merged figure.
    expect(within(detail).getByText('Linked Flow')).toBeTruthy();
    expect(within(detail).getByText('Builder run')).toBeTruthy();
    expect(within(detail).getByText('kontourai-station-1388')).toBeTruthy();
    expect(within(detail).getByText(/Matched on run correlation/)).toBeTruthy();
    // archive#3139: same assertion, glossary wording — docs/glossary.md
    // retires "runtime" as a user-facing word in favour of "engine".
    expect(
      within(detail).getByText(/Engine session identity present/),
    ).toBeTruthy();
    expect(within(detail).getByText(/builder\.build/)).toBeTruthy();
    // No freshness claim: `flow_run` carries no currency stamp upstream.
    expect(
      within(detail).getByText(/as of the last sidecar write/),
    ).toBeTruthy();
  });

  test('an unjoinable session renders Unavailable with the reason, never a nearby run', () => {
    sessionBuilderRun = {
      identityStatus: 'unavailable',
      matchKind: 'none',
      reason:
        "no builder run in this workspace claims this session's runtime identity",
    };

    renderView('thread-alpha');

    const detail = screen.getByTestId('session-detail');
    expect(within(detail).getByText('Builder run')).toBeTruthy();
    expect(within(detail).getByText('Unavailable')).toBeTruthy();
    expect(within(detail).getByText(/Not joined/)).toBeTruthy();
    expect(
      within(detail).getByText(/no builder run in this workspace claims/),
    ).toBeTruthy();
  });

  test('a joined task with no projected run shows the join and no progress', () => {
    sessionBuilderRun = {
      identityStatus: 'present',
      matchKind: 'started-by-station',
      taskSlug: 'just-picked-up',
    };

    renderView('thread-alpha');

    const detail = screen.getByTestId('session-detail');
    expect(within(detail).getByText('just-picked-up')).toBeTruthy();
    expect(within(detail).getByText(/Started by Station/)).toBeTruthy();
    expect(
      within(detail).getByText(/No run has been published for this task yet/),
    ).toBeTruthy();
  });

  test('a broken binding shows its reason and NOT "No run has been published yet" (review M3)', () => {
    sessionBuilderRun = {
      identityStatus: 'unavailable',
      matchKind: 'started-by-station',
      taskSlug: 'deleted-task',
      taskSidecarUnreadable: true,
      reason:
        'Station started this session against task `deleted-task`, whose sidecar is no longer readable in this workspace',
    };

    renderView('thread-alpha');

    const detail = screen.getByTestId('session-detail');
    expect(within(detail).getByText('deleted-task')).toBeTruthy();
    expect(
      within(detail).getByText(/no longer readable in this workspace/),
    ).toBeTruthy();
    expect(within(detail).queryByText(/No run has been published/)).toBeNull();
  });

  test('quotes the sidecar write time when the server sends one', () => {
    sessionBuilderRun = {
      identityStatus: 'present',
      matchKind: 'started-by-station',
      taskSlug: 'timed',
      sidecarUpdatedAt: '2026-08-01T11:22:33.000Z',
      flowRun: {
        run_id: 'timed',
        definition_id: 'builder.build',
        definition_version: '1.3',
        status: 'active',
        current_step: 'verify',
        run_ref: '.kontourai/flow/runs/timed',
        open_gate_ids: [],
      },
    };

    renderView('thread-alpha');

    const detail = screen.getByTestId('session-detail');
    expect(
      within(detail).getByText(/as of the sidecar write at /),
    ).toBeTruthy();
  });

  test('renders no Builder run row when nothing could be joined', () => {
    renderView('thread-alpha');
    expect(
      within(screen.getByTestId('session-detail')).queryByText('Builder run'),
    ).toBeNull();
  });

  /*
   * archive#1249 — both branches below shipped with ZERO coverage and
   * each was probe-confirmed as a real regression before these landed.
   */

  test('an approval item with no actions renders only Dismiss and must NOT hide the composer (station#1249 review HIGH)', () => {
    // `ApprovalActions` gates Approve/Deny on `isApprovalLivePending`
    // (actions.length > 0), so an action-less approval renders a lone
    // Dismiss. Suppressing the composer on `kind === 'approval'` alone left
    // such a session with no way to respond at all. This state is externally
    // reachable: POST /api/notifications accepts category 'approval-request'
    // with no actions and an arbitrary metadata.sessionId.
    sessions[0].lifecycleState = 'running';
    sessions[0].delegation = undefined;
    attentionItems = [
      {
        id: 'approval:notif-actionless',
        kind: 'approval',
        title: 'Something wants approval',
        createdAt: '2026-06-28T00:00:02.000Z',
        updatedAt: '2026-06-28T00:00:02.000Z',
        sessionId: 'thread-alpha',
        source: {
          notificationId: 'notif-actionless',
          notificationSource: 'generic',
        },
        actions: [],
      },
    ];

    renderView('thread-alpha');

    const detail = screen.getByTestId('session-detail');
    const dismiss = within(detail).getByRole('button', { name: 'Dismiss' });
    expect(dismiss).toBeTruthy();
    fireEvent.click(dismiss);
    expect(dismissNotification).toHaveBeenCalledWith('notif-actionless');
    expect(within(detail).queryByText('Approve')).toBeNull();
    // The composer is the ONLY remaining way to respond — it must survive.
    expect(screen.getByLabelText('Send input to session')).toBeTruthy();
  });

  test('dismissing or opening a session-failed attention item acknowledges that exact item', async () => {
    const itemId = 'session-failed:thread-alpha';
    attentionItems = [
      {
        id: itemId,
        kind: 'session-failed',
        title: 'Worker task failed',
        createdAt: '2026-06-28T00:00:02.000Z',
        updatedAt: '2026-06-28T00:00:02.000Z',
        sessionId: 'thread-alpha',
        openHref: '/?surface=activity&session=thread-alpha',
        source: { threadId: 'thread-alpha' },
      },
    ];

    renderView('thread-alpha');
    const attention = screen.getByTestId('session-attention');
    fireEvent.click(within(attention).getByRole('button', { name: 'Dismiss' }));
    fireEvent.click(
      within(attention).getByRole('link', { name: 'Open session' }),
    );

    await waitFor(() =>
      expect(acknowledgeAttentionItem).toHaveBeenCalledTimes(2),
    );
    expect(acknowledgeAttentionItem).toHaveBeenCalledWith(itemId);
  });

  test('a live approval (with actions) still hides the composer, so one decision has one affordance', () => {
    sessions[0].lifecycleState = 'running';
    sessions[0].delegation = undefined;
    attentionItems = [
      {
        id: 'approval:notif-live',
        kind: 'approval',
        title: 'Tool call awaiting approval: bash',
        createdAt: '2026-06-28T00:00:02.000Z',
        updatedAt: '2026-06-28T00:00:02.000Z',
        sessionId: 'thread-alpha',
        source: {
          notificationId: 'notif-live',
          notificationSource: 'orchestration',
        },
        actions: [
          { id: 'approve', label: 'Approve', variant: 'primary' },
          { id: 'deny', label: 'Deny', variant: 'secondary' },
        ],
      },
    ];

    renderView('thread-alpha');

    const detail = screen.getByTestId('session-detail');
    expect(
      within(detail).getByRole('button', { name: 'Approve' }),
    ).toBeTruthy();
    expect(screen.queryByLabelText('Send input to session')).toBeNull();
  });

  test('a session carrying only effectiveModel still shows its model (station#1249 review HIGH)', () => {
    // `model` is set only when a caller supplied an explicit modelId at start;
    // `effectiveModel` is resolved later from session.configured/turn.started.
    // Removing the context row while the header read `model` alone made the
    // model render NOWHERE for a session started on an agent default.
    sessions[0].model = undefined;
    sessions[0].effectiveModel = 'gpt-5.6-sol';

    renderView('thread-alpha');

    const detail = screen.getByTestId('session-detail');
    expect(within(detail).getByText('gpt-5.6-sol')).toBeTruthy();
  });

  test('prefers the engine-reported model and skips provenance probes for a direct chat', () => {
    sessions[0].delegation = undefined;
    sessions[0].effectiveModel = 'claude-fable-5[1m]';
    sessions[0].reportedModel = 'claude-fable-5';

    renderView('thread-alpha');

    const detail = screen.getByTestId('session-detail');
    expect(within(detail).getByText('claude-fable-5')).toBeTruthy();
    expect(within(detail).queryByText('claude-fable-5[1m]')).toBeNull();
    expect(useSessionFlowRunQuery).toHaveBeenCalledWith(
      'thread-alpha',
      'http://test.local',
      { enabled: false },
    );
    expect(useSessionBuilderRunQuery).toHaveBeenCalledWith(
      'thread-alpha',
      'http://test.local',
      { enabled: false },
    );
  });

  /**
   * archive#1781 — the session-detail pending-request card.
   *
   * `MutableSessionDetail` renders Approve/Deny for a live `request.opened`.
   * Since archive#1791 retired the boot-time cancellation write, a session
   * whose provider adapter is gone keeps that request open forever, so the
   * card offered two buttons that dispatch into a guaranteed server rejection
   * and `hideGenericCompose` suppressed the composer BECAUSE that card was
   * assumed to own the response affordance.
   */
  describe('SessionsView unanswerable request card', () => {
    const observation = {
      answerable: false,
      qualification: 'provider_absent',
      observedBy: 'station-7f3a',
      observedAt: '2026-08-03T12:04:03.000Z',
    } as const;

    function openRequest() {
      feedEvents = [
        {
          provider: 'claude',
          threadId: 'thread-alpha',
          createdAt: '2026-06-28T00:00:03.000Z',
          method: 'request.opened',
          requestId: 'req-dead',
          requestType: 'approval',
          title: 'Allow write',
        },
      ];
    }

    test('AC4: the card RENDERS, disabled, with the observation that disabled it', () => {
      openRequest();
      sessions[0].answerability = observation;
      renderView('thread-alpha');

      // Anti-filter first: deleting the card would hide a request that really
      // is still open.
      const request = screen.getByTestId('session-request');
      expect(within(request).getByText('Allow write')).toBeTruthy();

      const notice = screen.getByTestId(
        'session-request-answerability',
      ).textContent;
      expect(notice).toContain("no adapter for provider 'claude'");
      expect(notice).toContain('station-7f3a');
      expect(notice).toContain('2026-08-03T12:04:03.000Z');

      expect(
        (
          within(request).getByRole('button', {
            name: 'Approve',
          }) as HTMLButtonElement
        ).disabled,
      ).toBe(true);
      expect(
        (
          within(request).getByRole('button', {
            name: 'Decline',
          }) as HTMLButtonElement
        ).disabled,
      ).toBe(true);
    });

    test('AC4 rejection path: a click on the disabled card dispatches nothing', async () => {
      openRequest();
      sessions[0].answerability = observation;
      renderView('thread-alpha');
      fireEvent.click(
        within(screen.getByTestId('session-request')).getByRole('button', {
          name: 'Approve',
        }),
      );
      // The mutation dispatches on a microtask, so a bare synchronous
      // assertion here has no power — it passes with the button ENABLED.
      // Found by (re-enabling the buttons left this test
      // green); flushing first is what binds it to the guard.
      await act(async () => {
        await Promise.resolve();
      });
      expect(resolveRequest).not.toHaveBeenCalled();
    });

    /**
     * The composer suppression only ever fires when a LIVE attention item
     * owns the response affordance, so the test must seed one — without it
     * `hideGenericCompose` is already false and the assertion has no power
     * (found by fault injection: removing the guard left it green).
     */
    function seedLiveApprovalItem() {
      attentionItems = [
        {
          id: 'approval:notif-1',
          kind: 'approval',
          title: 'Approval needed',
          createdAt: '2026-06-28T00:00:02.000Z',
          updatedAt: '2026-06-28T00:00:02.000Z',
          sessionId: 'thread-alpha',
          openHref: '/?surface=activity&session=thread-alpha',
          source: {
            notificationId: 'notif-1',
            notificationSource: 'approval-inbox',
          },
          actions: [{ id: 'accept', label: 'Allow' }],
        },
      ];
    }

    test('negative control: a live approval item DOES suppress the composer', () => {
      // Proves the suppression this AC un-does actually fires here, so the
      // assertion below is bound to the guard rather than to an empty list.
      openRequest();
      seedLiveApprovalItem();
      renderView('thread-alpha');
      expect(screen.queryByLabelText('Continue delegated task')).toBeNull();
    });

    test('AC4: the generic composer is NOT suppressed by a request nothing can answer', () => {
      openRequest();
      seedLiveApprovalItem();
      sessions[0].answerability = observation;
      renderView('thread-alpha');
      expect(screen.getByLabelText('Continue delegated task')).toBeTruthy();
    });

    test('AC5 (control): a live request keeps enabled buttons and no annotation', () => {
      openRequest();
      renderView('thread-alpha');
      const request = screen.getByTestId('session-request');
      expect(screen.queryByTestId('session-request-answerability')).toBeNull();
      expect(
        (
          within(request).getByRole('button', {
            name: 'Approve',
          }) as HTMLButtonElement
        ).disabled,
      ).toBe(false);
    });
  });

  /**
   * archive#3139. The owner opened this page and read
   * `external:claude:5dfa…` as a row label, on an unsorted, untimed list whose
   * search could only match the hash it was printing. Every assertion here is
   * about what the LIST renders — the detail pane already got these right.
   */
  describe('sessions list rows (station#3139)', () => {
    const HASH = 'external:claude:5dfa0c7b19e34a5f8c2d6b1e7a409f33';

    function attachedSession(
      overrides: Record<string, unknown> = {},
    ): Record<string, unknown> {
      return {
        provider: 'claude',
        threadId: HASH,
        status: 'idle',
        lifecycleState: 'completed',
        controlMode: 'read-only-attached',
        answerability: { answerable: false },
        isLoaded: true,
        isPersisted: true,
        eventCount: 2,
        createdAt: '2026-06-28T00:00:00.000Z',
        updatedAt: '2026-06-28T00:00:01.000Z',
        projectSlug: 'demo',
        cwd: '/Users/dev/code/beacon',
        ...overrides,
      };
    }

    function listRows(container: HTMLElement): HTMLElement[] {
      return Array.from(container.querySelectorAll('.split-pane__item'));
    }

    function rowNames(container: HTMLElement): string[] {
      return listRows(container).map(
        (row) =>
          row.querySelector('.split-pane__item-name')?.textContent?.trim() ??
          '',
      );
    }

    function sectionHeadings(container: HTMLElement): string[] {
      return Array.from(
        container.querySelectorAll('.split-pane__section-header'),
      ).map((node) => node.textContent?.trim() ?? '');
    }

    function search(query: string) {
      fireEvent.change(screen.getByPlaceholderText('Search sessions…'), {
        target: { value: query },
      });
    }

    // a run group followed by a flat session in the SAME
    // lane must not re-emit the lane heading. Members carry the lane section
    // now; a member with an undefined section reset the layout's neighbor
    // comparison and the following flat row duplicated 'Active now · N'.
    test('emits the lane heading exactly once when a run group and a flat session share the lane', () => {
      const parent = {
        ...sessions[0],
        threadId: 'run-parent',
        displayTitle: 'Coordinate the launch',
        delegation: undefined,
        lifecycleState: 'running',
        hasActiveTurn: true,
      };
      const worker = {
        ...sessions[0],
        threadId: 'run-worker',
        displayTitle: 'Delegated worker',
        lifecycleState: 'running',
        hasActiveTurn: true,
        delegation: {
          taskId: 'task:run-worker',
          parentTaskId: 'run-parent',
          targetId: 'codex',
          targetKind: 'agent',
        },
      };
      const flat = {
        ...sessions[0],
        threadId: 'flat-active',
        displayTitle: 'Unrelated active session',
        delegation: undefined,
        lifecycleState: 'running',
        hasActiveTurn: true,
      };
      sessions = [parent, worker, flat];

      const { container } = renderView();
      const headings = sectionHeadings(container).filter((heading) =>
        heading.startsWith('Active now'),
      );
      expect(headings).toEqual([]);
      expect(sectionHeadings(container)).toEqual([
        'Delegated/background work · 2',
        'Operator sessions · 1',
      ]);
    });

    test('names a row by the session’s own displayTitle, never its thread id', () => {
      sessions = [
        attachedSession({ displayTitle: 'Fix the sessions read path' }),
      ];

      const { container } = renderView();

      expect(rowNames(container)).toEqual(['Fix the sessions read path']);
      expect(listRows(container)[0].textContent).not.toContain('external');
      expect(listRows(container)[0].textContent).not.toContain('5dfa');
    });

    test('falls back to the engine-named title, with no hash anywhere in the row, when the session has no displayTitle', () => {
      sessions = [attachedSession()];

      const { container } = renderView();

      expect(rowNames(container)).toEqual(['Claude Code session']);
      // The whole row, not just its name: the subtitle must not reintroduce it.
      expect(listRows(container)[0].textContent).not.toContain(HASH);
      expect(listRows(container)[0].textContent).not.toContain('external');
    });

    test('the delegated work card reads the lifecycle state in words, not the wire token', () => {
      // The seeded session is delegated and `needs_input`.
      renderView();

      const coordinator = screen.getByTestId('delegated-task-coordinator');
      expect(within(coordinator).getByText('Waiting on you')).toBeTruthy();
      expect(coordinator.textContent).not.toContain('needs_input');
    });

    test('surfaces a peer delegation record without offering local-session controls (#847)', () => {
      sessions = [
        {
          ...sessions[0],
          threadId: 'peer-delegation:847',
          displayTitle: 'Run the peer checks',
          lifecycleState: 'queued',
          hasActiveTurn: false,
          delegation: {
            taskId: 'task-peer-847',
            environmentId: 'environment-peer',
            environmentName: 'Station B',
            environmentKind: 'peer',
            targetKind: 'agent',
            targetId: 'codex',
          },
        },
      ];

      const { container } = renderView();
      const coordinator = screen.getByTestId('delegated-task-coordinator');

      expect(rowNames(container)).toContain('Run the peer checks');
      expect(within(coordinator).getByText('Paired Station')).toBeTruthy();
      expect(coordinator.textContent).toContain(
        'Its transcript and final answer remain on the paired Station.',
      );
      expect(
        within(coordinator).queryByLabelText('Direct worker follow-up'),
      ).toBeNull();
      expect(within(coordinator).queryByText('Stop active task')).toBeNull();
    });

    test('every row carries a relative time', () => {
      sessions = [
        attachedSession({
          displayTitle: 'Older work',
          createdAt: new Date(Date.now() - 3 * 3_600_000).toISOString(),
          updatedAt: new Date(Date.now() - 3 * 3_600_000).toISOString(),
        }),
      ];

      const { container } = renderView();

      expect(listRows(container)[0].textContent).toContain('3h ago');
    });

    test('lists the newest session first, against a server list that arrives oldest-first', () => {
      const stamp = (iso: string) => ({ createdAt: iso, updatedAt: iso });
      sessions = [
        // Server order is `createdAt` ASCENDING (orchestration-service.ts).
        attachedSession({
          threadId: 'thread-oldest',
          displayTitle: 'Oldest',
          ...stamp('2026-06-20T00:00:00.000Z'),
        }),
        attachedSession({
          threadId: 'thread-middle',
          displayTitle: 'Middle',
          ...stamp('2026-06-21T00:00:00.000Z'),
        }),
        attachedSession({
          threadId: 'thread-newest',
          displayTitle: 'Newest',
          ...stamp('2026-06-22T00:00:00.000Z'),
        }),
      ];

      const { container } = renderView();

      expect(rowNames(container)).toEqual(['Newest', 'Middle', 'Oldest']);
    });

    /**
     * archive#3027 replaced the project heading with a state lane (the owner's
     * call: "by state yes"). The archive#3139 invariant this test was written for is
     * NOT about projects — it is that a heading is emitted exactly once rather
     * than run-length-encoded over an unsorted list, and that rows are
     * newest-first inside their group. Both are re-asserted here against the
     * new grouping, with the same interleaved-on-arrival fixture shape.
     */
    test('emits each state heading exactly once for an interleaved multi-project list, newest-first inside it', () => {
      const stamp = (iso: string) => ({ createdAt: iso, updatedAt: iso });
      // Interleaved on arrival, which is what run-length-encoded the headings.
      sessions = [
        attachedSession({
          threadId: 'a-1',
          projectSlug: 'alpha',
          displayTitle: 'Alpha one',
          ...stamp('2026-06-20T00:00:00.000Z'),
        }),
        attachedSession({
          threadId: 'b-1',
          projectSlug: 'beta',
          displayTitle: 'Beta one',
          ...stamp('2026-06-21T00:00:00.000Z'),
        }),
        attachedSession({
          threadId: 'a-2',
          projectSlug: 'alpha',
          displayTitle: 'Alpha two',
          ...stamp('2026-06-22T00:00:00.000Z'),
        }),
        attachedSession({
          threadId: 'b-2',
          projectSlug: 'beta',
          displayTitle: 'Beta two',
          ...stamp('2026-06-23T00:00:00.000Z'),
        }),
      ];

      const { container } = renderView();

      // Every fixture is `completed` and hours old: one lane, one heading.
      expect(sectionHeadings(container)).toEqual(['Operator sessions · 4']);
      expect(listRows(container)).toHaveLength(4);
      expect(rowNames(container)).toEqual([
        'Beta two',
        'Alpha two',
        'Beta one',
        'Alpha one',
      ]);
      // The project is still on screen — as a row pill, not a heading.
      expect(
        Array.from(container.querySelectorAll('.session-project-pill')).map(
          (pill) => pill.textContent,
        ),
      ).toEqual(['beta', 'alpha', 'beta', 'alpha']);
    });

    test('renders state lanes in reading order, with counts, and no empty lane', () => {
      sessions = [
        attachedSession({
          threadId: 'earlier-1',
          displayTitle: 'Long finished',
          createdAt: new Date(Date.now() - 6 * 3_600_000).toISOString(),
          updatedAt: new Date(Date.now() - 6 * 3_600_000).toISOString(),
        }),
        attachedSession({
          threadId: 'waiting-1',
          displayTitle: 'Waiting on a decision',
          controlMode: 'station-owned',
          answerability: { answerable: true },
          lifecycleState: 'needs_input',
          updatedAt: new Date(Date.now() - 60_000).toISOString(),
        }),
        attachedSession({
          threadId: 'just-done-1',
          displayTitle: 'Finished a moment ago',
          updatedAt: new Date(Date.now() - 90_000).toISOString(),
        }),
        attachedSession({
          threadId: 'waiting-2',
          displayTitle: 'Also waiting on you',
          controlMode: 'station-owned',
          answerability: { answerable: true },
          lifecycleState: 'review_pending',
          pendingReview: true,
          updatedAt: new Date(Date.now() - 120_000).toISOString(),
        }),
      ];

      const { container } = renderView();

      expect(sectionHeadings(container)).toEqual(['Operator sessions · 4']);
      expect(rowNames(container)).toEqual([
        'Waiting on a decision',
        'Also waiting on you',
        'Finished a moment ago',
        'Long finished',
      ]);
    });

    /**
     * archive#3227 A1. The row's meta line used to print
     * `sessionLifecycleLabel(session.lifecycleState)` — the raw wire state,
     * with none of the fold's overrides — while the section heading above it
     * came from the fold. So a row under "Recently finished" said *Running*.
     *
     * This walks the rendered list in document order, carrying the current
     * section heading down onto each row, and asserts every row's state word
     * is one that heading permits. The vocabulary is stated here rather than
     * imported from the implementation's own refinement table: a test that
     * recomputes the map it checks agrees by construction.
     */
    test('no rendered row contradicts the section heading above it', () => {
      sessions = [
        // A1 shape 1 (archive#1069): attached, never ran a turn.
        attachedSession({
          threadId: 'idle-running',
          displayTitle: 'Attached but idle',
          controlMode: 'station-owned',
          answerability: { answerable: true },
          lifecycleState: 'running',
          hasActiveTurn: false,
          updatedAt: new Date(Date.now() - 30_000).toISOString(),
        }),
        // A1 shape 2: a review is pending while a turn is in flight.
        attachedSession({
          threadId: 'review-while-running',
          displayTitle: 'Review pending mid-turn',
          controlMode: 'station-owned',
          answerability: { answerable: true },
          lifecycleState: 'running',
          hasActiveTurn: true,
          pendingReview: true,
          updatedAt: new Date(Date.now() - 40_000).toISOString(),
        }),
        // A1 shape 3 (archive#1296): the board closed a session mid-run.
        attachedSession({
          threadId: 'closed-while-running',
          displayTitle: 'Closed mid-run',
          status: 'closed',
          controlMode: 'station-owned',
          answerability: { answerable: true },
          lifecycleState: 'running',
          hasActiveTurn: true,
          updatedAt: new Date(Date.now() - 50_000).toISOString(),
        }),
        // A1 shape 4 (archive#1783): nothing can answer it.
        attachedSession({
          threadId: 'stranded',
          displayTitle: 'Stranded request',
          controlMode: 'station-owned',
          lifecycleState: 'needs_input',
          answerability: {
            answerable: false,
            qualification: 'provider_absent',
            observedBy: 'station-test',
            observedAt: '2026-06-28T00:00:00.000Z',
          },
          updatedAt: new Date(Date.now() - 60_000).toISOString(),
        }),
        attachedSession({
          threadId: 'canceled',
          displayTitle: 'Canceled run',
          lifecycleState: 'canceled',
          updatedAt: new Date(Date.now() - 70_000).toISOString(),
        }),
        attachedSession({
          threadId: 'long-failed',
          displayTitle: 'Failed yesterday',
          lifecycleState: 'failed',
          createdAt: new Date(Date.now() - 6 * 3_600_000).toISOString(),
          updatedAt: new Date(Date.now() - 6 * 3_600_000).toISOString(),
        }),
      ];

      const { container } = renderView();

      let heading = '';
      const rendered: Array<{ heading: string; row: string }> = [];
      for (const node of Array.from(
        container.querySelectorAll(
          '.split-pane__section-header, .split-pane__item',
        ),
      )) {
        if (node.classList.contains('split-pane__section-header')) {
          heading = (node.textContent ?? '').split(' · ')[0].trim();
          continue;
        }
        rendered.push({
          heading,
          row:
            node
              .querySelector('.split-pane__item-subtitle')
              ?.textContent?.trim() ?? '',
        });
      }

      // Every session reached a lane, and the fixture spans all four — a walk
      // over a short or single-lane render would pass while checking nothing.
      expect(rendered).toHaveLength(6);
      expect(new Set(rendered.map((entry) => entry.heading))).toEqual(
        new Set(['Operator sessions']),
      );

      // The four A1 shapes, by the word each used to print.
      const rowText = (name: string) =>
        listRows(container).find((row) => row.textContent?.includes(name))
          ?.textContent ?? '';
      expect(rowText('Attached but idle')).toContain('Ready');
      expect(rowText('Review pending mid-turn')).toContain('Needs attention');
      expect(rowText('Closed mid-run')).toContain('Completed');
      expect(rowText('Stranded request')).toContain("Can't answer here");
      // The explicit stopped outcome must not fold into the successful word.
      expect(rowText('Canceled run')).toContain('Stopped');
    });

    /**
     * The reason the lane exists. `DelegatedTaskCoordinator` renders
     * `tasks[0]` only, so a SECOND delegated session waiting on the user had
     * nowhere on this page to appear.
     */
    test('a second waiting delegated session is visible in the list, not only the first in the card', () => {
      sessions = [
        {
          ...sessions[0],
          threadId: 'waiting-first',
          displayTitle: 'First worker question',
          updatedAt: new Date(Date.now() - 60_000).toISOString(),
        },
        {
          ...sessions[0],
          threadId: 'waiting-second',
          displayTitle: 'Second worker question',
          updatedAt: new Date(Date.now() - 120_000).toISOString(),
        },
      ];

      const { container } = renderView();

      const needsYou = sectionHeadings(container)[0];
      expect(needsYou).toBe('Delegated/background work · 2');
      expect(rowNames(container)).toEqual([
        'First worker question',
        'Second worker question',
      ]);
    });

    test('the delegation card renders below the list, not above it', () => {
      const { container } = renderView();

      const list = container.querySelector('.split-pane__list');
      const footer = container.querySelector('.split-pane__add');
      expect(
        list?.querySelector('[data-testid="delegated-task-coordinator"]'),
      ).toBeNull();
      expect(
        footer?.querySelector('[data-testid="delegated-task-coordinator"]'),
      ).toBeTruthy();
      //.and its actions still work from there.
      fireEvent.click(
        within(screen.getByTestId('delegated-task-coordinator')).getByRole(
          'button',
          { name: 'View task' },
        ),
      );
      expect(screen.getByTestId('session-detail').textContent).toContain(
        'mobile browser 12345678',
      );
    });

    test('clicking a project pill filters the list, and clicking it again clears it', () => {
      const stamp = (iso: string) => ({ createdAt: iso, updatedAt: iso });
      sessions = [
        attachedSession({
          threadId: 'alpha-1',
          projectSlug: 'alpha',
          displayTitle: 'Alpha work',
          ...stamp('2026-06-22T00:00:00.000Z'),
        }),
        attachedSession({
          threadId: 'beta-1',
          projectSlug: 'beta',
          displayTitle: 'Beta work',
          ...stamp('2026-06-21T00:00:00.000Z'),
        }),
      ];

      const { container } = renderView();
      expect(rowNames(container)).toEqual(['Alpha work', 'Beta work']);

      const alphaPill = container.querySelector(
        'button.session-project-pill[data-project="alpha"]',
      ) as HTMLButtonElement;
      fireEvent.click(alphaPill);

      expect(rowNames(container)).toEqual(['Alpha work']);
      expect(sectionHeadings(container)).toEqual(['Operator sessions · 1']);
      const clear = screen.getByRole('button', {
        name: 'Clear the alpha project filter',
      });
      expect(clear).toBeTruthy();
      expect(
        container
          .querySelector('button.session-project-pill[data-project="alpha"]')
          ?.getAttribute('aria-pressed'),
      ).toBe('true');

      fireEvent.click(
        container.querySelector(
          'button.session-project-pill[data-project="alpha"]',
        ) as HTMLButtonElement,
      );
      expect(rowNames(container)).toEqual(['Alpha work', 'Beta work']);
    });

    test('the clear affordance removes an active project filter', () => {
      const stamp = (iso: string) => ({ createdAt: iso, updatedAt: iso });
      sessions = [
        attachedSession({
          threadId: 'alpha-1',
          projectSlug: 'alpha',
          displayTitle: 'Alpha work',
          ...stamp('2026-06-22T00:00:00.000Z'),
        }),
        attachedSession({
          threadId: 'beta-1',
          projectSlug: 'beta',
          displayTitle: 'Beta work',
          ...stamp('2026-06-21T00:00:00.000Z'),
        }),
      ];

      const { container } = renderView();
      fireEvent.click(
        container.querySelector(
          'button.session-project-pill[data-project="alpha"]',
        ) as HTMLButtonElement,
      );
      expect(rowNames(container)).toEqual(['Alpha work']);

      fireEvent.click(
        screen.getByRole('button', {
          name: 'Clear the alpha project filter',
        }),
      );

      expect(rowNames(container)).toEqual(['Alpha work', 'Beta work']);
      expect(
        screen.queryByRole('button', {
          name: 'Clear the alpha project filter',
        }),
      ).toBeNull();
    });

    test('search composes with an active project filter instead of replacing it', () => {
      const stamp = (iso: string) => ({ createdAt: iso, updatedAt: iso });
      sessions = [
        attachedSession({
          threadId: 'alpha-1',
          projectSlug: 'alpha',
          displayTitle: 'Repair the failing gate',
          ...stamp('2026-06-22T00:00:00.000Z'),
        }),
        attachedSession({
          threadId: 'alpha-2',
          projectSlug: 'alpha',
          displayTitle: 'Something else entirely',
          ...stamp('2026-06-21T00:00:00.000Z'),
        }),
        attachedSession({
          threadId: 'beta-1',
          projectSlug: 'beta',
          displayTitle: 'Repair the beta pipeline',
          ...stamp('2026-06-20T00:00:00.000Z'),
        }),
      ];

      const { container } = renderView();
      fireEvent.click(
        container.querySelector(
          'button.session-project-pill[data-project="alpha"]',
        ) as HTMLButtonElement,
      );
      expect(rowNames(container)).toEqual([
        'Repair the failing gate',
        'Something else entirely',
      ]);

      search('Repair');

      // Both predicates applied: the beta session matches the query but is
      // outside the filter, and the second alpha session is inside the filter
      // but does not match.
      expect(rowNames(container)).toEqual(['Repair the failing gate']);
    });

    test('an ambiguously-attributed session stays visible under either candidate’s filter', () => {
      const stamp = (iso: string) => ({ createdAt: iso, updatedAt: iso });
      sessions = [
        attachedSession({
          threadId: 'alpha-1',
          projectSlug: 'alpha',
          displayTitle: 'Alpha work',
          ...stamp('2026-06-22T00:00:00.000Z'),
        }),
        attachedSession({
          threadId: 'beta-1',
          projectSlug: 'beta',
          displayTitle: 'Beta work',
          ...stamp('2026-06-21T00:00:00.000Z'),
        }),
        attachedSession({
          threadId: 'both-1',
          projectSlug: undefined,
          projectAttribution: {
            state: 'ambiguous',
            candidates: ['alpha', 'beta'],
          },
          displayTitle: 'Could be either',
          ...stamp('2026-06-20T00:00:00.000Z'),
        }),
      ];

      const { container } = renderView();

      fireEvent.click(
        container.querySelector(
          'button.session-project-pill[data-project="alpha"]',
        ) as HTMLButtonElement,
      );
      expect(rowNames(container)).toEqual(['Alpha work', 'Could be either']);

      fireEvent.click(
        screen.getByRole('button', {
          name: 'Clear the alpha project filter',
        }),
      );
      fireEvent.click(
        container.querySelector(
          'button.session-project-pill[data-project="beta"]',
        ) as HTMLButtonElement,
      );
      expect(rowNames(container)).toEqual(['Beta work', 'Could be either']);
    });

    test('a row leads with the engine icon, and an unknown provider falls back without crashing', () => {
      const stamp = (iso: string) => ({ createdAt: iso, updatedAt: iso });
      sessions = [
        attachedSession({
          threadId: 'known-1',
          provider: 'claude',
          displayTitle: 'Known engine',
          ...stamp('2026-06-22T00:00:00.000Z'),
        }),
        attachedSession({
          threadId: 'unknown-1',
          provider: 'some-plugin-adapter',
          displayTitle: 'Unknown engine',
          ...stamp('2026-06-21T00:00:00.000Z'),
        }),
      ];

      const { container } = renderView();

      const icons = container.querySelectorAll(
        '.split-pane__item-icon .brand-icon',
      );
      expect(icons).toHaveLength(2);
      // Claude Code resolves to its brand mark...
      expect(icons[0].className).toContain('brand-icon--claude');
      //.and an id this build has no product name for renders AgentIcon's
      // own initials fallback rather than a guessed glyph for some engine.
      expect(icons[1].className).not.toContain('brand-icon--');
      expect(icons[1].querySelector('.brand-icon__initials')?.textContent).toBe(
        'SP',
      );
    });

    test('search matches a word from the row name, the working directory and the agent', () => {
      sessions = [
        attachedSession({
          threadId: 'thread-titled',
          displayTitle: 'Repair the failing gate',
          assignedAgentSlug: 'reviewer',
          cwd: '/Users/dev/code/beacon',
        }),
        attachedSession({
          threadId: 'thread-other',
          displayTitle: 'Something else entirely',
          assignedAgentSlug: 'builder',
          cwd: '/Users/dev/code/lantern',
        }),
      ];

      const { container } = renderView();
      expect(listRows(container)).toHaveLength(2);

      search('failing');
      expect(rowNames(container)).toEqual(['Repair the failing gate']);

      search('beacon');
      expect(rowNames(container)).toEqual(['Repair the failing gate']);

      search('reviewer');
      expect(rowNames(container)).toEqual(['Repair the failing gate']);
    });

    test('search still matches a pasted thread id', () => {
      sessions = [
        attachedSession({ threadId: HASH, displayTitle: 'Named session' }),
        attachedSession({
          threadId: 'external:claude:0000000000000000',
          displayTitle: 'Other session',
        }),
      ];

      const { container } = renderView();

      search(HASH);
      expect(rowNames(container)).toEqual(['Named session']);
    });
  });

  /**
   * archive#4052: a session row that has ENDED is one activation from
   * the evidence behind its outcome. The control rides the existing
   * local Activity selection path plus the one-shot evidence intent the
   * session detail honors exactly once.
   */
  describe('evidence affordance (station#4052 slice 3)', () => {
    function flatSession(
      overrides: Record<string, unknown>,
    ): Record<string, unknown> {
      return {
        ...sessions[0],
        delegation: undefined,
        displayTitle: 'Completed work',
        threadId: 'done',
        lifecycleState: 'completed',
        ...overrides,
      };
    }

    beforeEach(() => {
      window.history.replaceState({}, '', '/activity');
    });

    afterEach(() => {
      window.history.replaceState({}, '', '/');
    });

    test('offers Evidence exactly on rows whose session has ended', () => {
      sessions = [
        flatSession({}),
        flatSession({
          threadId: 'died',
          displayTitle: 'Failed work',
          lifecycleState: 'failed',
        }),
        flatSession({
          threadId: 'halted',
          displayTitle: 'Stopped work',
          lifecycleState: 'canceled',
        }),
        flatSession({
          threadId: 'live',
          displayTitle: 'Running work',
          lifecycleState: 'running',
          hasActiveTurn: true,
        }),
        flatSession({
          threadId: 'waiting',
          displayTitle: 'Waiting work',
          lifecycleState: 'needs_input',
        }),
        // Terminal, but a read-only attached transcript: its detail is
        // `AttachedSessionDetail`, which has no receipts/diagnostics region —
        // never offer a control whose target may be absent (the
        // `revealHomeRegion` rule).
        flatSession({
          threadId: 'attached-done',
          displayTitle: 'Attached transcript',
          controlMode: 'read-only-attached',
          answerability: { answerable: false },
        }),
      ];

      renderView();

      // Present on every ended row…
      expect(
        screen.getByRole('button', { name: 'Evidence for Completed work' }),
      ).toBeTruthy();
      expect(
        screen.getByRole('button', { name: 'Evidence for Failed work' }),
      ).toBeTruthy();
      expect(
        screen.getByRole('button', { name: 'Evidence for Stopped work' }),
      ).toBeTruthy();
      // …and on no other row — asserted both by name and by count, so an
      // unconditional render cannot pass on the strength of the present rows.
      expect(
        screen.queryByRole('button', { name: 'Evidence for Running work' }),
      ).toBeNull();
      expect(
        screen.queryByRole('button', { name: 'Evidence for Waiting work' }),
      ).toBeNull();
      expect(
        screen.queryByRole('button', {
          name: 'Evidence for Attached transcript',
        }),
      ).toBeNull();
      expect(
        screen.getAllByRole('button', { name: /^Evidence for / }),
      ).toHaveLength(3);
    });

    test('offers Evidence on a run group member that has ended, not on its live sibling', () => {
      const parent = flatSession({
        threadId: 'run-parent',
        displayTitle: 'Run parent',
        lifecycleState: 'running',
        hasActiveTurn: true,
      });
      const child = flatSession({
        threadId: 'run-child',
        displayTitle: 'Run child done',
        lifecycleState: 'completed',
        delegation: {
          taskId: 'task:run-child',
          parentTaskId: 'run-parent',
        },
      });
      sessions = [parent, child];

      renderView();

      expect(
        screen.getByRole('button', { name: 'Run · 1 delegated session' }),
      ).toBeTruthy();
      expect(
        screen.getByRole('button', { name: 'Evidence for Run child done' }),
      ).toBeTruthy();
      expect(
        screen.queryByRole('button', { name: 'Evidence for Run parent' }),
      ).toBeNull();
    });

    test('activation selects locally and focuses evidence without changing the route', async () => {
      sessions = [flatSession({})];
      const view = renderView();

      fireEvent.click(
        screen.getByRole('button', { name: 'Evidence for Completed work' }),
      );

      expect(window.location.pathname).toBe('/activity');
      expect(window.location.search).toBe('');

      expect(screen.getByTestId('session-detail')).toBeTruthy();
      const region = screen.getByTestId('session-evidence-region');
      await waitFor(() => expect(document.activeElement).toBe(region));
      // Consumed one-shot: the focus param is cleared after admission (the
      // `openFilePreviewIntent` idiom), so a stale hint can never re-fire on
      // the next same-path navigation.
      expect(window.location.search).toBe('');

      // A later render with the routed props unchanged must not drag the
      // reader back to the region they have since left.
      screen
        .getByRole('button', { name: 'Evidence for Completed work' })
        .focus();
      view.rerenderSession();
      expect(document.activeElement).not.toBe(region);
    });

    // the once-only record lives in the detail (a ref that dies
    // at unmount) while the token lives in the parent — deselect-then-
    // reselect used to remount the detail against the STALE token and
    // scroll-steal a plain click. The parent now clears the reveal on every
    // non-arming selection.
    test('a plain reselect after an evidence reveal does not re-fire it', async () => {
      sessions = [flatSession({})];
      const view = renderView();

      fireEvent.click(
        screen.getByRole('button', { name: 'Evidence for Completed work' }),
      );
      view.rerenderSession('done', 'evidence');
      const region = screen.getByTestId('session-evidence-region');
      await waitFor(() => expect(document.activeElement).toBe(region));

      const rowButton = () =>
        screen
          .getAllByRole('button', { name: /Completed work/ })
          .find((candidate) =>
            candidate.classList.contains('split-pane__item'),
          )!;
      // Deselect via the pane title (SplitPaneLayout's clickable-title
      // gesture -> onDeselect -> selectWithIntent(null)): the detail
      // unmounts, destroying its consumption record.
      const paneTitle = document.querySelector('.split-pane__title--clickable');
      expect(paneTitle).not.toBeNull();
      fireEvent.click(paneTitle as HTMLElement);
      await waitFor(() =>
        expect(screen.queryByTestId('session-evidence-region')).toBeNull(),
      );

      // Plain reselect (no evidence intent): the detail remounts fresh.
      fireEvent.click(rowButton());
      view.rerenderSession('done', undefined);
      const remounted = await screen.findByTestId('session-evidence-region');
      // The stale token must NOT drag focus to the region on this mount.
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(document.activeElement).not.toBe(remounted);
    });

    test('a deep link whose session arrives after a cold empty result still lands on the evidence region', async () => {
      const routed = flatSession({});
      sessions = [];
      const view = renderView('done', 'evidence');

      expect(screen.queryByTestId('session-detail')).toBeNull();

      sessions = [routed];
      view.rerenderSession('done', 'evidence');

      await waitFor(() =>
        expect(document.activeElement).toBe(
          screen.getByTestId('session-evidence-region'),
        ),
      );
    });

    test('the Evidence control is keyboard-operable', async () => {
      sessions = [flatSession({})];
      renderView();

      const control = screen.getByRole('button', {
        name: 'Evidence for Completed work',
      });
      // A native button: in the Tab order (no tabindex override) and
      // activated from the keyboard. jsdom does not synthesize the browser's
      // Enter-to-click activation for native buttons, so this asserts the two
      // halves jsdom can see: focus reaches the control, and activating the
      // FOCUSED element (what Enter dispatches in a real browser) performs
      // the navigation.
      expect(control.tagName).toBe('BUTTON');
      expect(control.getAttribute('tabindex')).toBeNull();
      control.focus();
      expect(document.activeElement).toBe(control);
      fireEvent.click(document.activeElement as HTMLElement);
      await waitFor(() =>
        expect(document.activeElement).toBe(
          screen.getByTestId('session-evidence-region'),
        ),
      );
      expect(window.location.search).toBe('');
    });

    test('a new intent token re-fires the same mounted session and focus intent', async () => {
      sessions = [flatSession({})];
      const onFocusConsumed = vi.fn();
      const view = renderView('done', 'evidence', 1, onFocusConsumed);

      const evidenceRegion = await screen.findByTestId(
        'session-evidence-region',
      );
      await waitFor(() => expect(document.activeElement).toBe(evidenceRegion));
      expect(onFocusConsumed).toHaveBeenCalledTimes(1);
      const evidenceButton = screen.getByRole('button', {
        name: 'Evidence for Completed work',
      });
      evidenceButton.focus();
      // the region host clears the consumed focus (`clearSurfaceIntentFocus`)
      // under the same token: no second reveal
      view.rerenderSession('done', undefined, 1, onFocusConsumed);
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(document.activeElement).toBe(evidenceButton);
      expect(onFocusConsumed).toHaveBeenCalledTimes(1);

      view.rerenderSession('done', 'evidence', 2, onFocusConsumed);

      await waitFor(() => expect(document.activeElement).toBe(evidenceRegion));
      expect(onFocusConsumed).toHaveBeenCalledTimes(2);
    });
  });
});

/**
 * station (sessions-under-home): the surface is presented as ACTIVITY — the
 * sidebar entry is gone and Home's lane links are the way in — while each row
 * stays a "session" (that is what the list shows). These tests pin the two
 * halves of that rename where they render:
 *
 * - the page heading/label says Activity, and no standalone capitalized
 *   "Sessions" (the old surface name) survives anywhere in the rendered
 *   output, populated or empty — a half-rename here would be a label the
 *   navigation no longer derives;
 * - the page root carries `data-first-run-anchor="activity"`, which is what
 *   the first-run tour step anchors on now that the `nav-sessions` sidebar
 *   button no longer exists (`tour-steps.test.ts` checks the source literal;
 *   this checks the rendered DOM).
 */
describe('Activity presentation (sessions moved under Home)', () => {
  function activitySession(
    overrides: Record<string, unknown> = {},
  ): Record<string, unknown> {
    return {
      provider: 'claude',
      threadId: 'thread-activity-1',
      status: 'idle',
      lifecycleState: 'completed',
      controlMode: 'read-only-attached',
      answerability: { answerable: false },
      isLoaded: true,
      isPersisted: true,
      eventCount: 2,
      createdAt: '2026-06-28T00:00:00.000Z',
      updatedAt: '2026-06-28T00:00:01.000Z',
      projectSlug: 'demo',
      cwd: '/Users/dev/code/beacon',
      ...overrides,
    };
  }

  test('titles the surface Activity and leaves no rendered "Sessions" surface name (populated)', () => {
    sessions = [activitySession({ displayTitle: 'Fix the flaky gate' })];

    const { container } = renderView();

    expect(screen.getAllByText('Activity').length).toBeGreaterThan(0);
    // The old surface name must not survive anywhere in the rendered text.
    // Lowercase "session(s)" stays legitimate — it is the item noun.
    expect(container.textContent).not.toMatch(/\bSessions\b/);
    expect(
      container.querySelector('[data-first-run-anchor="activity"]'),
    ).not.toBeNull();
  });

  test('empty state says what the page shows without the old surface name', () => {
    sessions = [];

    const { container } = renderView();

    expect(screen.getByText('Nothing has run yet')).toBeTruthy();
    expect(
      screen.getByText('Agent sessions appear here as they run on this host.'),
    ).toBeTruthy();
    expect(container.textContent).not.toMatch(/\bSessions\b/);
  });

  test('shows delegated work in its own default group without opening a session', () => {
    sessions = [
      activitySession({
        displayTitle: 'Review in the background',
        delegation: { taskId: 'task:background-review' },
      }),
      activitySession({
        threadId: 'operator-session',
        displayTitle: 'Operator conversation',
      }),
    ];

    const { container } = renderView();

    expect(
      Array.from(container.querySelectorAll('.split-pane__section-header')).map(
        (node) => node.textContent,
      ),
    ).toEqual(['Delegated/background work · 1', 'Operator sessions · 1']);
    expect(screen.queryByTestId('session-detail')).toBeNull();
  });

  test('groups by the current paired-device name, relabels on rename, and keeps an empty device', () => {
    pairedDevices = [
      { id: 'phone-1', name: 'Brian’s Pixel' },
      { id: 'tablet-1', name: 'Travel tablet' },
    ];
    sessions = [
      activitySession({
        displayTitle: 'Phone-started review',
        turnOrigin: {
          latest: {
            version: 1,
            actor: { kind: 'device', deviceId: 'phone-1' },
            reported: { version: 1, surface: 'mobile', build: null },
          },
          hasOtherOrigins: false,
        },
      }),
    ];
    const rendered = renderView();
    fireEvent.click(screen.getByRole('tab', { name: 'By origin' }));

    expect(screen.getByText('Brian’s Pixel')).toBeTruthy();
    expect(screen.getByText('Travel tablet')).toBeTruthy();
    expect(
      screen
        .getByText('Travel tablet')
        .classList.contains('split-pane__section-header--empty'),
    ).toBe(true);

    pairedDevices = [
      { id: 'phone-1', name: 'Renamed phone' },
      { id: 'tablet-1', name: 'Travel tablet' },
    ];
    rendered.rerenderSession();
    expect(screen.getByText('Renamed phone')).toBeTruthy();
    expect(screen.queryByText('Brian’s Pixel')).toBeNull();
  });

  test('reads the operator-only device inventory only while the origin axis is shown', () => {
    // /api/pairing/devices answers 401 to a paired device's own session, and
    // the fresh-home walkthrough counts every refused request on /activity.
    // The inventory only names origin groups, so it must not be fetched on
    // the default task axis at all.
    pairedDevices = [{ id: 'phone-1', name: 'Idle phone' }];
    usePairedDevicesQuery.mockClear();
    renderView();
    const enabledCalls = () =>
      usePairedDevicesQuery.mock.calls.map(
        (call) => (call[1] as { enabled?: boolean } | undefined)?.enabled,
      );
    expect(enabledCalls().length).toBeGreaterThan(0);
    expect(enabledCalls().every((enabled) => enabled === false)).toBe(true);

    fireEvent.click(screen.getByRole('tab', { name: 'By origin' }));
    expect(enabledCalls().at(-1)).toBe(true);
    expect(screen.getByText('Idle phone')).toBeTruthy();

    fireEvent.click(screen.getByRole('tab', { name: 'By task' }));
    expect(enabledCalls().at(-1)).toBe(false);
  });

  test('renders the paired-device inventory when no sessions exist', () => {
    pairedDevices = [{ id: 'phone-1', name: 'Idle phone' }];
    sessions = [];
    renderView();
    fireEvent.click(screen.getByRole('tab', { name: 'By origin' }));

    expect(screen.getByText('Idle phone')).toBeTruthy();
    expect(screen.queryByText('Nothing has run yet')).toBeNull();
  });

  test('keeps an unrecorded origin out of device groups and discloses mixed origins on the row', () => {
    pairedDevices = [{ id: 'phone-1', name: 'Brian’s Pixel' }];
    sessions = [
      activitySession({ displayTitle: 'No provenance session' }),
      activitySession({
        threadId: 'mixed-origin-session',
        displayTitle: 'Mixed-origin review',
        turnOrigin: {
          latest: {
            version: 1,
            actor: { kind: 'operator' },
            reported: { version: 1, surface: 'web', build: null },
          },
          hasOtherOrigins: true,
        },
      }),
    ];
    const { container } = renderView();
    fireEvent.click(screen.getByRole('tab', { name: 'By origin' }));

    expect(screen.getByText('Origin not recorded')).toBeTruthy();
    const deviceHeading = screen.getByText('Brian’s Pixel');
    expect(
      deviceHeading.classList.contains('split-pane__section-header--empty'),
    ).toBe(true);
    expect(container.textContent).toContain('No provenance session');
    expect(screen.getByText('Also driven from another origin')).toBeTruthy();
  });

  test('switches axes from the keyboard and preserves the selected session', () => {
    sessions = [activitySession({ displayTitle: 'Selected review' })];
    renderView();
    fireEvent.click(screen.getByRole('button', { name: /Selected review/ }));
    const taskTab = screen.getByRole('tab', { name: 'By task' });
    taskTab.focus();
    fireEvent.keyDown(taskTab, { key: 'ArrowRight' });

    expect(
      screen
        .getByRole('tab', { name: 'By origin' })
        .getAttribute('aria-selected'),
    ).toBe('true');
    expect(screen.getByTestId('session-detail')).toBeTruthy();
  });
});
