/**
 * @vitest-environment jsdom
 */

/**
 * The Activity list (lane `activity-list`): state lanes with the dated
 * history stream, the always-present top-level "New task", the row's one
 * "⋯" menu (Stop… behind a confirmation, Open in chat), and filters that
 * compose with search. Rendered through the real `SessionsView`,
 * `SplitPaneLayout`, lane model, `DelegationLauncher` and `ConfirmModal`;
 * only the network seam (`@kontourai/station-sdk`) is replaced.
 */

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
import { NavigationProvider } from '../../../contexts/NavigationContext';
import { openChatsStore } from '../../../contexts/open-chats-store';
import {
  SESSION_LANE_LABELS,
  type SessionLaneId,
} from '../../sessions/sessions-lane-model';

const interruptTurn = vi.fn();
const focusSpy = vi.spyOn(openChatsStore, 'focus').mockImplementation(() => {});
const delegateTask = vi.fn();
const refetchSessions = vi.fn().mockResolvedValue(undefined);
const useLiveActivityQuery = vi.hoisted(() =>
  vi.fn(() => ({ data: undefined })),
);
// The mocked list payload. Most tests hand-build loose fixtures; the
// cross-surface block below feeds typed summaries, since it also passes them
// to `buildOrchestrationItems` / `buildWorkFacts` directly.
let sessions: Array<Record<string, unknown> | OrchestrationSessionSummary> = [];
// The Project list every accent is allocated over (`useProjectAccents`).
let projectList: ProjectMetadata[] = [];

// Home's start composer reads the server through React Query; this suite
// compares the work surfaces, so it stands in as the bare form.
vi.mock('../../../components/home/HomeStartComposer', () => ({
  HomeStartComposer: () => <form aria-label="Start work" />,
}));
vi.mock('../../../contexts/useShowSurface', () => ({
  useShowSurface: () => vi.fn(),
  useShowSurfacePage: () => vi.fn(),
}));
// Activity no longer mounts the host-wide collaborator roster (the sidebar
// footer's presence tray shows it). Any live-activity read from this surface
// would be that roster coming back.
vi.mock('@kontourai/station-sdk/live-activity', () => ({
  useLiveActivityQuery,
}));
vi.mock('../../../contexts/ApiBaseContext', () => ({
  useApiBase: () => ({ apiBase: 'http://station.test' }),
  useHostRequestAuthorityScope: () => null,
}));
vi.mock('@kontourai/station-sdk/action-operations', () => ({
  useActionOperationsQuery: () => ({
    data: { items: [] },
    isLoading: false,
    isFetching: false,
    error: null,
  }),
  useCancelActionOperationMutation: () => ({ mutate: vi.fn() }),
}));

vi.mock('@kontourai/station-sdk', async (importOriginal) => {
  const real = await importOriginal<typeof import('@kontourai/station-sdk')>();
  // The real module underneath (constants and pure helpers the imported
  // tree reads at load); every hook this list and the launcher CALL is
  // replaced below, so no request leaves the test.
  return {
    ...real,
    useAgentsQuery: () => ({ data: [], isLoading: false }),
    useProjectsQuery: () => ({
      data: projectList,
      isLoading: false,
      isSuccess: true,
      isError: false,
    }),
    useOrchestrationSessionsQuery: () => ({
      data: sessions,
      isLoading: false,
      error: null,
      refetch: refetchSessions,
    }),
    usePullRequestContextQuery: () => ({ data: { available: false } }),
    usePullRequestsQuery: () => ({ data: undefined }),
    usePullRequestMergeabilityQuery: () => ({ data: undefined }),
    useProjectQuery: () => ({
      data: undefined,
      isSuccess: false,
      isError: false,
      refetch: vi.fn(),
    }),
    useProjectIdentityQuery: () => ({
      data: undefined,
      isSuccess: false,
      isError: false,
      error: null,
      refetch: vi.fn(),
    }),
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
        ],
      },
      error: null,
      isFetching: false,
      refetch: vi.fn(),
    }),
    useSshEnvironmentsQuery: () => ({ data: [] }),
    useDelegateOrchestrationTaskMutation: () => ({
      mutateAsync: delegateTask,
      reset: vi.fn(),
      isPending: false,
      error: null,
    }),
    interruptOrchestrationTurn: (input: unknown) => interruptTurn(input),
    dispatchOrchestrationCommandWithReceipt: vi.fn(),
  };
});

import { agentId } from '@kontourai/station-contracts/agent-identity';
import type { OrchestrationSessionSummary } from '@kontourai/station-sdk';
import { type ComponentProps, createRef } from 'react';
import { renderWithIsolatedConnections } from '../../../__tests__/renderWithIsolatedConnections';
import { ChatDockInboxPanel } from '../../../components/chat-dock/ChatDockInboxPanel';
import { MobileTaskSwitcher } from '../../../components/chat-dock/MobileTaskSwitcher';
import type { ProjectMetadata } from '../../../contexts/ProjectsContext';
import { useGitLocationByThreadId } from '../../../hooks/useGitLocationByThreadId';
import { useProjectAccents } from '../../../hooks/useProjectAccents';
import { HomeSurface } from '../../home/HomeSurface';
import { buildOrchestrationItems } from '../../home/home-view-model';
import { buildWorkFacts } from '../../home/work-facts';
import { SessionsView } from '../../SessionsView';

// A fixed local "now" so row times do not depend on the hour the suite
// runs at. Only `Date` is faked; timers stay real for waitFor.
const NOW = new Date(2026, 8, 29, 15, 0, 0).getTime();
const minutesAgo = (minutes: number) =>
  new Date(NOW - minutes * 60_000).toISOString();
const daysAgo = (days: number) => minutesAgo(days * 24 * 60);

function session(
  threadId: string,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    provider: 'claude',
    threadId,
    status: 'idle',
    lifecycleState: 'completed',
    hasActiveTurn: false,
    model: 'claude-sonnet',
    answerability: { answerable: true },
    isLoaded: true,
    isPersisted: true,
    eventCount: 3,
    // Recency is max(updatedAt, lastEventAt, createdAt): an older
    // `updatedAt` override must bring `createdAt` with it.
    createdAt: overrides.updatedAt ?? minutesAgo(3),
    updatedAt: minutesAgo(3),
    displayTitle: threadId,
    ...overrides,
  };
}

const runningChat = () =>
  session('Refactor the parser', {
    lifecycleState: 'running',
    hasActiveTurn: true,
    projectSlug: 'station',
    assignedAgentSlug: 'reviewer',
    conversationId: 'conv-parser',
    turnOrigin: {
      latest: {
        actor: { kind: 'operator' },
        reported: { surface: 'cli', build: null },
      },
      hasOtherOrigins: false,
    },
    conversationActivity: {
      conversationId: 'conv-parser',
      asOfSequence: 4,
      openTurn: {
        turnId: 'turn-1',
        threadId: 'Refactor the parser',
        startedAt: minutesAgo(3),
      },
      runningTools: [
        { name: 'Bash', callId: 'call-1', startedAt: minutesAgo(1) },
      ],
    },
  });

function renderView() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <NavigationProvider>
        <SessionsView apiBase="http://test.local" />
      </NavigationProvider>
    </QueryClientProvider>,
  );
}

function rowNames(container: HTMLElement): string[] {
  return Array.from(
    container.querySelectorAll('.split-pane__list .split-pane__item-name'),
  ).map((name) => name.textContent?.trim() ?? '');
}

function sectionHeadings(container: HTMLElement): string[] {
  return Array.from(
    container.querySelectorAll('.split-pane__list .split-pane__section-header'),
  ).map((heading) => heading.textContent ?? '');
}

function openRowMenu(rowTitle: string): HTMLElement {
  const row = screen.getByRole('button', { name: new RegExp(`^${rowTitle}`) });
  const trigger = within(
    row.closest('.split-pane__item-row') as HTMLElement,
  ).getByRole('button', { name: 'More actions' });
  fireEvent.click(trigger);
  return screen.getByRole('menu', { name: `Actions for ${rowTitle}` });
}

describe('Activity list', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
    window.localStorage.clear();
    window.history.replaceState(null, '', '/');
    interruptTurn.mockReset();
    interruptTurn.mockResolvedValue(undefined);
    delegateTask.mockReset();
    delegateTask.mockResolvedValue({
      taskId: 'task:new',
      sessionId: 'thread-new',
      status: 'dispatched',
      environment: {
        id: 'env-current',
        name: 'Current environment',
        kind: 'current',
      },
      target: { kind: 'agent-app', id: 'codex' },
      resumable: true,
    });
    refetchSessions.mockClear();
    useLiveActivityQuery.mockClear();
    focusSpy.mockClear();
    vi.stubGlobal('matchMedia', () => ({
      addEventListener: vi.fn(),
      matches: false,
      removeEventListener: vi.fn(),
    }));
    sessions = [];
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  test('a failure whose session is still loaded shows its reason before the server attributes it', () => {
    // The shape the read model returns for a fresh failure: the session is
    // still loaded (`status: 'error'`), so no `terminalAttribution` yet; the
    // reason is in the fields the detail's failure text already folds.
    sessions = [
      session('Fresh failure', {
        status: 'error',
        lifecycleState: 'failed',
        updatedAt: minutesAgo(1),
        lastRuntimeErrorMessage:
          'The model provider returned an error (HTTP 500).',
        blockedReason: 'The model provider returned an error (HTTP 500).',
      }),
    ];
    renderView();
    const row = screen.getByRole('button', { name: /^Fresh failure/ });
    expect(
      row.querySelector('[data-testid="session-member-terminal-attribution"]')
        ?.textContent,
    ).toBe('The model provider returned an error (HTTP 500).');
  });

  test('renders the state lane headings, live lanes first, and names the history lane Earlier like every other surface', () => {
    sessions = [
      session('Answer my question', { lifecycleState: 'needs_input' }),
      runningChat(),
      session('Fix the flaky test', {
        lifecycleState: 'failed',
        updatedAt: minutesAgo(5),
        terminalAttribution: {
          kind: 'runtime_error',
          detail: 'The model provider returned an error (HTTP 500).',
        },
      }),
      session('Morning cleanup', { updatedAt: minutesAgo(240) }),
      session('Yesterday review', { updatedAt: daysAgo(1) }),
      session('Tuesday notes', { updatedAt: daysAgo(4) }),
      session('Last month', { updatedAt: daysAgo(40) }),
    ];
    const { container } = renderView();
    const label = (lane: SessionLaneId) => SESSION_LANE_LABELS[lane];

    expect(sectionHeadings(container)).toEqual([
      `${label('needsYou')} · 1`,
      `${label('running')} · 1`,
      `${label('recentlyFinished')} · 1`,
      // One lane, one name (design round 2026-10, C2): not "Earlier today" /
      // "Yesterday" / "This week" / "Older" here and "Earlier" on Home and in
      // the dock. The four history rows sit under it, newest first.
      'Earlier · 4',
    ]);
    expect(rowNames(container).slice(-4)).toEqual([
      'Morning cleanup',
      'Yesterday review',
      'Tuesday notes',
      'Last month',
    ]);
    // Failed work sits in its lane with its reason, never among the clean
    // completions without a word.
    const failedRow = screen.getByRole('button', {
      name: /^Fix the flaky test/,
    });
    expect(failedRow.textContent).toContain('Failed');
    expect(failedRow.textContent).toContain(
      'The model provider returned an error (HTTP 500).',
    );
    // No By task / By app axis, and none of the chrome it replaced.
    expect(screen.queryByRole('tab')).toBeNull();
    expect(screen.queryByText(/Delegated\/background work/)).toBeNull();
    expect(screen.queryByTestId('delegated-task-coordinator')).toBeNull();
    expect(screen.queryByTestId('delegated-task-starter')).toBeNull();
    expect(screen.queryByText('Only you are connected')).toBeNull();
  });

  test('a running row says how long, which tool, where it runs and where it started', () => {
    sessions = [runningChat()];
    renderView();
    const row = screen.getByRole('button', { name: /^Refactor the parser/ });
    const meta = within(row).getByTestId('activity-row-meta');
    // The status ladder's line — the same words the dock row prints for
    // this session: the word, the tool, the turn's elapsed time.
    expect(within(meta).getByTestId('activity-row-state').textContent).toBe(
      'Running · Bash · 3m',
    );
    // The tool is what it is doing, not how it ended: a running row carries
    // no terminal attribution.
    expect(
      meta.querySelector('[data-testid="session-member-terminal-attribution"]'),
    ).toBeNull();
    expect(meta.querySelector('[data-segment="project"]')?.textContent).toBe(
      'station',
    );
    expect(meta.querySelector('[data-segment="origin"]')?.textContent).toBe(
      'CLI',
    );
    // The time is on line 1, outside the row button, and still in the row's
    // own text for assistive tech.
    const time = row
      .closest('.split-pane__item-row')
      ?.querySelector('.activity-row__time');
    expect(time?.textContent).toBe('3m');
    expect(meta.textContent).toContain(', 3m');
  });

  test('New task opens a TOP-LEVEL launcher even when delegated work exists', async () => {
    sessions = [
      session('Plan the release', {
        lifecycleState: 'running',
        hasActiveTurn: true,
      }),
      session('Check the migration', {
        delegation: {
          taskId: 'task:check-migration',
          parentTaskId: 'Plan the release',
          targetId: 'codex',
          targetKind: 'agent-app',
        },
      }),
    ];
    renderView();

    fireEvent.click(screen.getByRole('button', { name: 'New task' }));
    const dialog = screen.getByRole('dialog', { name: 'Delegate a task' });
    expect(within(dialog).queryByText('Child worker of')).toBeNull();

    fireEvent.change(within(dialog).getByLabelText('Task'), {
      target: { value: 'Write the changelog' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Delegate' }));
    await waitFor(() => expect(delegateTask).toHaveBeenCalledTimes(1));
    const call = delegateTask.mock.calls[0][0] as {
      input: Record<string, unknown>;
    };
    expect(call.input.prompt).toBe('Write the changelog');
    expect(call.input).not.toHaveProperty('parentTaskId');
  });

  test('New task is offered on an empty Activity too', () => {
    renderView();
    expect(screen.getByText('Nothing has run yet')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'New task' }));
    expect(
      screen.getByRole('dialog', { name: 'Delegate a task' }),
    ).toBeTruthy();
  });

  test('Stop… asks for confirmation before interrupting, and Cancel stops nothing', async () => {
    sessions = [runningChat()];
    renderView();

    fireEvent.click(
      within(openRowMenu('Refactor the parser')).getByRole('menuitem', {
        name: 'Stop…',
      }),
    );
    const confirm = screen.getByRole('alertdialog', {
      name: 'Stop this turn?',
    });
    expect(interruptTurn).not.toHaveBeenCalled();
    fireEvent.click(within(confirm).getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(interruptTurn).not.toHaveBeenCalled();

    fireEvent.click(
      within(openRowMenu('Refactor the parser')).getByRole('menuitem', {
        name: 'Stop…',
      }),
    );
    fireEvent.click(
      within(screen.getByRole('alertdialog')).getByRole('button', {
        name: 'Stop',
      }),
    );
    await waitFor(() =>
      expect(interruptTurn).toHaveBeenCalledWith({
        apiBase: 'http://test.local',
        threadId: 'Refactor the parser',
      }),
    );
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
  });

  test('the row menu offers Stop… only for a running turn, and evidence only for ended work', () => {
    sessions = [
      runningChat(),
      session('Finished work', { lifecycleState: 'completed' }),
    ];
    renderView();

    const running = openRowMenu('Refactor the parser');
    expect(
      within(running)
        .getAllByRole('menuitem')
        .map((item) => item.textContent),
    ).toEqual([
      'Open in chat',
      'Filter to this project',
      'Copy session ID',
      'Stop…',
    ]);
    fireEvent.keyDown(running, { key: 'Escape' });

    const finished = openRowMenu('Finished work');
    expect(
      within(finished)
        .getAllByRole('menuitem')
        .map((item) => item.textContent),
      // No agent to reopen it with: Station cannot rehydrate it into a chat,
      // so the menu does not offer to.
    ).toEqual(['Show details & evidence', 'Copy session ID']);
  });

  test('Open in chat reopens the conversation through the shared open policy', () => {
    sessions = [runningChat()];
    renderView();
    fireEvent.click(
      within(openRowMenu('Refactor the parser')).getByRole('menuitem', {
        name: 'Open in chat',
      }),
    );
    expect(focusSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        conversationId: 'conv-parser',
        agentSlug: 'reviewer',
        threadId: 'Refactor the parser',
        projectSlug: 'station',
      }),
    );
  });

  test('a paired Station record offers neither Open in chat, Delegate subtask nor Stop', () => {
    sessions = [
      session('Peer checks', {
        lifecycleState: 'running',
        hasActiveTurn: true,
        assignedAgentSlug: 'reviewer',
        delegation: {
          taskId: 'task:peer',
          environmentKind: 'peer',
          environmentId: 'env-peer',
        },
      }),
    ];
    renderView();
    const labels = within(openRowMenu('Peer checks'))
      .getAllByRole('menuitem')
      .map((item) => item.textContent);
    expect(labels).toEqual(['Copy session ID']);
  });

  test('Delegate subtask… opens the launcher as a CHILD of that delegated row', async () => {
    sessions = [
      session('Check the migration', {
        assignedAgentSlug: 'reviewer',
        delegation: {
          taskId: 'task:check-migration',
          targetId: 'codex',
          targetKind: 'agent-app',
        },
      }),
    ];
    renderView();
    fireEvent.click(
      within(openRowMenu('Check the migration')).getByRole('menuitem', {
        name: 'Delegate subtask…',
      }),
    );
    const dialog = screen.getByRole('dialog', { name: 'Delegate a task' });
    expect(within(dialog).getByText('Child worker of')).toBeTruthy();
    expect(within(dialog).getByText('Check the migration')).toBeTruthy();
    fireEvent.change(within(dialog).getByLabelText('Task'), {
      target: { value: 'Split the migration' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Delegate' }));
    await waitFor(() => expect(delegateTask).toHaveBeenCalledTimes(1));
    expect(
      (delegateTask.mock.calls[0][0] as { input: Record<string, unknown> })
        .input.parentTaskId,
    ).toBe('task:check-migration');
  });

  test('never reads the live-activity roster', () => {
    sessions = [runningChat()];
    renderView();
    expect(useLiveActivityQuery).not.toHaveBeenCalled();
  });

  test('filters compose with each other and with search, show as removable chips, and reset together', () => {
    sessions = [
      session('Station chat', { projectSlug: 'station' }),
      session('Station task', {
        projectSlug: 'station',
        delegation: { taskId: 'task:station', projectSlug: 'station' },
      }),
      session('Beacon task', {
        projectSlug: 'beacon',
        delegation: { taskId: 'task:beacon', projectSlug: 'beacon' },
      }),
      session('Station deploy task', {
        projectSlug: 'station',
        delegation: { taskId: 'task:deploy', projectSlug: 'station' },
      }),
    ];
    const { container } = renderView();
    const rowNames = () =>
      Array.from(container.querySelectorAll('.split-pane__item-name-text')).map(
        (node) => node.textContent,
      );

    fireEvent.change(screen.getByLabelText('Kind'), {
      target: { value: 'tasks' },
    });
    expect(rowNames().sort()).toEqual([
      'Beacon task',
      'Station deploy task',
      'Station task',
    ]);
    const project = screen.getByLabelText('Project') as HTMLSelectElement;
    expect(
      Array.from(project.options).map((option) => option.textContent),
      // Faceted by Kind = Tasks: the station chat is not counted.
    ).toEqual(['All projects', 'beacon (1)', 'station (2)']);
    fireEvent.change(project, { target: { value: 'station' } });
    expect(rowNames().sort()).toEqual(['Station deploy task', 'Station task']);

    fireEvent.change(screen.getByPlaceholderText('Search activity…'), {
      target: { value: 'deploy' },
    });
    expect(rowNames()).toEqual(['Station deploy task']);

    const chips = screen.getByRole('group', { name: 'Active filters' });
    fireEvent.click(
      within(chips).getByRole('button', { name: 'Remove filter Kind: Tasks' }),
    );
    // Still project + search: the chat is in station but does not match.
    expect(rowNames()).toEqual(['Station deploy task']);

    fireEvent.change(screen.getByPlaceholderText('Search activity…'), {
      target: { value: 'nothing like this' },
    });
    expect(rowNames()).toEqual([]);
    expect(
      screen.getByText('No activity matches “nothing like this”'),
    ).toBeTruthy();
    fireEvent.click(
      screen.getByRole('button', { name: 'Clear search and filters' }),
    );
    expect(rowNames()).toHaveLength(4);
    expect(
      (screen.getByPlaceholderText('Search activity…') as HTMLInputElement)
        .value,
    ).toBe('');
    expect((screen.getByLabelText('Project') as HTMLSelectElement).value).toBe(
      '',
    );
  });

  test('Started from groups by recorded origin with counts, and never guesses a missing one', () => {
    sessions = [
      runningChat(),
      session('Unrecorded chat'),
      session('Claude transcript', { controlMode: 'read-only-attached' }),
    ];
    renderView();
    const origin = screen.getByLabelText('Started from') as HTMLSelectElement;
    expect(
      Array.from(origin.options).map((option) => option.textContent),
    ).toEqual([
      'Anywhere',
      'Operator · CLI (1)',
      'Origin not recorded (1)',
      'Started in Claude Code (1)',
    ]);
    fireEvent.change(origin, { target: { value: 'Origin not recorded' } });
    expect(
      screen.getAllByRole('button', { name: /Unrecorded chat/ }).length,
    ).toBeGreaterThan(0);
    expect(
      screen.queryByRole('button', { name: /^Refactor the parser/ }),
    ).toBeNull();
  });

  test('a delegated run folds its subtasks under the root with a named board', () => {
    sessions = [
      session('Plan the release', {
        lifecycleState: 'running',
        hasActiveTurn: true,
      }),
      session('Check the migration', {
        lifecycleState: 'canceled',
        delegation: {
          taskId: 'task:check',
          parentTaskId: 'Plan the release',
        },
      }),
    ];
    renderView();
    expect(
      screen
        .getByRole('button', { name: '1 subtask' })
        .getAttribute('aria-expanded'),
    ).toBe('true');
    expect(
      screen.getByRole('button', { name: '1 stopped — focus first stopped' }),
    ).toBeTruthy();
    // The board summarises the subtasks the label counts — the running
    // ROOT is not one of them.
    expect(
      screen.queryByRole('button', { name: /running — focus first running/ }),
    ).toBeNull();
  });

  // #3386: a conversation started outside Station in a folder no project
  // claims is listed, and the Project filter can find it under No project.
  test('No project is a Project option that lists exactly the sessions with no project', () => {
    sessions = [
      session('Station chat', { projectSlug: 'station' }),
      session('Scratch transcript', { controlMode: 'read-only-attached' }),
      session('Direct chat'),
      // Ambiguous with a cut-short candidate list: it names projects, so it
      // is not under No project even though it matches every project filter.
      session('Shared folder transcript', {
        controlMode: 'read-only-attached',
        projectAttribution: {
          state: 'ambiguous',
          candidates: ['alpha', 'beta'],
          omittedCandidates: 1,
        },
      }),
    ];
    const { container } = renderView();
    const names = () =>
      Array.from(container.querySelectorAll('.split-pane__item-name-text'))
        .map((node) => node.textContent)
        .sort();
    const project = screen.getByRole('combobox', {
      name: /^Project/,
    }) as HTMLSelectElement;
    expect(
      Array.from(project.options).map((option) => option.textContent),
    ).toEqual([
      'All projects',
      'alpha (1)',
      'beta (1)',
      // The cut-short candidate list may hide station, so it counts there too.
      'station (2)',
      'No project (2)',
    ]);

    fireEvent.change(project, { target: { value: 'No project' } });
    expect(names()).toEqual(['Direct chat', 'Scratch transcript']);
    expect(
      screen.getByRole('button', { name: 'Remove filter Project: No project' }),
    ).toBeTruthy();
  });

  test('removing one filter chip leaves the others applied', () => {
    sessions = [
      session('Station task', {
        projectSlug: 'station',
        delegation: { taskId: 'task:station', projectSlug: 'station' },
      }),
      session('Station chat', { projectSlug: 'station' }),
      session('Beacon task', {
        projectSlug: 'beacon',
        delegation: { taskId: 'task:beacon', projectSlug: 'beacon' },
      }),
    ];
    const { container } = renderView();
    const rowNames = () =>
      Array.from(container.querySelectorAll('.split-pane__item-name-text'))
        .map((node) => node.textContent)
        .sort();
    fireEvent.change(screen.getByRole('combobox', { name: 'Kind' }), {
      target: { value: 'tasks' },
    });
    fireEvent.change(screen.getByRole('combobox', { name: /^Project/ }), {
      target: { value: 'station' },
    });
    expect(rowNames()).toEqual(['Station task']);
    fireEvent.click(
      screen.getByRole('button', { name: 'Remove filter Kind: Tasks' }),
    );
    // Project is still station: the beacon task stays out.
    expect(rowNames()).toEqual(['Station chat', 'Station task']);
    expect(
      (screen.getByRole('combobox', { name: /^Project/ }) as HTMLSelectElement)
        .value,
    ).toBe('station');
  });

  test('filter counts count the rows the headings count, faceted by the other filters', () => {
    const turn = (threadId: string, minutes: number) =>
      session(threadId, {
        displayTitle: 'Long chat',
        conversationId: 'conv-long',
        projectSlug: 'station',
        updatedAt: minutesAgo(minutes),
      });
    sessions = [
      // One conversation that ran three turn-sessions: ONE row.
      turn('conv-long', 9),
      turn('conv-long:session:2', 6),
      turn('conv-long:session:3', 4),
      session('Beacon task', {
        projectSlug: 'beacon',
        delegation: { taskId: 'task:beacon', projectSlug: 'beacon' },
      }),
    ];
    const { container } = renderView();
    const optionTexts = (name: RegExp) =>
      Array.from(
        (screen.getByRole('combobox', { name }) as HTMLSelectElement).options,
      ).map((option) => option.textContent);
    expect(optionTexts(/^Project/)).toEqual([
      'All projects',
      'beacon (1)',
      'station (1)',
    ]);
    expect(
      container.querySelectorAll('.split-pane__item-name-text'),
    ).toHaveLength(2);
    // Faceted: with Kind = Tasks, the station conversation is not a task.
    fireEvent.change(screen.getByRole('combobox', { name: 'Kind' }), {
      target: { value: 'tasks' },
    });
    expect(optionTexts(/^Project/)).toEqual(['All projects', 'beacon (1)']);
  });

  test('a conversation that ran turns from two origins counts under both, as choosing either shows it', () => {
    const origin = (surface: string) => ({
      latest: {
        actor: { kind: 'operator' },
        reported: { surface, build: null },
      },
      hasOtherOrigins: true,
    });
    sessions = [
      session('conv-mixed', {
        displayTitle: 'Mixed chat',
        conversationId: 'conv-mixed',
        updatedAt: minutesAgo(9),
        turnOrigin: origin('cli'),
      }),
      session('conv-mixed:session:2', {
        displayTitle: 'Mixed chat',
        conversationId: 'conv-mixed',
        updatedAt: minutesAgo(4),
        turnOrigin: origin('web'),
      }),
    ];
    const { container } = renderView();
    const startedFrom = screen.getByRole('combobox', {
      name: /^Started from/,
    }) as HTMLSelectElement;
    expect(Array.from(startedFrom.options).map((o) => o.textContent)).toEqual([
      'Anywhere',
      'Operator · CLI (1)',
      'Operator · Web browser (1)',
    ]);
    fireEvent.change(startedFrom, { target: { value: 'Operator · CLI' } });
    expect(
      container.querySelectorAll('.split-pane__item-name-text'),
    ).toHaveLength(1);
  });

  test('a run pulled into a higher lane by a subtask says so, and its board counts the subtasks', () => {
    sessions = [
      session('Plan the release', { lifecycleState: 'completed' }),
      session('Answer the reviewer', {
        lifecycleState: 'needs_input',
        delegation: { taskId: 'task:answer', parentTaskId: 'Plan the release' },
      }),
      session('Check the migration', {
        lifecycleState: 'completed',
        delegation: { taskId: 'task:check', parentTaskId: 'Plan the release' },
      }),
    ];
    const { container } = renderView();
    expect(sectionHeadings(container)).toEqual([
      `${SESSION_LANE_LABELS.needsYou} · 1`,
    ]);
    expect(
      screen.getByRole('button', {
        name: `2 subtasks · 1 ${SESSION_LANE_LABELS.needsYou.toLowerCase()}`,
      }),
    ).toBeTruthy();
    // Two subtasks on the board — the completed ROOT is not a third.
    expect(screen.getByRole('button', { name: /^1 done — / })).toBeTruthy();
    expect(
      screen.getByRole('button', { name: /^1 needs you — / }),
    ).toBeTruthy();
  });

  test('in a dock pane (no page frame) New task sits at the top of the list, not in the footer', () => {
    sessions = [runningChat()];
    const { container } = renderView();
    const button = screen.getByRole('button', { name: 'New task' });
    expect(button.closest('.split-pane__add')).toBeNull();
    const list = container.querySelector('.split-pane__list') as HTMLElement;
    expect(list.contains(button)).toBe(true);
    const firstHeading = list.querySelector('.split-pane__section-header');
    expect(
      button.compareDocumentPosition(firstHeading as Node) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });
});

/**
 * The same item, rendered by the real Home surface, the real dock hosts and
 * the real Activity list side by side, read at one instant. These are the
 * cross-surface claims: one duration (one format, one ticking clock) and one
 * group-heading format. Each surface is fed the same session the way its
 * host feeds it (Home and the dock from the shared item + facts derivation,
 * Activity from the session list).
 */
/** The dock's inbox as `ChatDock` feeds it: the shared row-fact hooks. */
function DockInboxHost(
  props: Omit<
    ComponentProps<typeof ChatDockInboxPanel>,
    'gitLocationByThreadId' | 'projectAccentBySlug'
  >,
) {
  return (
    <ChatDockInboxPanel
      {...props}
      gitLocationByThreadId={useGitLocationByThreadId()}
      projectAccentBySlug={useProjectAccents()}
    />
  );
}

/** The phone sheet as `ChatDock` feeds it. */
function SheetHost(
  props: Omit<
    ComponentProps<typeof MobileTaskSwitcher>,
    'gitLocationByThreadId' | 'projectAccentBySlug'
  >,
) {
  return (
    <MobileTaskSwitcher
      {...props}
      gitLocationByThreadId={useGitLocationByThreadId()}
      projectAccentBySlug={useProjectAccents()}
    />
  );
}

describe('Home, the dock and Activity agree on one item', () => {
  beforeEach(() => {
    window.localStorage.clear();
    window.history.replaceState(null, '', '/');
    vi.stubGlobal('matchMedia', () => ({
      addEventListener: vi.fn(),
      matches: false,
      removeEventListener: vi.fn(),
    }));
    summaries = [];
    projectList = [];
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  /** What this block's surfaces read, typed in full: the list mock, Home and
   *  the dock all receive these exact summaries. */
  let summaries: OrchestrationSessionSummary[] = [];

  function summary(
    threadId: string,
    overrides: Partial<OrchestrationSessionSummary> = {},
  ): OrchestrationSessionSummary {
    return {
      provider: 'claude',
      threadId,
      status: 'ready',
      controlMode: 'station-owned',
      lifecycleState: 'completed',
      hasActiveTurn: false,
      model: 'claude-sonnet',
      answerability: { answerable: true },
      isLoaded: true,
      isPersisted: true,
      eventCount: 3,
      createdAt: minutesAgo(3),
      updatedAt: minutesAgo(3),
      displayTitle: threadId,
      ...overrides,
    };
  }

  /** `runningChat()`, typed: one open turn started at `startedAt`. */
  function runningSummary(startedAt: string): OrchestrationSessionSummary {
    return summary('Refactor the parser', {
      lifecycleState: 'running',
      hasActiveTurn: true,
      projectSlug: 'station',
      assignedAgentSlug: agentId('reviewer'),
      conversationId: 'conv-parser',
      turnOrigin: {
        latest: {
          version: 1,
          actor: { kind: 'operator' },
          reported: { version: 1, surface: 'cli', build: null },
        },
        hasOtherOrigins: false,
      },
      conversationActivity: {
        conversationId: 'conv-parser',
        asOfSequence: 4,
        openTurn: {
          turnId: 'turn-1',
          threadId: 'Refactor the parser',
          startedAt,
        },
        runningTools: [
          { name: 'Bash', callId: 'call-1', startedAt: minutesAgo(1) },
        ],
      },
    });
  }

  function homeModel(items: ReturnType<typeof buildOrchestrationItems>) {
    return {
      projects: [],
      agents: [],
      defaultSelection: undefined,
      workItems: items,
      workFacts: buildWorkFacts({
        items,
        sessions: summaries,
      }),
      workLoading: false,
      workDegraded: false,
      workError: false,
      retryWork: vi.fn(),
      remoteUnavailable: [],
      remoteAuthenticationRequired: [],
      startReady: true,
      startIdentity: '',
      primaryWorkItem: undefined,
      continueWork: vi.fn(),
    } as unknown as Parameters<typeof HomeSurface>[0]['model'];
  }

  function surfaces() {
    sessions = summaries;
    const items = buildOrchestrationItems(summaries, []);
    const workFacts = buildWorkFacts({ items, sessions: summaries });
    const activity = renderView().container;
    const home = render(
      <HomeSurface
        model={homeModel(items)}
        continuation={null}
        onNavigate={vi.fn()}
      />,
    ).container;
    const dock = render(
      <DockInboxHost
        items={items}
        activeChatSessionId={null}
        openChatSessionIds={[]}
        onFocusChat={vi.fn()}
        onOpenConversation={vi.fn()}
        onOpenSession={vi.fn()}
        onCloseChat={vi.fn()}
        onOpenHistory={vi.fn()}
        workFacts={workFacts}
      />,
    ).container;
    const sheet = renderWithIsolatedConnections(
      <QueryClientProvider
        client={
          new QueryClient({ defaultOptions: { queries: { retry: false } } })
        }
      >
        <SheetHost
          open
          tasks={items}
          activeChatSessionId={null}
          visualViewportStyle={{}}
          triggerRef={createRef<HTMLButtonElement>()}
          onClose={vi.fn()}
          onFocusChat={vi.fn()}
          onOpenConversation={vi.fn()}
          onOpenSession={vi.fn()}
          onCloseChat={vi.fn()}
          workFacts={workFacts}
        />
      </QueryClientProvider>,
    ).baseElement.querySelector('.mobile-task-switcher__panel') as HTMLElement;
    return { activity, home, dock, sheet };
  }

  test('one running turn reads the same elapsed time on Home, in the dock and in Activity', () => {
    vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] });
    vi.setSystemTime(NOW);
    const startedAt = new Date(NOW - 5_000).toISOString();
    summaries = [runningSummary(startedAt)];
    const { activity, home, dock } = surfaces();
    const read = () => ({
      home: home.querySelector('.inbox-row__elapsed')?.textContent,
      dock: dock.querySelector('.inbox-row__elapsed')?.textContent,
      activity: activity
        .querySelector('[data-testid="activity-row-state"]')
        ?.textContent?.split(' · ')
        .at(-1),
    });
    expect(read()).toEqual({ home: '5s', dock: '5s', activity: '5s' });

    // 20 seconds on, inside Activity's 30-second list clock: a surface on a
    // clock of its own still says 5s here while the others say 25s.
    act(() => {
      vi.advanceTimersByTime(20_000);
    });
    expect(read()).toEqual({ home: '25s', dock: '25s', activity: '25s' });

    // Past the minute, the coarse vocabulary: minutes, no seconds.
    act(() => {
      vi.advanceTimersByTime(4 * 60_000);
    });
    expect(read()).toEqual({ home: '4m', dock: '4m', activity: '4m' });
  });

  test('a group heading reads "Needs you · 1" wherever a count shows, as visible text in the UI face', () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
    summaries = [
      summary('Answer my question', { lifecycleState: 'needs_input' }),
    ];
    const { activity, home, dock, sheet } = surfaces();
    const needsYouLabel = (root: HTMLElement) => {
      const labels = Array.from(
        root.querySelectorAll<HTMLElement>('.work-group-label'),
      ).filter((label) => label.textContent?.startsWith('Needs you'));
      expect(labels).toHaveLength(1);
      const [label] = labels;
      // A count is read with its label: nothing between it and the root
      // hides it from assistive technology.
      expect(label.closest('[aria-hidden="true"]')).toBeNull();
      return label.textContent;
    };
    expect(needsYouLabel(home)).toBe('Needs you · 1');
    expect(needsYouLabel(activity)).toBe('Needs you · 1');
    expect(needsYouLabel(sheet)).toBe('Needs you · 1');
    // The desktop dock shows no counts (its host's choice); the words are
    // still the shared label's.
    expect(needsYouLabel(dock)).toBe('Needs you');
    // No surface keeps a format of its own beside the shared one.
    for (const root of [home, activity, dock, sheet]) {
      expect(root.textContent).not.toMatch(/Needs you \(\d+\)/);
      expect(root.querySelector('.chat-dock-inbox__group-count')).toBeNull();
    }
  });

  test('a project wears one colour on Home, in the dock and in the sheet', () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
    // Three projects, so the accent is set-aware: `station` sorts last and
    // takes the third colour of the palette, not the first a one-project
    // allocation would give it.
    projectList = (['alpha', 'beta', 'station'] as const).map((slug) => ({
      id: `p-${slug}`,
      slug,
      name: slug,
      hasWorkingDirectory: true,
      layoutCount: 0,
      hasKnowledge: false,
    }));
    summaries = [runningSummary(minutesAgo(3))];
    const { home, dock, sheet } = surfaces();
    const swatch = (root: HTMLElement) => {
      const swatches = root.querySelectorAll<HTMLElement>(
        '.inbox-row__project-accent',
      );
      expect(swatches).toHaveLength(1);
      // Decorative: the project's name beside it is the identity.
      expect(swatches[0].getAttribute('aria-hidden')).toBe('true');
      return swatches[0].style.backgroundColor;
    };
    expect(swatch(home)).toBe('var(--event-tool-call)');
    expect(swatch(dock)).toBe(swatch(home));
    expect(swatch(sheet)).toBe(swatch(home));
  });
});
