/** @vitest-environment jsdom */

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  act,
  fireEvent,
  render,
  renderHook,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import type { ComponentProps } from 'react';
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
  vi,
} from 'vitest';
import { activeChatsStore } from '../contexts/active-chats-store';
import { openChatsStore } from '../contexts/open-chats-store';
import { writeSnooze } from '../utils/activity-snooze-store';
import { TERMINAL_LINGER_MS } from '../views/home/home-lane-model';

// #928: Activity has no route left, so every Home affordance that used to
// navigate to `{ type: 'activity' }` now reveals the region surface instead.
// `useShowSurface` reaches the region model through a provider this file does
// not mount, so the double is both the stand-in and what the assertions read.
const showSurface = vi.hoisted(() => vi.fn());
const showSurfacePage = vi.hoisted(() => vi.fn());
// Mutable so the authority-switching test can move the mounted Home between
// two same-origin authorities (and to none).
const authorityRef = vi.hoisted(() => ({
  current: {
    apiBase: 'http://station.test',
    authorityKey: 'ui-scope-test-authority',
    isCurrent: () => true,
  } as
    | {
        apiBase: string;
        authorityKey: string;
        isCurrent: () => boolean;
      }
    | undefined,
}));
vi.mock('../contexts/ApiBaseContext', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  useApiBase: () => ({ apiBase: 'http://station.test' }),
  useHostRequestAuthorityScope: () => authorityRef.current,
}));

vi.mock('../contexts/useShowSurface', () => ({
  useShowSurface: () => showSurface,
  useShowSurfacePage: () => showSurfacePage,
}));

import { HomeView } from '../views/HomeView';

// #2312: Draft rows carry "Discard draft", a server mutation, so Home renders
// under the QueryClient production mounts it in.
function renderHomeView(
  props: ComponentProps<typeof HomeView>,
  queryClient = new QueryClient(),
) {
  return render(
    <QueryClientProvider client={queryClient}>
      <HomeView {...props} />
    </QueryClientProvider>,
  );
}

const fixtures = vi.hoisted(() => ({
  projects: [{ id: 'p1', slug: 'station', name: 'Station' }],
  projectsByAuthority: {} as Record<
    string,
    Array<{ id: string; slug: string; name: string }>
  >,
  projectsLoading: false,
  sessions: [] as any[],
  tasks: [] as any[],
  chats: {} as Record<string, any>,
  agents: [{ slug: 'codex-agent', name: 'Codex', model: 'gpt-5.3-codex' }],
  agentsLoaded: true,
  developerToolsEnabled: false,
  sessionsError: false,
  sessionsLoading: false,
  tasksError: false,
  tasksLoading: false,
  defaultAgent: { slug: 'codex-agent', name: 'Codex' } as any,
  defaultModelLabel: 'gpt-5.3-codex',
  sessionsRefetch: vi.fn(),
  /** U1: a project's layouts, by slug; absent means none. */
  layoutsBySlug: {} as Record<string, Array<{ slug: string; type: string }>>,
  listProjectLayouts: vi.fn(),
  // #2312: the server command a Draft row's discard dispatches.
  discardDraft: vi.fn(async (command: { threadId: string }) => ({
    receipt: {
      commandId: 'discard-1',
      threadId: command.threadId,
      commandType: 'discardDraft',
      status: 'accepted',
      createdAt: '2026-09-23T00:00:00.000Z',
    },
    result: null,
  })),
  tasksRefetch: vi.fn(),
  inventoryRefetch: vi.fn(),
  remoteSessionsResult: undefined as
    | {
        environments: any[];
        unavailable: any[];
        authenticationRequired?: any[];
      }
    | undefined,
}));

vi.mock('../contexts/open-chats-store', async () => {
  // #1582 B9: the work selector shares the store's own predicate rather than
  // restating it, so this double cannot disagree with production about which
  // chats Home may name.
  const { activeChatHasWork } = await import('../contexts/active-chats-state');
  const map = (entries: [string, any][]) =>
    entries.map(([id, chat]: [string, any]) => ({
      id: chat.conversationId ?? id,
      chatSessionId: id,
      kind: 'chat',
      kindLabel: 'Direct chat',
      title: chat.title ?? 'Task',
      projectLabel: chat.projectName ?? chat.projectSlug ?? 'No project',
      agentLabel: chat.agentName ?? chat.agentSlug ?? 'Agent not reported',
      modelLabel: chat.model ?? 'Model not reported',
      updatedAt: Math.max(
        0,
        ...(chat.messages ?? []).map((message: any) => message.timestamp ?? 0),
      ),
      lifecycleLabel: chat.status === 'sending' ? 'Running' : 'Recent',
    }));
  return {
    useOpenChats: () => map(Object.entries(fixtures.chats) as [string, any][]),
    useOpenWorkChats: () =>
      map(
        (Object.entries(fixtures.chats) as [string, any][]).filter(([, chat]) =>
          activeChatHasWork(chat),
        ),
      ),
    openChatsStore: {
      focus: vi.fn(),
      openCollection: vi.fn(),
      registerNavigation: ({ focus }: any) => {
        openChatsStore.focus = focus;
        return vi.fn();
      },
    },
  };
});

vi.mock('@kontourai/station-sdk', () => ({
  // archive#3122: Home resolves its Workspace Pane renderer through
  // the shared selector, which reads the MCP-app host capability from config.
  // Undefined data is the real pre-load shape, and Home's built-in renderer
  // declares no MCP capability, so no selection here depends on it.
  useConfigQuery: () => ({ data: undefined, error: null }),
  // archive#3391: Home resolves a work item's model id against this catalog so
  // its rows name a model the way the New Chat cards do. Empty here — these
  // tests supply labels through their own fixtures, and an empty catalog is
  // the honest "this Station knows no models" case rather than a stub name.
  useModelPickerCatalogQuery: () => ({
    data: {
      agentConnections: [],
      modelConnections: [],
      excluded: { agents: 0, models: 0 },
    },
  }),
  useConversationInventoryQuery: () => ({
    data: [],
    isError: false,
    isLoading: false,
    refetch: fixtures.inventoryRefetch,
  }),
  useAcknowledgeConversationMutation: () => ({ mutate: vi.fn() }),
  useProjectsQuery: (config?: {
    requestScope?: { authorityKey: string } | undefined;
    requireRequestScope?: boolean;
  }) => {
    const byAuthority = fixtures.projectsByAuthority as Record<
      string,
      Array<{ id: string; slug: string; name: string }>
    >;
    const data = config?.requestScope
      ? (byAuthority[config.requestScope.authorityKey] ?? fixtures.projects)
      : undefined;
    return { data, isLoading: fixtures.projectsLoading };
  },
  dispatchOrchestrationCommandWithReceipt: fixtures.discardDraft,
  useOrchestrationSessionsQuery: () => ({
    data: fixtures.sessions,
    isError: fixtures.sessionsError,
    isLoading: fixtures.sessionsLoading,
    refetch: fixtures.sessionsRefetch,
  }),
  useTasksQuery: () => ({
    data: fixtures.tasks,
    isError: fixtures.tasksError,
    isLoading: fixtures.tasksLoading,
    refetch: fixtures.tasksRefetch,
  }),
  // archive#1097: pending by default (`data: undefined`) — proves the local
  // list above never waits on this.
  useRemoteSessionsQuery: () => ({ data: fixtures.remoteSessionsResult }),
  // Home mounts StarterWorkCard whenever first run is `completed`, which every
  // test here is. The card's own states belong to
  // `components/home/__tests__/StarterWorkCard.test.tsx`; here it is settled on
  // `unbound`, its steady no-starter-yet shape. Deliberately not the pending
  // shape: that renders a skeleton carrying `role="status"`, which would make
  // this file's two "no false empty state while a lane loads" tests ambiguous
  // against the lane skeleton they actually assert on.
  useStarterWorkQuery: () => ({
    data: { state: 'unbound' as const },
    isLoading: false,
    isError: false,
    refetch: vi.fn(),
  }),
  useStarterInspectionCandidateQuery: () => ({
    data: { state: 'missing' as const },
    isLoading: false,
    isError: false,
    refetch: vi.fn(),
  }),
  useStarterWorkObservationQuery: () => ({
    data: undefined,
    isLoading: false,
    isError: false,
    refetch: vi.fn(),
  }),
  useLaunchStarterInspectionMutation: () => ({
    mutateAsync: vi.fn(),
    isPending: false,
    isError: false,
  }),
  useLaunchScheduledCheckStarterMutation: () => ({
    mutateAsync: vi.fn(),
    isPending: false,
    isError: false,
  }),
  useTaskQuery: () => ({
    data: undefined,
    isLoading: false,
    isError: false,
    refetch: vi.fn(),
  }),
}));
vi.mock('@kontourai/station-sdk/client', () => ({
  // U1: the layouts read Home makes before routing a row to its Coding layout.
  listProjectLayouts: (_apiBase: string, slug: string) => {
    fixtures.listProjectLayouts(slug);
    return Promise.resolve(fixtures.layoutsBySlug[slug] ?? []);
  },
}));
vi.mock('../contexts/ActiveChatsContext', () => ({
  useAllActiveChats: () => fixtures.chats,
}));
vi.mock('../contexts/AgentsContext', () => ({
  useAgents: () => fixtures.agents,
  useAgentsLoaded: () => fixtures.agentsLoaded,
  useAgentsSettled: () => true,
}));
vi.mock('../contexts/DeviceSettingsContext', () => ({
  useDeviceSettings: () => ({
    developerToolsEnabled: fixtures.developerToolsEnabled,
  }),
}));
// Home mounts the first-run chapter (UX audit RT-02). These fixtures put the
// home in the state every test in this file assumes — one that has already
// been set up — so the chapter renders nothing and Home is what is asserted.
// `FirstRunHomeChapter.test.tsx` owns the chapter's own behaviour.
vi.mock('../contexts/ConfigContext', () => ({
  useConfig: () => ({ firstRun: { status: 'completed' } }),
  useConfigSettled: () => true,
  useConfigActions: () => ({
    updateConfig: vi.fn(),
    recordFirstRunDecision: vi.fn(),
    isSaving: false,
  }),
}));
vi.mock('../hooks/useSystemStatus', () => ({
  useSystemStatus: () => ({ data: { externalEngines: [] }, isLoading: false }),
}));
vi.mock('../contexts/onboarding-setup-store', () => ({
  useOnboardingSetupState: () => ({
    isBlockingFullScreen: false,
    launcherWouldShow: false,
  }),
  firstRunChapterPresence: { set: () => {} },
}));
// The chapter asks the disclosure whether the run has anything to disclose,
// and that reaches a real API base. Answered here rather than stood up: this
// home is `completed`, so the chapter renders nothing either way.
vi.mock('../components/UsageTelemetryDisclosure', () => ({
  useUsageTelemetryDisclosureState: () => ({
    data: undefined,
    isError: false,
    settled: true,
    outstanding: false,
  }),
  UsageTelemetryDisclosureStep: () => null,
  dismissUsageTelemetryDisclosure: vi.fn(),
}));
vi.mock('../contexts/NavigationContext', () => ({
  useNavigation: () => ({ selectedProject: null }),
}));
vi.mock('../hooks/useNewChatSelectionModel', () => ({
  useNewChatSelectionModel: () => ({
    defaultSelection: {
      agent: fixtures.defaultAgent,
      effectiveModel: { label: fixtures.defaultModelLabel },
    },
  }),
}));
// This suite owns the built-in Home lanes. The Home-role hook's dedicated
// tests own its QueryClient-backed authority states; unresolved is the real
// fail-closed floor that keeps the built-in Home mounted.
vi.mock('../views/home/useWorkspaceHomeRole', () => ({
  useWorkspaceHomeRoleStatus: () => undefined,
  useRevokeWorkspaceHomeRole: () => vi.fn(),
}));

/**
 * The name Home gives a `codex` session with no `displayTitle` and no
 * delegated task id — the shape most fixtures in this file use.
 *
 * archive#3227 A2: this was `'Codex task'`. Home built its own title whose
 * no-taskId fallback was `${agentLabel} task`; it now reads the canonical
 * `sessionTitle`, whose fallback is the engine-named
 * `${displayProvider(session)} session` — the same string the sessions list
 * and the detail pane already showed for the same session. Pinned as one
 * constant so a future title change has to be made once, deliberately, rather
 * than pass by updating whichever assertion went red first.
 */
const CODEX_SESSION_TITLE = 'Codex session';

describe('HomeView', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  beforeEach(() => {
    showSurface.mockClear();
    showSurfacePage.mockClear();
    fixtures.sessions = [];
    fixtures.tasks = [];
    fixtures.chats = {};
    fixtures.agents = [
      { slug: 'codex-agent', name: 'Codex', model: 'gpt-5.3-codex' },
    ];
    fixtures.agentsLoaded = true;
    fixtures.projectsLoading = false;
    fixtures.developerToolsEnabled = false;
    fixtures.sessionsError = false;
    fixtures.sessionsLoading = false;
    fixtures.tasksError = false;
    fixtures.tasksLoading = false;
    fixtures.defaultAgent = { slug: 'codex-agent', name: 'Codex' };
    fixtures.defaultModelLabel = 'gpt-5.3-codex';
    fixtures.sessionsRefetch.mockClear();
    fixtures.discardDraft.mockClear();
    fixtures.tasksRefetch.mockClear();
    fixtures.inventoryRefetch.mockClear();
    fixtures.remoteSessionsResult = undefined;
  });

  test('shows guided start/open actions with a concrete selected identity', () => {
    const onNavigate = vi.fn();
    const newChat = vi.fn();
    window.addEventListener('station:open-new-chat', newChat, { once: true });
    renderHomeView({ continuation: null, onNavigate });

    expect(
      screen.getByRole('textbox', { name: 'What would you like done?' }),
    ).toBeTruthy();
    fireEvent.change(
      screen.getByRole('textbox', { name: 'What would you like done?' }),
      { target: { value: 'Help me plan my day' } },
    );
    expect(screen.queryByText(/Default Model/i)).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /Start a chat/i }));
    expect(newChat).toHaveBeenCalledTimes(1);
    fireEvent.click(
      screen.getByRole('button', { name: /Open local project/i }),
    );
    expect(onNavigate).toHaveBeenCalledWith({ type: 'project-new' });
  });

  test('the project-folder card names this Station, not this computer', () => {
    renderHomeView({ continuation: null, onNavigate: vi.fn() });

    // The folder lives on the Station host, which is a different machine
    // when this UI runs as a remote client (e.g. the paired phone app).
    expect(
      screen.getByRole('button', { name: /Add a folder on this Station/i }),
    ).toBeTruthy();
    expect(screen.queryByText(/from this computer/i)).toBeNull();
  });

  test('renders shimmer cards while Home actions are unresolved instead of claiming an agent is absent', () => {
    fixtures.agents = [];
    fixtures.agentsLoaded = false;
    fixtures.defaultAgent = undefined;
    const { container } = renderHomeView({
      continuation: null,
      onNavigate: vi.fn(),
    });

    expect(
      screen.getByRole('status', { name: 'Finding available ways to help' }),
    ).toBeTruthy();
    // Where the cards will stand (Q3), not under the start form: the start
    // wrapper holds the form alone.
    const start = container.querySelector<HTMLElement>('.home-view__start');
    expect(start).toBeTruthy();
    expect(
      within(start!).queryByRole('status', {
        name: 'Finding available ways to help',
      }),
    ).toBeNull();
    expect(container.querySelector('.home-view__goal textarea')).toBeTruthy();
    expect(screen.queryByText('No agent is ready yet')).toBeNull();
    expect(
      screen.getByRole('button', { name: /Start a chat/i }),
    ).toHaveProperty('disabled', true);
    expect(
      screen.queryByRole('button', { name: /Connect an AI app/i }),
    ).toBeNull();
  });

  test('keeps inspection and Scheduler self-test cards off default Home and admits them only in developer mode', () => {
    const defaultHome = renderHomeView({
      continuation: null,
      onNavigate: vi.fn(),
    });
    expect(screen.queryByText('Inspect an approval')).toBeNull();
    expect(screen.queryByText('Inspect review evidence')).toBeNull();
    expect(screen.queryByText('Run a scheduled readiness check')).toBeNull();
    defaultHome.unmount();

    fixtures.developerToolsEnabled = true;
    renderHomeView({ continuation: null, onNavigate: vi.fn() });
    expect(screen.getByText('Inspect an approval')).toBeTruthy();
    expect(screen.getByText('Inspect review evidence')).toBeTruthy();
    expect(screen.getByText('Run a scheduled readiness check')).toBeTruthy();
  });

  test('degrades a still-pending recent-work lane to an actionable host-slow state', () => {
    vi.useFakeTimers();
    fixtures.sessionsLoading = true;
    renderHomeView({ continuation: null, onNavigate: vi.fn() });
    expect(
      screen.getByRole('status', { name: 'Loading recent work' }),
    ).toBeTruthy();

    act(() => vi.advanceTimersByTime(8_000));
    expect(
      screen.getByText('Recent work is taking longer than expected'),
    ).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Retry' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(fixtures.sessionsRefetch).toHaveBeenCalledTimes(1);
    expect(fixtures.tasksRefetch).toHaveBeenCalledTimes(1);
    expect(fixtures.inventoryRefetch).toHaveBeenCalledTimes(1);
  });

  // #1582 B9: a chat created and never typed into is not work. It produced a
  // "Continue most recent work → New chat" card that a reload erased, because
  // Home read the same unfiltered selection the inboxes do. Home takes
  // `useOpenWorkChats`; swapping it back for `useOpenChats` reddens this.
  test('a chat nothing has been put into produces no continue-work card', () => {
    fixtures.chats = {
      'claude:1788672912443': {
        agentSlug: 'codex-agent',
        agentName: 'Codex',
        title: 'New chat',
      },
    };
    renderHomeView({ continuation: null, onNavigate: vi.fn() });
    expect(screen.queryByRole('button', { name: /^Continue/ })).toBeNull();
  });

  test('the same chat produces the card once its first turn promotes it', () => {
    // The discriminating pair: identical fixture but for the conversation id
    // the first successful turn assigns, so the absence above is the predicate
    // and not an empty Home.
    fixtures.chats = {
      'claude:1788672912443': {
        conversationId: 'conversation-1',
        agentSlug: 'codex-agent',
        agentName: 'Codex',
        title: 'New chat',
      },
    };
    renderHomeView({ continuation: null, onNavigate: vi.fn() });
    expect(
      screen.getByRole('button', { name: /^Continue/ }).textContent,
    ).toContain('New chat');
  });

  /**
   * U1 (design round 2026-10): a chat opened from Home lands where it
   * lives. A project with a Coding layout centres the chat there; the chat
   * is still focused first (the same shared action as every other row), and
   * a project with no Coding layout, or no project, stays in the dock.
   */
  test('opening a row whose project has a Coding layout routes to that layout after focusing the chat', async () => {
    fixtures.layoutsBySlug = {
      station: [
        { slug: 'tasks', type: 'tasks' },
        { slug: 'coding', type: 'coding' },
      ],
    };
    fixtures.listProjectLayouts.mockClear();
    fixtures.sessions = [
      {
        threadId: 'coding-thread',
        provider: 'claude',
        model: 'claude-sonnet-4',
        status: 'ready',
        assignedAgentSlug: 'codex-agent',
        projectSlug: 'station',
        displayTitle: 'Lives in Coding',
        createdAt: '2026-07-14T00:00:00Z',
        updatedAt: '2026-07-14T01:00:00Z',
        isLoaded: true,
        isPersisted: true,
        answerability: { answerable: true },
        eventCount: 2,
        lifecycleState: 'idle',
        hasActiveTurn: false,
      },
    ];
    const focus = vi.fn();
    const unregister = openChatsStore.registerNavigation({
      focus,
      openCollection: vi.fn(),
    });
    const onNavigate = vi.fn();
    renderHomeView({ continuation: null, onNavigate });
    // The row itself, by keyboard: Enter on the focused row is a click.
    const row = screen.getByRole('button', {
      name: 'Lives in Coding, station',
    });
    row.focus();
    fireEvent.click(row);
    expect(focus).toHaveBeenCalledTimes(1);
    expect(focus.mock.calls[0]?.[0]).toMatchObject({
      conversationId: 'coding-thread',
      agentSlug: 'codex-agent',
    });
    await waitFor(() =>
      expect(onNavigate).toHaveBeenCalledWith({
        type: 'layout',
        projectSlug: 'station',
        layoutSlug: 'coding',
      }),
    );
    expect(fixtures.listProjectLayouts).toHaveBeenCalledWith('station');
    unregister();
  });

  test('a row whose project has no Coding layout stays in the dock', async () => {
    fixtures.layoutsBySlug = { station: [{ slug: 'tasks', type: 'tasks' }] };
    fixtures.sessions = [
      {
        threadId: 'dock-thread',
        provider: 'claude',
        model: 'claude-sonnet-4',
        status: 'ready',
        assignedAgentSlug: 'codex-agent',
        projectSlug: 'station',
        displayTitle: 'Stays in the dock',
        createdAt: '2026-07-14T00:00:00Z',
        updatedAt: '2026-07-14T01:00:00Z',
        isLoaded: true,
        isPersisted: true,
        answerability: { answerable: true },
        eventCount: 2,
        lifecycleState: 'idle',
        hasActiveTurn: false,
      },
    ];
    const focus = vi.fn();
    const unregister = openChatsStore.registerNavigation({
      focus,
      openCollection: vi.fn(),
    });
    const onNavigate = vi.fn();
    renderHomeView({ continuation: null, onNavigate });
    fireEvent.click(
      screen.getByRole('button', { name: 'Stays in the dock, station' }),
    );
    expect(focus).toHaveBeenCalledTimes(1);
    // The lookup settles with no layout: nothing routes.
    await waitFor(() =>
      expect(fixtures.listProjectLayouts).toHaveBeenCalledWith('station'),
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(onNavigate).not.toHaveBeenCalled();
    unregister();
  });

  test('orders real timestamps and focuses an active chat continuation', () => {
    fixtures.sessions = [
      {
        threadId: 'older-thread',
        provider: 'claude',
        model: 'claude-sonnet-4',
        status: 'ready',
        createdAt: '2026-07-11T00:00:00Z',
        updatedAt: '2026-07-11T01:00:00Z',
        isLoaded: true,
        isPersisted: true,
        answerability: { answerable: true },
        eventCount: 2,
      },
    ];
    fixtures.chats = {
      newest: {
        title: 'Task-first home',
        agentSlug: 'codex-agent',
        agentName: 'Codex',
        model: 'gpt-5.3-codex',
        projectName: 'Station',
        messages: [
          {
            role: 'user',
            content: 'ship it',
            timestamp: Date.parse('2026-07-12T00:00:00Z'),
          },
        ],
      },
    };
    const focus = vi.fn();
    const unregister = openChatsStore.registerNavigation({
      focus,
      openCollection: vi.fn(),
    });
    renderHomeView({ continuation: null, onNavigate: vi.fn() });
    const continueButton = screen.getByRole('button', {
      name: /^Continue/,
    });
    expect(continueButton.textContent).toContain('Task-first home');
    expect(continueButton.textContent).toContain('Codex · gpt-5.3-codex');
    fireEvent.click(continueButton);
    expect(focus).toHaveBeenCalledTimes(1);
    expect(focus).toHaveBeenCalledWith({ sessionId: 'newest' });
    unregister();
  });

  // #3312: with work on the page the start form is the compact one, and it
  // still names the Agent and Model Start will run on. The note reads the
  // same default selection (`useNewChatSelectionModel`) that the start path
  // opens on, so changing that selection changes the note.
  const workSession = () => ({
    threadId: 'work-thread',
    provider: 'codex',
    status: 'ready',
    createdAt: '2026-07-13T00:00:00Z',
    updatedAt: '2026-07-13T00:00:00Z',
    isLoaded: true,
    isPersisted: true,
    answerability: { answerable: true },
    eventCount: 3,
  });
  test.each([
    ['gpt-5.3-codex', 'Codex · gpt-5.3-codex'],
    ['gpt-5.4', 'Codex · gpt-5.4'],
    ['Model not reported', 'Codex'],
  ])(
    'the compact start form names the default selection (%s) beside Start',
    (modelLabel, expected) => {
      fixtures.defaultModelLabel = modelLabel;
      fixtures.sessions = [workSession()];
      renderHomeView({ continuation: null, onNavigate: vi.fn() });
      const form = screen.getByRole('form', { name: 'Start work' });
      expect(form.classList.contains('home-view__goal--compact')).toBe(true);
      const start = within(form).getByRole('button', { name: 'Start a chat' });
      const note = document.getElementById(
        start.getAttribute('aria-describedby') ?? '',
      );
      expect(note?.textContent).toBe(expected);
    },
  );

  test('the compact start form names no identity when no Agent is ready', () => {
    fixtures.defaultAgent = undefined;
    fixtures.sessions = [workSession()];
    renderHomeView({ continuation: null, onNavigate: vi.fn() });
    const form = screen.getByRole('form', { name: 'Start work' });
    expect(form.classList.contains('home-view__goal--compact')).toBe(true);
    expect(
      within(form)
        .getByRole('button', { name: 'Start a chat' })
        .getAttribute('aria-describedby'),
    ).toBeNull();
    expect(form.querySelector('.home-view__goal-identity')).toBeNull();
  });

  test('uses honest identity fallbacks and selects exact orchestration continuation', () => {
    fixtures.agents = [];
    fixtures.defaultAgent = undefined;
    fixtures.defaultModelLabel = 'Model not reported';
    fixtures.sessions = [
      {
        threadId: 'unmapped-thread',
        provider: '',
        status: 'ready',
        createdAt: '2026-07-13T00:00:00Z',
        updatedAt: '2026-07-13T00:00:00Z',
        isLoaded: true,
        isPersisted: true,
        answerability: { answerable: true },
        eventCount: 0,
      },
    ];
    const onNavigate = vi.fn();
    renderHomeView({ continuation: null, onNavigate });
    expect(screen.getAllByText('Agent not reported').length).toBeGreaterThan(0);
    fireEvent.click(screen.getByRole('button', { name: /^Continue/ }));
    expect(showSurface).toHaveBeenCalledWith('activity', {
      session: 'unmapped-thread',
    });
    expect(onNavigate).not.toHaveBeenCalled();
  });

  // #2310 review M3: the newest session is a Draft (nothing ever sent). The
  // card must continue the most recent WORK, not an empty session.
  test('"Continue most recent work" skips a newer Draft', () => {
    fixtures.agents = [];
    fixtures.defaultAgent = undefined;
    fixtures.defaultModelLabel = 'Model not reported';
    const base = {
      provider: '',
      status: 'ready' as const,
      isLoaded: true,
      isPersisted: true,
      answerability: { answerable: true as const },
      eventCount: 0,
      hasActiveTurn: false,
    };
    fixtures.sessions = [
      {
        ...base,
        threadId: 'worked-thread',
        lifecycleState: 'running',
        draft: false,
        createdAt: '2026-07-13T00:00:00Z',
        updatedAt: '2026-07-13T00:00:00Z',
      },
      {
        ...base,
        threadId: 'draft-thread',
        lifecycleState: 'queued',
        draft: true,
        createdAt: '2026-07-14T00:00:00Z',
        updatedAt: '2026-07-14T00:00:00Z',
      },
    ];
    renderHomeView({ continuation: null, onNavigate: vi.fn() });
    fireEvent.click(screen.getByRole('button', { name: /^Continue/ }));
    expect(showSurface).toHaveBeenCalledWith('activity', {
      session: 'worked-thread',
    });
  });

  // #2310 (verifier finding): the partition routes a Draft ONLY to `drafts`,
  // so if Home stopped rendering that section the row would vanish from Home
  // with every other test green. Render it and find the row inside it.
  test('Home lists a Draft under its own Drafts section, and not under a live lane', () => {
    fixtures.agents = [];
    fixtures.defaultAgent = undefined;
    fixtures.defaultModelLabel = 'Model not reported';
    const base = {
      provider: '',
      status: 'ready' as const,
      isLoaded: true,
      isPersisted: true,
      answerability: { answerable: true as const },
      eventCount: 0,
      hasActiveTurn: false,
      createdAt: '2026-07-14T00:00:00Z',
      updatedAt: '2026-07-14T00:00:00Z',
    };
    fixtures.sessions = [
      {
        ...base,
        threadId: 'worked-thread',
        displayTitle: 'Worked session title',
        lifecycleState: 'running',
        draft: false,
      },
      {
        ...base,
        threadId: 'draft-thread',
        displayTitle: 'Never prompted title',
        lifecycleState: 'queued',
        draft: true,
      },
    ];
    renderHomeView({ continuation: null, onNavigate: vi.fn() });

    // Folded by default behind the shared disclosure toggle (C13).
    const toggle = screen.getByRole('button', { name: 'Drafts · 1' });
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(toggle);
    const drafts = toggle.closest('section');
    expect(drafts).not.toBeNull();
    // A Draft untouched for a day sits behind the inner fold (#2312).
    fireEvent.click(
      within(drafts as HTMLElement).getByRole('button', {
        name: '1 older draft',
      }),
    );
    expect(
      within(drafts as HTMLElement).getByText('Never prompted title'),
    ).toBeTruthy();
    // The worked session has no turn in flight: it is Idle, not Running.
    const idle = screen.getByRole('region', { name: /^Idle/ });
    expect(within(idle).queryByText('Never prompted title')).toBeNull();
    expect(within(idle).getByText('Worked session title')).toBeTruthy();
    expect(screen.queryByRole('region', { name: /^Running/ })).toBeNull();
  });

  // #2312: a Draft is discarded by the SERVER (so every device agrees), from
  // the Drafts section, and Drafts untouched for a day fold under their own
  // disclosure instead of aging out of existence.
  test('Home discards a Draft through the server and folds day-old Drafts under "N older drafts"', async () => {
    fixtures.agents = [];
    fixtures.defaultAgent = undefined;
    fixtures.defaultModelLabel = 'Model not reported';
    const at = (ageMs: number) => new Date(Date.now() - ageMs).toISOString();
    const HOUR = 60 * 60 * 1000;
    const base = {
      provider: '',
      status: 'ready' as const,
      isLoaded: true,
      isPersisted: true,
      answerability: { answerable: true as const },
      eventCount: 0,
      hasActiveTurn: false,
      lifecycleState: 'queued',
    };
    fixtures.sessions = [
      {
        ...base,
        threadId: 'worked-thread',
        displayTitle: 'Worked session title',
        lifecycleState: 'running',
        draft: false,
        createdAt: at(HOUR),
        updatedAt: at(HOUR),
      },
      {
        ...base,
        threadId: 'fresh-draft',
        displayTitle: 'Fresh draft title',
        draft: true,
        createdAt: at(23 * HOUR),
        updatedAt: at(23 * HOUR),
      },
      {
        ...base,
        threadId: 'stale-draft',
        displayTitle: 'Stale draft title',
        draft: true,
        createdAt: at(25 * HOUR),
        updatedAt: at(25 * HOUR),
      },
    ];
    const queryClient = new QueryClient();
    const invalidate = vi.spyOn(queryClient, 'invalidateQueries');
    // #2312 review: a dock tab open on the Draft closes with it.
    activeChatsStore.initChat('fresh-draft');
    renderHomeView({ continuation: null, onNavigate: vi.fn() }, queryClient);

    const draftsToggle = screen.getByRole('button', { name: 'Drafts · 2' });
    fireEvent.click(draftsToggle);
    const drafts = draftsToggle.closest('section') as HTMLElement;
    const olderToggle = within(drafts).getByRole('button', {
      name: '1 older draft',
    });
    // The 25h Draft is folded, the 23h one is not.
    expect(olderToggle.getAttribute('aria-expanded')).toBe('false');
    expect(within(drafts).queryByText('Stale draft title')).toBeNull();
    expect(within(drafts).getByText('Fresh draft title')).toBeTruthy();
    fireEvent.click(olderToggle);
    expect(within(drafts).getByText('Stale draft title')).toBeTruthy();
    // Only Drafts are discardable.
    expect(
      screen.queryByRole('button', {
        name: 'Discard draft Worked session title',
      }),
    ).toBeNull();

    fireEvent.click(
      within(drafts).getByRole('button', {
        name: 'Discard draft Fresh draft title',
      }),
    );

    await waitFor(() =>
      expect(invalidate).toHaveBeenCalledWith({
        queryKey: ['orchestration-sessions'],
      }),
    );
    expect(fixtures.discardDraft).toHaveBeenCalledTimes(1);
    expect(fixtures.discardDraft).toHaveBeenCalledWith({
      type: 'discardDraft',
      threadId: 'fresh-draft',
    });
    expect(
      activeChatsStore.getChatKeyForExecutionSession('fresh-draft'),
    ).toBeUndefined();
  });

  // archive#1297: an orchestration row Station CAN rehydrate (a real
  // `agentSlug`, not `read-only-attached`) should reopen into the chat
  // overlay via the shared focus action instead of always jumping to the
  // Sessions view — the third divergent destination the issue flagged.
  test('rehydrates a rehydratable orchestration continuation instead of navigating to Sessions', () => {
    fixtures.sessions = [
      {
        threadId: 'rehydratable-thread',
        provider: 'claude',
        model: 'claude-sonnet-4',
        status: 'ready',
        assignedAgentSlug: 'codex-agent',
        projectSlug: 'station',
        controlMode: 'station-owned',
        createdAt: '2026-07-13T00:00:00Z',
        updatedAt: '2026-07-13T00:00:00Z',
        isLoaded: true,
        isPersisted: true,
        answerability: { answerable: true },
        eventCount: 0,
      },
    ];
    const onNavigate = vi.fn();
    const focus = vi.fn();
    const unregister = openChatsStore.registerNavigation({
      focus,
      openCollection: vi.fn(),
    });
    renderHomeView({ continuation: null, onNavigate });

    fireEvent.click(screen.getByRole('button', { name: /^Continue/ }));

    expect(onNavigate).not.toHaveBeenCalled();
    expect(focus).toHaveBeenCalledTimes(1);
    const detail = focus.mock.calls[0][0];
    expect(detail).toEqual({
      conversationId: 'rehydratable-thread',
      agentSlug: 'codex-agent',
      projectSlug: 'station',
      projectName: 'station',
      threadId: 'rehydratable-thread',
      model: 'claude-sonnet-4',
    });
    unregister();
  });

  // archive#1297: a `read-only-attached` session still can't be rehydrated
  // same Sessions fallback as before.
  test('still navigates to Sessions for a read-only-attached orchestration continuation', () => {
    fixtures.sessions = [
      {
        threadId: 'attached-thread',
        provider: 'claude',
        model: 'claude-sonnet-4',
        status: 'ready',
        assignedAgentSlug: 'codex-agent',
        controlMode: 'read-only-attached',
        createdAt: '2026-07-13T00:00:00Z',
        updatedAt: '2026-07-13T00:00:00Z',
        isLoaded: true,
        isPersisted: true,
        answerability: { answerable: true },
        eventCount: 0,
      },
    ];
    const onNavigate = vi.fn();
    renderHomeView({ continuation: null, onNavigate });

    fireEvent.click(screen.getByRole('button', { name: /^Continue/ }));

    expect(showSurface).toHaveBeenCalledWith('activity', {
      session: 'attached-thread',
    });
    expect(onNavigate).not.toHaveBeenCalled();
  });

  test('does not show a false empty state while orchestration sessions load and Tasks are empty', () => {
    fixtures.sessionsLoading = true;
    const { container } = renderHomeView({
      continuation: null,
      onNavigate: vi.fn(),
    });
    expect(screen.getByRole('status').getAttribute('aria-label')).toBe(
      'Loading recent work',
    );
    expect(container.querySelector('.skeleton-list')).toBeTruthy();
    expect(screen.queryByText('No recent tasks yet.')).toBeNull();
    expect(
      screen.queryByRole('button', { name: 'Start your first chat' }),
    ).toBeNull();
  });

  test('does not show a false empty state while Tasks load and sessions are empty', () => {
    fixtures.tasksLoading = true;
    const { container } = renderHomeView({
      continuation: null,
      onNavigate: vi.fn(),
    });

    expect(screen.getByRole('status').getAttribute('aria-label')).toBe(
      'Loading recent work',
    );
    expect(container.querySelector('.skeleton-list')).toBeTruthy();
    expect(
      screen.queryByRole('button', { name: 'Start your first chat' }),
    ).toBeNull();
  });

  test('uses the canonical actionable empty state for first work', () => {
    const { container } = renderHomeView({
      continuation: null,
      onNavigate: vi.fn(),
    });

    expect(container.querySelector('.home-view__empty')).toBeNull();
    // One line (V6); the start form above it is the action.
    expect(container.querySelector('.empty.empty--compact')).toBeTruthy();
    expect(screen.getByText('Nothing here yet')).toBeTruthy();
  });

  /**
   * #1536 C2: three doors to one room. Home offered the "Start a chat"
   * action card, a "Start your first chat" button inside this empty state, and
   * the dock's own "Start a chat". The empty state now names the card instead
   * of being a third one.
   */
  test('the first-work empty state points at the start card rather than duplicating it', () => {
    renderHomeView({ continuation: null, onNavigate: vi.fn() });

    expect(
      screen.queryByRole('button', { name: 'Start your first chat' }),
    ).toBeNull();
    expect(screen.getByText('Nothing here yet')).toBeTruthy();
    // The form it defers to is the one that stays.
    expect(screen.getByText('Start a chat')).toBeTruthy();
    expect(
      screen.getAllByRole('textbox', { name: 'What would you like done?' }),
    ).toHaveLength(1);
  });

  test('separates Running from terminal Just finished work with counts', () => {
    const recentTerminalAt = new Date(Date.now() - 60_000).toISOString();
    fixtures.sessions = [
      {
        threadId: 'active-thread',
        provider: 'codex',
        status: 'ready',
        lifecycleState: 'running',
        hasActiveTurn: true,
        displayTitle: 'Keep working',
        cwd: '/Users/me/dev/github/kontourai/station',
        createdAt: '2026-07-30T00:00:00Z',
        updatedAt: '2026-07-30T00:00:00Z',
        isLoaded: true,
        isPersisted: true,
        answerability: { answerable: true },
        eventCount: 1,
      },
      {
        threadId: 'failed-thread',
        provider: 'codex',
        status: 'closed',
        lifecycleState: 'failed',
        displayTitle: 'Repair the failed run',
        createdAt: recentTerminalAt,
        updatedAt: recentTerminalAt,
        isLoaded: true,
        isPersisted: true,
        answerability: { answerable: true },
        eventCount: 1,
      },
    ];

    renderHomeView({ continuation: null, onNavigate: vi.fn() });

    const active = screen.getByRole('region', { name: 'Running · 1' });
    const recentlyFinished = screen.getByRole('region', {
      name: 'Just finished · 1',
    });
    expect(within(active).getByText('Keep working')).toBeTruthy();
    expect(
      within(active).getByText('Running', { selector: '.inbox-row__word' }),
    ).toBeTruthy();
    expect(
      within(recentlyFinished).getByText('Repair the failed run'),
    ).toBeTruthy();
    expect(within(recentlyFinished).getByText('Failed')).toBeTruthy();
    expect(within(active).queryByText('Repair the failed run')).toBeNull();
  });

  test('uses the canonical error state when either settled source cannot load and no work is available', () => {
    fixtures.tasksError = true;
    const onNavigate = vi.fn();
    const { container } = renderHomeView({
      continuation: null,
      onNavigate,
    });

    expect(container.querySelector('.home-view__empty')).toBeNull();
    expect(screen.getByRole('alert')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Open Activity' }));
    expect(showSurfacePage).toHaveBeenCalledWith('activity');
    expect(onNavigate).not.toHaveBeenCalled();
  });

  test('renders available durable work when sessions are unavailable', () => {
    fixtures.sessionsError = true;
    fixtures.tasks = [
      {
        id: 'task/durable',
        projectId: 'station',
        title: 'Durable local work',
        description: '',
        priority: 'normal',
        status: 'todo',
        createdBy: 'user',
        createdAt: '2026-07-13T00:00:00Z',
        updatedAt: '2026-07-14T00:00:00Z',
      },
    ];
    const onNavigate = vi.fn();

    renderHomeView({ continuation: null, onNavigate });

    expect(screen.getAllByText('Durable local work')).toHaveLength(2);
    expect(
      screen.getAllByText(/Agent unavailable · Model unavailable/).length,
    ).toBeGreaterThan(0);
    fireEvent.click(screen.getByRole('button', { name: 'View Activity' }));
    expect(showSurfacePage).toHaveBeenCalledWith('activity');
    expect(onNavigate).not.toHaveBeenCalled();
    onNavigate.mockClear();
    fireEvent.click(screen.getByRole('button', { name: /^Continue/ }));
    expect(onNavigate).toHaveBeenCalledWith({
      type: 'task',
      taskId: 'task/durable',
    });
  });

  test('uses only exact persisted session correlations to open durable Tasks', () => {
    fixtures.tasks = [
      {
        id: 'task-1',
        projectId: 'station',
        title: 'Persisted task',
        description: '',
        priority: 'normal',
        status: 'running',
        createdBy: 'user',
        createdAt: '2026-07-13T00:00:00Z',
        updatedAt: '2026-07-15T00:00:00Z',
        sessionId: 'exact-session',
      },
    ];
    fixtures.chats = {
      local: {
        conversationId: 'exact-session',
        title: 'Raw correlated chat',
        messages: [{ timestamp: Date.parse('2026-07-16T00:00:00Z') }],
      },
    };
    fixtures.sessions = [
      {
        threadId: 'exact-session',
        provider: 'codex',
        status: 'ready',
        createdAt: '2026-07-13T00:00:00Z',
        updatedAt: '2026-07-16T00:00:00Z',
        isLoaded: true,
        isPersisted: true,
        answerability: { answerable: true },
        eventCount: 1,
      },
    ];
    const onNavigate = vi.fn();

    renderHomeView({ continuation: null, onNavigate });

    expect(screen.queryByText('Raw correlated chat')).toBeNull();
    expect(screen.getAllByText('Persisted task')).toHaveLength(2);
    fireEvent.click(screen.getByRole('button', { name: /^Continue/ }));
    expect(onNavigate).toHaveBeenCalledWith({ type: 'task', taskId: 'task-1' });
  });
});

describe('HomeView lane wiring (review finding: snooze/shelf/settled-tail interactions)', () => {
  const RUNNING_SESSION = {
    threadId: 'thread-snoozeme',
    provider: 'codex',
    status: 'ready',
    lifecycleState: 'running',
    hasActiveTurn: true,
    createdAt: '2026-07-28T14:00:00Z',
    updatedAt: '2026-07-28T14:00:00Z',
    isLoaded: true,
    isPersisted: true,
    answerability: { answerable: true },
    eventCount: 1,
  };
  const ITEM_TITLE = CODEX_SESSION_TITLE;

  beforeAll(() => {
    Object.defineProperty(window, 'matchMedia', {
      configurable: true,
      value: vi.fn().mockImplementation(() => ({
        matches: false,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        addListener: vi.fn(),
        removeListener: vi.fn(),
        dispatchEvent: vi.fn(),
        media: '',
        onchange: null,
      })),
    });
  });

  beforeEach(() => {
    localStorage.clear();
    fixtures.sessions = [RUNNING_SESSION];
  });

  /**
   * B5/C8 (design round 2026-10): a Home row shows no always-visible icon
   * buttons on a fine pointer. It takes the dock's hover chrome — the snooze
   * control over the time slot, revealed on hover/focus, and the hover card
   * for details — and keeps the 44px Details + one action only where there
   * is no hover to reveal them with.
   */
  test('a fine pointer gets the hover chrome: no Details button, snooze behind hover', () => {
    renderHomeView({ continuation: null, onNavigate: vi.fn() });
    const recent = screen.getByRole('region', { name: 'Recent work' });
    const [row] = within(recent).getAllByTestId('inbox-row');
    expect(row.className).toContain('inbox-row--hover');
    expect(row.className).not.toContain('inbox-row--touch');
    expect(
      within(recent).queryByRole('button', {
        name: `Details for ${ITEM_TITLE}`,
      }),
    ).toBeNull();
    // The one row action is the snooze choice, in the hover slot.
    const snooze = within(recent).getByRole('button', {
      name: `Snooze ${ITEM_TITLE}`,
    });
    expect(snooze.getAttribute('aria-haspopup')).toBe('menu');
    expect(snooze.closest('.inbox-row__actions')).not.toBeNull();
  });

  test('a coarse pointer keeps the 44px touch chrome with Details and one action', () => {
    const media = window.matchMedia as unknown as ReturnType<typeof vi.fn>;
    media.mockImplementation((query: string) => ({
      matches: query === '(pointer: coarse)',
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
      media: query,
      onchange: null,
    }));
    try {
      renderHomeView({ continuation: null, onNavigate: vi.fn() });
      const recent = screen.getByRole('region', { name: 'Recent work' });
      const [row] = within(recent).getAllByTestId('inbox-row');
      expect(row.className).toContain('inbox-row--touch');
      expect(
        within(recent).getByRole('button', {
          name: `Details for ${ITEM_TITLE}`,
        }),
      ).toBeTruthy();
      expect(
        within(recent).getByRole('button', { name: `Snooze ${ITEM_TITLE}` }),
      ).toBeTruthy();
      expect(
        within(row)
          .queryAllByRole('button')
          .filter((button) => button.closest('.inbox-row__actions')),
      ).toHaveLength(2);
    } finally {
      media.mockImplementation(() => ({
        matches: false,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        addListener: vi.fn(),
        removeListener: vi.fn(),
        dispatchEvent: vi.fn(),
        media: '',
        onchange: null,
      }));
    }
  });

  test('snooze button opens the preset menu; selecting a preset moves the row to the snoozed shelf and persists the wake time', async () => {
    renderHomeView({ continuation: null, onNavigate: vi.fn() });
    const recent = screen.getByRole('region', { name: 'Recent work' });

    fireEvent.click(
      within(recent).getByRole('button', { name: `Snooze ${ITEM_TITLE}` }),
    );

    const menu = await screen.findByRole('menu', {
      name: `Snooze ${ITEM_TITLE}`,
    });
    const clickedAt = Date.now();
    fireEvent.click(within(menu).getByRole('menuitem', { name: '1 hour' }));

    // The row left the active lane for the snoozed shelf.
    expect(
      within(recent).queryByRole('button', { name: `Snooze ${ITEM_TITLE}` }),
    ).toBeNull();
    expect(
      within(recent).getByRole('button', { name: 'Snoozed · 1' }),
    ).toBeTruthy();

    // `lanes.snooze` really was called with this item's id and the "In 1
    // hour" preset's wake time — observed through the real store boundary
    // (localStorage), not a mock of the hook itself.
    const stored = JSON.parse(
      localStorage.getItem('station.activity.snoozed') ?? '{}',
    );
    expect(stored[RUNNING_SESSION.threadId]).toBeGreaterThan(clickedAt);
    expect(
      Math.abs(stored[RUNNING_SESSION.threadId] - (clickedAt + 60 * 60 * 1000)),
    ).toBeLessThan(5000);
  });

  describe('with fake timers', () => {
    const NOW = Date.parse('2026-07-28T15:00:00-06:00');

    beforeEach(() => {
      vi.useFakeTimers();
      vi.setSystemTime(NOW);
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    test('shelf expand + wake: a pre-snoozed item shows its wake time and returns to active when woken', () => {
      writeSnooze(RUNNING_SESSION.threadId, NOW + 60 * 60 * 1000, NOW);

      renderHomeView({ continuation: null, onNavigate: vi.fn() });
      const recent = screen.getByRole('region', { name: 'Recent work' });

      expect(within(recent).queryByText(ITEM_TITLE)).toBeNull();
      fireEvent.click(
        within(recent).getByRole('button', { name: 'Snoozed · 1' }),
      );
      expect(within(recent).getByText(ITEM_TITLE)).toBeTruthy();
      expect(within(recent).getByText(/Wakes in 1h/)).toBeTruthy();

      fireEvent.click(
        within(recent).getByRole('button', { name: `Wake ${ITEM_TITLE}` }),
      );
      expect(
        within(recent).queryByRole('button', { name: 'Snoozed · 1' }),
      ).toBeNull();
      expect(within(recent).getByText(ITEM_TITLE)).toBeTruthy();
    });

    test('settled-tail "Show more" reveals items beyond the first page', () => {
      fixtures.sessions = [];
      fixtures.tasks = Array.from({ length: 7 }, (_, index) => ({
        id: `task-${index + 1}`,
        projectId: 'station',
        title: `Completed ${index + 1}`,
        description: '',
        priority: 'normal',
        status: 'done',
        createdBy: 'user',
        createdAt: '2026-07-01T00:00:00Z',
        updatedAt: `2026-07-${String(20 - index).padStart(2, '0')}T00:00:00Z`,
      }));

      renderHomeView({ continuation: null, onNavigate: vi.fn() });

      // Advance past the linger window so every item settles.
      act(() => {
        vi.advanceTimersByTime(TERMINAL_LINGER_MS + 60_000);
      });

      const earlier = screen.getByRole('region', { name: 'Earlier' });
      for (let index = 1; index <= 5; index += 1) {
        expect(within(earlier).getByText(`Completed ${index}`)).toBeTruthy();
      }
      expect(within(earlier).queryByText('Completed 6')).toBeNull();
      expect(within(earlier).queryByText('Completed 7')).toBeNull();

      fireEvent.click(
        within(earlier).getByRole('button', { name: 'Show more' }),
      );

      for (let index = 1; index <= 7; index += 1) {
        expect(within(earlier).getByText(`Completed ${index}`)).toBeTruthy();
      }
      // One flat list, as on Activity (design round 2026-10, C2): the rows
      // span a week, and still the lane's only heading is "Earlier" — no
      // dated sub-headings — with the rows newest first.
      expect(
        within(earlier)
          .getAllByRole('heading')
          .map((heading) => heading.textContent),
      ).toEqual(['Earlier']);
      expect(
        within(earlier)
          .getAllByText(/^Completed \d$/)
          .map((title) => title.textContent),
      ).toEqual(
        Array.from({ length: 7 }, (_, index) => `Completed ${index + 1}`),
      );
    });

    test('a settled failed row still says Failed', () => {
      fixtures.sessions = [
        {
          threadId: 'settled-failed-thread',
          provider: 'codex',
          status: 'closed',
          lifecycleState: 'failed',
          displayTitle: 'Repair the settled failure',
          cwd: '/Users/me/dev/github/kontourai/station',
          createdAt: '2026-07-28T14:00:00Z',
          updatedAt: '2026-07-28T14:00:00Z',
          isLoaded: true,
          isPersisted: true,
          answerability: { answerable: true },
          eventCount: 1,
        },
      ];

      renderHomeView({ continuation: null, onNavigate: vi.fn() });
      act(() => {
        vi.advanceTimersByTime(TERMINAL_LINGER_MS + 60_000);
      });

      const earlier = screen.getByRole('region', { name: 'Earlier' });
      expect(
        within(earlier).getByText('Repair the settled failure'),
      ).toBeTruthy();
      expect(within(earlier).getByText('Failed')).toBeTruthy();
    });
  });
});

describe('HomeView remote-session read augmentation (station#1097)', () => {
  const REMOTE_SESSION = {
    threadId: 'remote-thread-1',
    provider: 'codex',
    status: 'ready',
    lifecycleState: 'running',
    hasActiveTurn: true,
    createdAt: '2026-07-28T14:00:00Z',
    updatedAt: '2026-07-28T14:00:00Z',
    isLoaded: true,
    isPersisted: true,
    answerability: { answerable: true },
    eventCount: 1,
  };
  const OTHER_REMOTE_SESSION = {
    threadId: 'remote-thread-2',
    provider: 'claude',
    status: 'ready',
    lifecycleState: 'completed',
    createdAt: '2026-07-27T14:00:00Z',
    updatedAt: '2026-07-27T14:00:00Z',
    isLoaded: true,
    isPersisted: true,
    answerability: { answerable: true },
    eventCount: 1,
  };

  beforeEach(() => {
    showSurface.mockClear();
    fixtures.sessions = [];
    fixtures.tasks = [];
    fixtures.chats = {};
    fixtures.remoteSessionsResult = undefined;
  });

  // a two-station fixture (local + two remote environments) shows a
  // merged list with a provenance badge, through the real component render
  // (mocked SDK data, real buildHomeWorkItems/HomeView pipeline).
  test('AC1: merges sessions from two connected remote environments into the list with environment badges', () => {
    fixtures.sessions = [
      {
        threadId: 'local-thread',
        provider: 'codex',
        status: 'ready',
        lifecycleState: 'running',
        hasActiveTurn: true,
        createdAt: '2026-07-28T13:00:00Z',
        updatedAt: '2026-07-28T13:00:00Z',
        isLoaded: true,
        isPersisted: true,
        answerability: { answerable: true },
        eventCount: 1,
      },
    ];
    fixtures.remoteSessionsResult = {
      environments: [
        {
          environmentId: 'env-a',
          environmentName: 'Brian media',
          sessions: [REMOTE_SESSION],
        },
        {
          environmentId: 'env-b',
          environmentName: 'Office box',
          sessions: [OTHER_REMOTE_SESSION],
        },
      ],
      unavailable: [],
    };

    const onNavigate = vi.fn();
    renderHomeView({ continuation: null, onNavigate });
    const recent = screen.getByRole('region', { name: 'Recent work' });

    expect(within(recent).getByText('Brian media')).toBeTruthy();
    expect(within(recent).getByText('Office box')).toBeTruthy();
    // The local session's own row must still render, unmarked by any
    // machine: exactly two rows carry one.
    expect(within(recent).getAllByTestId('inbox-row')).toHaveLength(3);
    expect(
      recent.querySelectorAll(
        '.inbox-row__chip--remote, .inbox-row__slim-remote',
      ),
    ).toHaveLength(2);

    // archive#1097: REMOTE_SESSION (env-a, "Brian
    // media") is the single most-recent item across every environment here
    // (14:00 vs. the local session's 13:00 and OTHER_REMOTE_SESSION's prior
    // day) — exactly the case that silently no-opped before the fix. The
    // primary CTA must skip past it to the most-recent item this Station can
    // actually continue: the local session.
    const continueButton = screen.getByRole('button', {
      name: /^Continue/,
    });
    expect(continueButton.textContent).toContain(CODEX_SESSION_TITLE);
    fireEvent.click(continueButton);
    expect(showSurface).toHaveBeenCalledWith('activity', {
      session: 'local-thread',
    });
  });

  test("AC1: clicking a remote-session card does not navigate — it's a read-only card", () => {
    fixtures.remoteSessionsResult = {
      environments: [
        {
          environmentId: 'env-a',
          environmentName: 'Brian media',
          sessions: [REMOTE_SESSION],
        },
      ],
      unavailable: [],
    };
    const onNavigate = vi.fn();
    const focus = vi.fn();
    const unregister = openChatsStore.registerNavigation({
      focus,
      openCollection: vi.fn(),
    });
    renderHomeView({ continuation: null, onNavigate });
    const recent = screen.getByRole('region', { name: 'Recent work' });

    fireEvent.click(within(recent).getByText(CODEX_SESSION_TITLE));
    // Local cards open through Activity or a chat focus, never onNavigate,
    // so every open channel has to stay silent for the read-only card.
    expect(onNavigate).not.toHaveBeenCalled();
    expect(showSurface).not.toHaveBeenCalled();
    expect(focus).not.toHaveBeenCalled();
    unregister();
  });

  // archive#1097: when every visible item is a
  // read-only remote card (no local work at all), the primary CTA — which
  // can only ever continue a LOCAL item — must not render rather than
  // silently target a remote card that no-ops on click.
  test('AC1: the "Continue most recent work" CTA does not render when only remote sessions exist', () => {
    fixtures.remoteSessionsResult = {
      environments: [
        {
          environmentId: 'env-a',
          environmentName: 'Brian media',
          sessions: [REMOTE_SESSION],
        },
      ],
      unavailable: [],
    };
    renderHomeView({ continuation: null, onNavigate: vi.fn() });

    expect(screen.queryByRole('button', { name: /^Continue/ })).toBeNull();
  });

  // the local list renders synchronously (from `useOrchestrationSessionsQuery`
  // /`useTasksQuery` data) with the remote query still pending
  // (`useRemoteSessionsQuery` returning `data: undefined`, this suite's
  // default) — proving the remote read never blocks or delays it.
  test('AC2: the local list renders while the remote-session query is still pending', () => {
    fixtures.sessions = [
      {
        threadId: 'local-thread',
        provider: 'codex',
        status: 'ready',
        lifecycleState: 'running',
        hasActiveTurn: true,
        createdAt: '2026-07-28T13:00:00Z',
        updatedAt: '2026-07-28T13:00:00Z',
        isLoaded: true,
        isPersisted: true,
        answerability: { answerable: true },
        eventCount: 1,
      },
    ];
    fixtures.remoteSessionsResult = undefined; // still pending

    renderHomeView({ continuation: null, onNavigate: vi.fn() });
    const recent = screen.getByRole('region', { name: 'Recent work' });

    expect(within(recent).getByText(CODEX_SESSION_TITLE)).toBeTruthy();
    expect(
      screen.queryByRole('status', { name: 'Loading recent work' }),
    ).toBeNull();
  });

  // a remote fetch failure (a connected environment the server could
  // not reach in time) still never blocks the local list, and degrades to
  // an unobtrusive note rather than an error state.
  test('AC2/R3: an unreachable connected environment shows an unobtrusive note beside a normally-rendered local list', () => {
    fixtures.sessions = [
      {
        threadId: 'local-thread',
        provider: 'codex',
        status: 'ready',
        lifecycleState: 'running',
        hasActiveTurn: true,
        createdAt: '2026-07-28T13:00:00Z',
        updatedAt: '2026-07-28T13:00:00Z',
        isLoaded: true,
        isPersisted: true,
        answerability: { answerable: true },
        eventCount: 1,
      },
    ];
    fixtures.remoteSessionsResult = {
      environments: [],
      unavailable: [{ environmentId: 'env-a', environmentName: 'Brian media' }],
    };

    renderHomeView({ continuation: null, onNavigate: vi.fn() });
    const recent = screen.getByRole('region', { name: 'Recent work' });

    expect(within(recent).getByText(CODEX_SESSION_TITLE)).toBeTruthy();
    expect(screen.queryByRole('alert')).toBeNull();
    expect(
      within(recent).getByText(/Brian media is unavailable right now/),
    ).toBeTruthy();
  });

  test('shows an actionable pairing note when a connected SSH tunnel lacks a usable peer bearer', () => {
    fixtures.remoteSessionsResult = {
      environments: [],
      unavailable: [],
      authenticationRequired: [
        {
          environmentId: 'env-auth',
          environmentName: 'Brian media',
          action: 'provision_peer_credential',
        },
      ],
    };

    renderHomeView({ continuation: null, onNavigate: vi.fn() });

    expect(
      screen.getByText(/Brian media requires a peer credential/i),
    ).toBeTruthy();
    expect(
      screen.getByText(/Add or replace its pairing credential/i),
    ).toBeTruthy();
  });

  // the local-first invariant — omitting/defaulting remote data
  // (this suite's baseline `remoteSessionsResult: undefined`, exercised
  // throughout the rest of this file's existing suite) never introduces any
  // remote-only markup.
  test('AC3: no remote-session markup appears when no remote environments are connected', () => {
    fixtures.sessions = [
      {
        threadId: 'local-thread',
        provider: 'codex',
        status: 'ready',
        lifecycleState: 'running',
        hasActiveTurn: true,
        createdAt: '2026-07-28T13:00:00Z',
        updatedAt: '2026-07-28T13:00:00Z',
        isLoaded: true,
        isPersisted: true,
        answerability: { answerable: true },
        eventCount: 1,
      },
    ];
    fixtures.remoteSessionsResult = { environments: [], unavailable: [] };

    renderHomeView({ continuation: null, onNavigate: vi.fn() });

    expect(
      document.querySelector(
        '.inbox-row__chip--remote, .inbox-row__slim-remote',
      ),
    ).toBeNull();
    expect(document.querySelector('.home-view__remote-note')).toBeNull();
  });
});

describe('Home project data follows the host authority (#481 slice A)', () => {
  test('a colliding slug resolves to the ACTIVE authority project after a switch, and to nothing without one', async () => {
    const { useHomeViewModel } = await import('../views/home/useHomeViewModel');
    fixtures.projectsByAuthority = {
      'authority-a': [{ id: 'home-a-id', slug: 'station', name: 'Home A' }],
      'authority-b': [{ id: 'home-b-id', slug: 'station', name: 'Home B' }],
    };
    authorityRef.current = {
      apiBase: 'http://station.test',
      authorityKey: 'authority-a',
      isCurrent: () => true,
    };
    // The model reads the query cache for a row's project layouts (U1).
    const queryClient = new QueryClient();
    const { result, rerender } = renderHook(() => useHomeViewModel(vi.fn()), {
      wrapper: ({ children }) => (
        <QueryClientProvider client={queryClient}>
          {children}
        </QueryClientProvider>
      ),
    });
    expect(result.current.projects).toEqual([
      { id: 'home-a-id', slug: 'station', name: 'Home A' },
    ]);

    authorityRef.current = {
      apiBase: 'http://station.test',
      authorityKey: 'authority-b',
      isCurrent: () => true,
    };
    rerender();
    await waitFor(() => {
      expect(result.current.projects).toEqual([
        { id: 'home-b-id', slug: 'station', name: 'Home B' },
      ]);
    });

    // Missing authority: fail closed. No ambient data from either home.
    authorityRef.current = undefined;
    rerender();
    await waitFor(() => {
      expect(result.current.projects).toEqual([]);
    });
  });
});
